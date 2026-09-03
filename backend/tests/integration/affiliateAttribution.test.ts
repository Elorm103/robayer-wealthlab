/**
 * Integration tests: affiliate click tracking and checkout-time
 * attribution resolution. Real Worker fetch handler, real D1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession as createCustomerSession } from '../../services/customer/sessionService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM affiliate_commissions');
  await env.DB.exec('DELETE FROM affiliate_clicks');
  await env.DB.exec('DELETE FROM affiliates');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
  await env.RATE_LIMIT_KV.delete('ratelimit:checkout:unknown');
  await env.RATE_LIMIT_KV.delete('ratelimit:affiliate-click:unknown');
});

async function seedApprovedAffiliate(email: string, code: string): Promise<{ affiliateId: number; customerId: number }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const insert = await env.DB.prepare(
    `INSERT INTO affiliates (customer_id, affiliate_code, status, default_commission_percent, data_classification) VALUES (?, ?, 'approved', 20, 'PRODUCTION')`
  )
    .bind(customerId, code)
    .run();
  return { affiliateId: Number(insert.meta.last_row_id), customerId };
}

function extractCookie(res: Response, name: string): string | null {
  const setCookieHeaders = (res.headers as any).getAll ? (res.headers as any).getAll('set-cookie') : [res.headers.get('set-cookie')];
  for (const raw of setCookieHeaders) {
    if (!raw) continue;
    const match = raw.match(new RegExp(`${name}=([^;]*)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

/** Builds a rwl_ref cookie value in the real `CODE.ISSUED_AT_SECONDS` shape (see affiliateAttributionService.ts), `ageSeconds` in the past. */
function refCookie(code: string, ageSeconds = 0): string {
  return `${code}.${Math.floor(Date.now() / 1000) - ageSeconds}`;
}

describe('POST /api/affiliates/click', () => {
  it('a valid, approved affiliate code records a click and sets the rwl_ref cookie', async () => {
    await seedApprovedAffiliate('click-affiliate@example.com', 'RWLCLICK1');

    const res = await SELF.fetch('https://example.com/api/affiliates/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'RWLCLICK1', productSlug: null, landingPath: '/' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.attributed).toBe(true);

    const cookie = extractCookie(res, 'rwl_ref');
    expect(cookie).toMatch(/^RWLCLICK1\.\d+$/); // CODE.ISSUED_AT_SECONDS, not the bare code

    const clickCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM affiliate_clicks WHERE affiliate_id = (SELECT id FROM affiliates WHERE affiliate_code = 'RWLCLICK1')`).first<any>();
    expect(clickCount.n).toBe(1);
  });

  it('an invalid/unknown code is a silent no-op: no click recorded, no cookie set', async () => {
    const res = await SELF.fetch('https://example.com/api/affiliates/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'NOT-A-REAL-CODE', productSlug: null, landingPath: '/' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.attributed).toBe(false);
    expect(extractCookie(res, 'rwl_ref')).toBeNull();

    const clickCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM affiliate_clicks`).first<any>();
    expect(clickCount.n).toBe(0);
  });

  it('a pending (not-yet-approved) affiliate code does not attribute a click', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'pending-click@example.com', false);
    await env.DB.prepare(`INSERT INTO affiliates (customer_id, affiliate_code, status, default_commission_percent, data_classification) VALUES (?, 'RWLPENDING', 'pending', 20, 'PRODUCTION')`).bind(customerId).run();

    const res = await SELF.fetch('https://example.com/api/affiliates/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'RWLPENDING', productSlug: null, landingPath: '/' }),
    });
    const body = await res.json<any>();
    expect(body.data.attributed).toBe(false);
  });
});

