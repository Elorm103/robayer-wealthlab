/**
 * Integration tests: Financial Literacy Bundle — Revenue Engine Phase
 * 1-6. Exercises the real Worker fetch handler (SELF) for the bundle's
 * checkout path and its individual-book-page cross-sell markup, and
 * fulfilPurchase() directly for entitlement fan-out — matching this
 * codebase's established convention (checkout.test.ts, productBundles.test.ts)
 * of testing through the real HTTP/service layer, not a parallel mock.
 *
 * Per productBundles.test.ts's own documented reasoning, checkout
 * itself needs no bundle-specific test to prove correctness (a bundle
 * resolves through the exact same fetchCatalogProduct()/isPurchasable()
 * path as any product) — the checkout test below exists anyway, for
 * this specific real launch, to prove the price actually charged is
 * the bundle's own server-side sale price and nothing a client could
 * influence.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { queueInitializeResponse } from '../outboundMock';
import { setBundleItems } from '../../services/productService';
import { fulfilPurchase } from '../../services/fulfilmentService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');

const BOOK_A = 'starting-to-invest-with-gh100';
const BOOK_B = 'understanding-the-ghana-stock-exchange';
const BOOK_C = 'treasury-bills-made-simple';
const BUNDLE_SLUG = 'financial-literacy-bundle';

async function cleanupAll(): Promise<void> {
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM bundle_items');
  await env.DB.exec('DELETE FROM product_files');
  await env.DB.exec('DELETE FROM media_assets');
  await env.DB.exec('DELETE FROM products');
  await env.DB.exec('DELETE FROM admin_users');
}

async function seedAdmin(): Promise<number> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', 'super_admin', 1)`)
    .bind(`admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedBook(slug: string, title: string, pricePesewas: number): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES (?, ?, ?, 'investing', 'ebook', 'active', ?, 'GHS', 'one-time', 'inclusive', 'en')`
  )
    .bind(`prod-${slug}`, slug, title, pricePesewas)
    .run();
  const productId = Number(insert.meta.last_row_id);

  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES (?, ?, 'application/pdf', 1024, 'deadbeef', ?, ?, 'document', 'books', 'ready')`
  )
    .bind(`${slug}.pdf`, `${slug}.pdf`, `ebooks/${slug}.pdf`, `https://example.com/${slug}.pdf`)
    .run();
  const mediaId = Number(mediaInsert.meta.last_row_id);

  await env.DB.prepare(
    `INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status)
     VALUES (?, ?, ?, ?, 'PDF', 'published')`
  )
    .bind(productId, `asset-${slug}-v1`, mediaId, `${title} (PDF)`)
    .run();

  return productId;
}

async function seedBundleProduct(status: 'active' | 'draft'): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, sale_price_pesewas, sale_enabled, currency, pricing_model, tax_behavior, language, is_bundle)
     VALUES (?, ?, 'Robayer WealthLab Financial Literacy Bundle', 'investing', 'ebook', ?, 13997, 9999, 1, 'GHS', 'one-time', 'inclusive', 'en', 1)`
  )
    .bind(`prod-${BUNDLE_SLUG}`, BUNDLE_SLUG, status)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedFullCatalog(bundleStatus: 'active' | 'draft' = 'active'): Promise<{ bookAId: number; bundleId: number }> {
  const adminId = await seedAdmin();
  const bookAId = await seedBook(BOOK_A, 'Small Cedis, Big Wealth', 3900);
  const bookBId = await seedBook(BOOK_B, 'Understanding the Ghana Stock Exchange', 4999);
  const bookCId = await seedBook(BOOK_C, 'Treasury Bills Made Simple', 3999);
  const bundleId = await seedBundleProduct(bundleStatus);
  await setBundleItems(env as any, logger, adminId, bundleId, [{ itemProductId: bookAId }, { itemProductId: bookBId }, { itemProductId: bookCId }]);
  return { bookAId, bundleId };
}

beforeEach(cleanupAll);

describe('POST /api/checkout/sessions — bundle checkout', () => {
  it('charges exactly the bundle sale price, server-controlled, regardless of anything the client sends', async () => {
    await seedFullCatalog();

    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: BUNDLE_SLUG,
        termsAccepted: true,
        licenseAccepted: true,
        email: 'bundle-checkout-test@example.com',
        // Attempting to smuggle a different amount — must be ignored entirely; createCheckoutSession() never reads a client-supplied price field.
        amountPesewas: 1,
      }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const session = await env.DB.prepare('SELECT amount_pesewas AS amountPesewas, product_slug AS productSlug FROM purchase_sessions WHERE purchase_reference = ?')
      .bind(body.data.purchaseReference)
      .first<any>();
    expect(session.amountPesewas).toBe(9999); // the bundle's own server-side sale price, never the smuggled value
    expect(session.productSlug).toBe(BUNDLE_SLUG);
  });

  it('rejects checkout for the bundle while it is still in draft status', async () => {
    await seedFullCatalog('draft');

    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: BUNDLE_SLUG, termsAccepted: true, licenseAccepted: true, email: 'draft-bundle-test@example.com' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PRODUCT_NOT_ACTIVE');
  });

  it('the 3 individual books remain purchasable, unaffected by the bundle existing', async () => {
    await seedFullCatalog();

    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: BOOK_A, termsAccepted: true, licenseAccepted: true, email: 'single-book-test@example.com' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const session = await env.DB.prepare('SELECT amount_pesewas AS amountPesewas FROM purchase_sessions WHERE purchase_reference = ?')
      .bind(body.data.purchaseReference)
      .first<any>();
    expect(session.amountPesewas).toBe(3900); // Small Cedis, Big Wealth's own price, untouched by the bundle's existence
  });
});

describe('fulfilPurchase() — bundle entitlement fan-out, real launch shape', () => {
  it('grants 3 correctly-attributed deliveries for one bundle purchase', async () => {
    const { bundleId } = await seedFullCatalog();
    void bundleId;

    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
       VALUES ('RWL-2026-910001', ?, ?, 'Robayer WealthLab Financial Literacy Bundle', 9999, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'))`
    )
      .bind(BUNDLE_SLUG, 'prod-' + BUNDLE_SLUG)
      .run();
    const purchaseSessionId = Number(insert.meta.last_row_id);

    await fulfilPurchase(env as any, logger, {
      purchaseSessionId,
      purchaseReference: 'RWL-2026-910001',
      productSlug: BUNDLE_SLUG,
      customerEmail: 'bundle-entitlement-test@example.com',
      amountPesewas: 9999,
      currency: 'GHS',
      customerId: null,
      isNewCustomer: false,
    });

    const { results: deliveries } = await env.DB.prepare(
      `SELECT product_slug AS productSlug, status FROM deliveries WHERE purchase_session_id = ? ORDER BY product_slug ASC`
    )
      .bind(purchaseSessionId)
      .all<{ productSlug: string; status: string }>();

    expect(deliveries).toHaveLength(3);
    expect(deliveries.map((d) => d.productSlug).sort()).toEqual([BOOK_A, BOOK_B, BOOK_C].sort());
    expect(deliveries.every((d) => d.status === 'delivered')).toBe(true);
  });
});

describe('GET /books/:slug/ — bundle cross-sell section on individual book pages', () => {
  it('shows the cross-sell CTA, pointing at the bundle, when the bundle is active', async () => {
    await seedFullCatalog('active');

    const res = await SELF.fetch(`https://example.com/books/${BOOK_A}/`);
    const html = await res.text();

    expect(html).toContain('data-bundle-cross-sell-cta');
    expect(html).toContain(`/books/${BUNDLE_SLUG}/`);
    expect(html).toContain('Want the Complete Financial Literacy Collection?');
    expect(html).toContain('GH₵99.99');
  });

  it('does not show the cross-sell section while the bundle is still draft', async () => {
    await seedFullCatalog('draft');

    const res = await SELF.fetch(`https://example.com/books/${BOOK_A}/`);
    const html = await res.text();

    expect(html).not.toContain('data-bundle-cross-sell-cta');
  });

  it('does not show the cross-sell section on the bundle product page itself', async () => {
    await seedFullCatalog('active');

    const res = await SELF.fetch(`https://example.com/books/${BUNDLE_SLUG}/`);
    const html = await res.text();

    expect(html).not.toContain('data-bundle-cross-sell-cta');
    // The bundle's own "What's inside" section should still list its 3 real components.
    expect(html).toContain('Small Cedis, Big Wealth');
    expect(html).toContain('Understanding the Ghana Stock Exchange');
    expect(html).toContain('Treasury Bills Made Simple');
  });
});
