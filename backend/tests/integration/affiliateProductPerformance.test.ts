/**
 * Integration tests: per-product affiliate performance
 * (getAffiliateProductPerformance() + GET
 * /api/customer/affiliates/overview/by-product). Seeds
 * affiliate_clicks/affiliate_commissions/products directly via SQL —
 * this is a pure read/aggregation surface, so it does not need to
 * exercise the full checkout/webhook pipeline the way
 * affiliateCommission.test.ts does for the write path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession as createCustomerSession } from '../../services/customer/sessionService';
import { getAffiliateProductPerformance } from '../../services/affiliateCommissionService';
import { cleanupTestProduct } from '../helpers';

beforeEach(async () => {
  // Same ordered cleanup as affiliateCommission.test.ts's own beforeEach —
  // this D1 instance's state persists across test files, so every
  // dependent of purchase_sessions/products/affiliates must be cleared
  // before the table itself, or the DELETE below fails on an FK from
  // unrelated leftover state.
  await env.DB.exec('DELETE FROM affiliate_commissions');
  await env.DB.exec('DELETE FROM affiliate_clicks');
  await env.DB.exec('DELETE FROM receipt_download_tokens');
  await env.DB.exec('DELETE FROM receipts');
  await env.DB.exec('DELETE FROM licenses');
  await env.DB.exec('DELETE FROM order_items');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM payment_transactions');
  await env.DB.exec('DELETE FROM review_reminder_attempts');
  await env.DB.exec('DELETE FROM purchase_followup_attempts');
  await env.DB.exec('DELETE FROM coupon_redemptions');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM coupons');
  await env.DB.exec('DELETE FROM affiliate_product_rates');
  await env.DB.exec('DELETE FROM affiliates');
  await env.DB.exec('DELETE FROM product_reviews');
  await cleanupTestProduct(env as any); // product_files, media_assets, products (FK-safe order)
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
});

async function seedAffiliate(email: string, code: string): Promise<{ affiliateId: number; cookieHeader: string }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });
  const insert = await env.DB.prepare(
    `INSERT INTO affiliates (customer_id, affiliate_code, status, default_commission_percent, data_classification) VALUES (?, ?, 'approved', 20, 'PRODUCTION')`
  )
    .bind(customerId, code)
    .run();
  return { affiliateId: Number(insert.meta.last_row_id), cookieHeader: `customer_session=${session.sessionToken}` };
}

async function seedProduct(slug: string, title: string): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES (?, ?, ?, 'investing', 'ebook', 'active', 3900, 'GHS', 'one-time', 'inclusive', 'en')`
  )
    .bind(`prod-${slug}`, slug, title)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedClick(affiliateId: number, productSlug: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO affiliate_clicks (affiliate_id, product_slug, landing_path, ip_hash, data_classification) VALUES (?, ?, '/', 'testhash', 'PRODUCTION')`
  )
    .bind(affiliateId, productSlug)
    .run();
}

let purchaseRefCounter = 0;
async function seedCommission(
  affiliateId: number,
  productId: number,
  productSlug: string,
  input: { grossPesewas?: number; commissionPesewas?: number; status?: string } = {}
): Promise<number> {
  purchaseRefCounter += 1;
  const reference = `RWL-TEST-PERF-${purchaseRefCounter}`;
  const sessionInsert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at)
     VALUES (?, ?, 'prod-x', ?, ?, 'GHS', 'verified', datetime('now', '+1 hour'))`
  )
    .bind(reference, productSlug, productSlug, input.grossPesewas ?? 3900)
    .run();
  const insert = await env.DB.prepare(
    `INSERT INTO affiliate_commissions (affiliate_id, purchase_session_id, product_id, gross_pesewas, commission_percent, commission_pesewas, status, data_classification)
     VALUES (?, ?, ?, ?, 20, ?, ?, 'PRODUCTION')`
  )
    .bind(affiliateId, Number(sessionInsert.meta.last_row_id), productId, input.grossPesewas ?? 3900, input.commissionPesewas ?? 780, input.status ?? 'pending')
    .run();
  return Number(insert.meta.last_row_id);
}

describe('getAffiliateProductPerformance(): aggregation', () => {
  it('groups clicks by product_slug and commissions by product_id, merged into one row per product', async () => {
    const { affiliateId } = await seedAffiliate('perf-group@example.com', 'RWLPERFGROUP');
    const productAId = await seedProduct('product-a', 'Product A');
    await seedProduct('product-b', 'Product B');

    await seedClick(affiliateId, 'product-a');
    await seedClick(affiliateId, 'product-a');
    await seedClick(affiliateId, 'product-a');
    await seedClick(affiliateId, 'product-b');
    await seedCommission(affiliateId, productAId, 'product-a');

    const result = await getAffiliateProductPerformance(env as any, affiliateId);
    const productA = result.find((p) => p.productSlug === 'product-a')!;
    const productB = result.find((p) => p.productSlug === 'product-b')!;

    expect(productA).toBeTruthy();
    expect(productA.productTitle).toBe('Product A');
    expect(productA.clicks).toBe(3);
    expect(productA.orders).toBe(1);
    expect(productA.revenuePesewas).toBe(3900);
    expect(productA.commissionPesewas).toBe(780);

    expect(productB).toBeTruthy();
    expect(productB.clicks).toBe(1);
    expect(productB.orders).toBe(0);
    expect(productB.revenuePesewas).toBe(0);
    expect(productB.commissionPesewas).toBe(0);
  });

  it('sums multiple clicks on the same product_slug into a single count', async () => {
    const { affiliateId } = await seedAffiliate('perf-clicksum@example.com', 'RWLPERFCLICKSUM');
    await seedProduct('product-c', 'Product C');
    await seedClick(affiliateId, 'product-c');
    await seedClick(affiliateId, 'product-c');
    await seedClick(affiliateId, 'product-c');
    await seedClick(affiliateId, 'product-c');

    const result = await getAffiliateProductPerformance(env as any, affiliateId);
    const productC = result.find((p) => p.productSlug === 'product-c')!;
    expect(productC.clicks).toBe(4);
  });

  it('excludes a general (non-product) click with a null product_slug from the breakdown entirely', async () => {
    const { affiliateId } = await seedAffiliate('perf-nullclick@example.com', 'RWLPERFNULLCLICK');
    await seedProduct('product-d', 'Product D');
    await seedClick(affiliateId, 'product-d');
    await seedClick(affiliateId, null); // homepage/general referral link

    const result = await getAffiliateProductPerformance(env as any, affiliateId);
    expect(result.length).toBe(1);
    expect(result[0].productSlug).toBe('product-d');
    expect(result[0].clicks).toBe(1);
  });

  it('excludes reversed commissions from orders, revenue, and commission — using the same rule as getAffiliateOverview()', async () => {
    const { affiliateId } = await seedAffiliate('perf-reversed@example.com', 'RWLPERFREVERSED');
    const productId = await seedProduct('product-e', 'Product E');
    await seedClick(affiliateId, 'product-e');
    await seedCommission(affiliateId, productId, 'product-e', { status: 'pending' });
    await seedCommission(affiliateId, productId, 'product-e', { status: 'reversed' });

    const result = await getAffiliateProductPerformance(env as any, affiliateId);
    const productE = result.find((p) => p.productSlug === 'product-e')!;
    expect(productE.orders).toBe(1); // only the non-reversed commission counts
    expect(productE.revenuePesewas).toBe(3900);
    expect(productE.commissionPesewas).toBe(780);
  });

  it('a product with orders but zero recorded clicks (e.g. a stale/renamed slug) is still reported, with clicks: 0, never a crash', async () => {
    const { affiliateId } = await seedAffiliate('perf-zeroclick@example.com', 'RWLPERFZEROCLICK');
    const productId = await seedProduct('product-f', 'Product F');
    await seedCommission(affiliateId, productId, 'product-f');

    const result = await getAffiliateProductPerformance(env as any, affiliateId);
    const productF = result.find((p) => p.productSlug === 'product-f')!;
    expect(productF.clicks).toBe(0);
    expect(productF.orders).toBe(1);
  });

  it('an affiliate with no clicks and no commissions gets an empty array, not an error', async () => {
    const { affiliateId } = await seedAffiliate('perf-empty@example.com', 'RWLPERFEMPTY');
    const result = await getAffiliateProductPerformance(env as any, affiliateId);
    expect(result).toEqual([]);
  });
});

describe('GET /api/customer/affiliates/overview/by-product: identity and isolation', () => {
  it("derives identity exclusively from the authenticated session — an affiliate's product performance never includes another affiliate's data", async () => {
    const a1 = await seedAffiliate('perf-iso-one@example.com', 'RWLPERFISOONE');
    const a2 = await seedAffiliate('perf-iso-two@example.com', 'RWLPERFISOTWO');
    const productId = await seedProduct('product-g', 'Product G');

    await seedClick(a2.affiliateId, 'product-g');
    await seedCommission(a2.affiliateId, productId, 'product-g');

    const res = await SELF.fetch('https://example.com/api/customer/affiliates/overview/by-product', { headers: { Cookie: a1.cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.products.length).toBe(0); // affiliate one sees none of affiliate two's clicks/commissions
  });

  it('an unapproved affiliate is blocked from the product-performance route, same as the existing overview route', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'perf-pending@example.com', false);
    const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });
    await env.DB.prepare(`INSERT INTO affiliates (customer_id, affiliate_code, status, default_commission_percent, data_classification) VALUES (?, 'RWLPERFPENDING', 'pending', 20, 'PRODUCTION')`)
      .bind(customerId)
      .run();

    const res = await SELF.fetch('https://example.com/api/customer/affiliates/overview/by-product', {
      headers: { Cookie: `customer_session=${session.sessionToken}` },
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('AFFILIATE_NOT_APPROVED');
  });

  it('an unauthenticated request is rejected', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/overview/by-product');
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_AUTHENTICATED');
  });

  it('the response never includes customer identity/PII fields', async () => {
    const { affiliateId, cookieHeader } = await seedAffiliate('perf-nopii@example.com', 'RWLPERFNOPII');
    const productId = await seedProduct('product-h', 'Product H');
    await seedClick(affiliateId, 'product-h');
    await seedCommission(affiliateId, productId, 'product-h');

    const res = await SELF.fetch('https://example.com/api/customer/affiliates/overview/by-product', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    const serialized = JSON.stringify(body.data.products);
    expect(serialized).not.toContain('perf-nopii@example.com');
    expect(serialized).not.toMatch(/email/i);
    expect(serialized).not.toMatch(/customer/i);
  });

  it('the existing /api/customer/affiliates/overview route is unaffected by the new product-performance route existing', async () => {
    const { affiliateId, cookieHeader } = await seedAffiliate('perf-overview-unaffected@example.com', 'RWLPERFOVERVIEW');
    const productId = await seedProduct('product-i', 'Product I');
    await seedClick(affiliateId, 'product-i');
    await seedClick(affiliateId, 'product-i');
    await seedCommission(affiliateId, productId, 'product-i');

    const res = await SELF.fetch('https://example.com/api/customer/affiliates/overview', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.clicks).toBe(2);
    expect(body.data.conversions).toBe(1);
    expect(body.data.revenuePesewas).toBe(3900);
    expect(body.data.earnedPesewas).toBe(780);
    expect(body.data.affiliateCode).toBe('RWLPERFOVERVIEW');
  });
});