describe('Checkout-time affiliate attribution', () => {
  it('a checkout carrying the rwl_ref cookie locks the affiliate id and commission percent onto the purchase session', async () => {
    await seedApprovedAffiliate('checkout-affiliate@example.com', 'RWLCHECKOUT');

    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `rwl_ref=${refCookie('RWLCHECKOUT')}` },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'buyer-referred@example.com' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const row = await env.DB.prepare(
      `SELECT affiliate_id AS affiliateId, affiliate_commission_percent AS pct FROM purchase_sessions WHERE purchase_reference = ?`
    )
      .bind(body.data.purchaseReference)
      .first<any>();
    expect(row.affiliateId).toBeTruthy();
    expect(row.pct).toBe(20);
  });

  it('a checkout with no rwl_ref cookie leaves affiliate attribution null (direct/organic purchase)', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'organic-buyer@example.com' }),
    });
    const body = await res.json<any>();
    const row = await env.DB.prepare(`SELECT affiliate_id AS affiliateId FROM purchase_sessions WHERE purchase_reference = ?`).bind(body.data.purchaseReference).first<any>();
    expect(row.affiliateId).toBeNull();
  });

  it('a tampered/invalid rwl_ref cookie value is ignored: checkout still succeeds, no attribution', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'rwl_ref=NOT-A-REAL-AFFILIATE-ID-123' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'tamper-buyer@example.com' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    const row = await env.DB.prepare(`SELECT affiliate_id AS affiliateId FROM purchase_sessions WHERE purchase_reference = ?`).bind(body.data.purchaseReference).first<any>();
    expect(row.affiliateId).toBeNull();
  });

  it('a suspended affiliate\'s referral link no longer attributes at checkout', async () => {
    const { affiliateId } = await seedApprovedAffiliate('suspended-checkout@example.com', 'RWLSUSPENDED');
    await env.DB.prepare(`UPDATE affiliates SET status = 'suspended' WHERE id = ?`).bind(affiliateId).run();

    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `rwl_ref=${refCookie('RWLSUSPENDED')}` },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'buyer-of-suspended@example.com' }),
    });
    const body = await res.json<any>();
    const row = await env.DB.prepare(`SELECT affiliate_id AS affiliateId FROM purchase_sessions WHERE purchase_reference = ?`).bind(body.data.purchaseReference).first<any>();
    expect(row.affiliateId).toBeNull();
  });

  it('checking out with the SAME email as the affiliate account is treated as a self-referral: not attributed', async () => {
    await seedApprovedAffiliate('self-referrer@example.com', 'RWLSELFREF');

    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `rwl_ref=${refCookie('RWLSELFREF')}` },
      // Same email as the affiliate's own account: checkout-time heuristic should block attribution.
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'self-referrer@example.com' }),
    });
    const body = await res.json<any>();
    const row = await env.DB.prepare(`SELECT affiliate_id AS affiliateId FROM purchase_sessions WHERE purchase_reference = ?`).bind(body.data.purchaseReference).first<any>();
    expect(row.affiliateId).toBeNull();
  });

  it('a cookie older than the 30-day attribution window is rejected server-side, independent of the browser Max-Age', async () => {
    await seedApprovedAffiliate('expired-window@example.com', 'RWLEXPIRED');
    const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60;

    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      // A real browser would never send this (Max-Age would have expired it), but a
      // non-browser client can set an arbitrary Cookie header with no real expiry of
      // its own, which is exactly the gap the embedded issued-at timestamp closes.
      headers: { 'Content-Type': 'application/json', Cookie: `rwl_ref=${refCookie('RWLEXPIRED', THIRTY_ONE_DAYS)}` },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'buyer-of-expired@example.com' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true); // checkout still succeeds: expired attribution is a silent no-op, not an error
    const row = await env.DB.prepare(`SELECT affiliate_id AS affiliateId FROM purchase_sessions WHERE purchase_reference = ?`).bind(body.data.purchaseReference).first<any>();
    expect(row.affiliateId).toBeNull();
  });

  it('a cookie just inside the 30-day window (29 days old) still attributes normally', async () => {
    await seedApprovedAffiliate('still-valid-window@example.com', 'RWLSTILLVALID');
    const TWENTY_NINE_DAYS = 29 * 24 * 60 * 60;

    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `rwl_ref=${refCookie('RWLSTILLVALID', TWENTY_NINE_DAYS)}` },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'buyer-of-still-valid@example.com' }),
    });
    const body = await res.json<any>();
    const row = await env.DB.prepare(`SELECT affiliate_id AS affiliateId FROM purchase_sessions WHERE purchase_reference = ?`).bind(body.data.purchaseReference).first<any>();
    expect(row.affiliateId).toBeTruthy();
  });

  it('a later click from a DIFFERENT affiliate overwrites an earlier one: last-click wins', async () => {
    await seedApprovedAffiliate('first-affiliate@example.com', 'RWLFIRST');
    await seedApprovedAffiliate('second-affiliate@example.com', 'RWLSECOND');

    const firstClick = await SELF.fetch('https://example.com/api/affiliates/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'RWLFIRST', productSlug: null, landingPath: '/' }),
    });
    const secondClick = await SELF.fetch('https://example.com/api/affiliates/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `rwl_ref=${extractCookie(firstClick, 'rwl_ref')}` },
      body: JSON.stringify({ code: 'RWLSECOND', productSlug: null, landingPath: '/' }),
    });
    const finalCookie = extractCookie(secondClick, 'rwl_ref');
    expect(finalCookie).toBe('RWLSECOND');
  });
});
