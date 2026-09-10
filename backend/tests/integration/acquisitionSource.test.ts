/**
 * Integration tests: acquisition_source classification — Affiliate
 * Programme 2.0 (Revenue Attribution). Real Worker fetch handler, real
 * D1. Exercises services/commerceService.ts's classifyAcquisitionSource()
 * end-to-end through POST /api/checkout/sessions, matching
 * attributionCapture.test.ts's own conventions for this endpoint
 * (consent/rate-limiting/response envelope as a real client would see
 * them). Covers the organic/paid/affiliate/direct/unknown precedence
 * documented in commerceService.ts's own header comment above
 * classifyAcquisitionSource().
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM affiliate_commissions');
  await env.DB.exec('DELETE FROM affiliate_clicks');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM affiliates');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
  await env.RATE_LIMIT_KV.delete('ratelimit:checkout:unknown');
});

async function seedApprovedAffiliate(email: string, code: string): Promise<void> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  await env.DB.prepare(
    `INSERT INTO affiliates (customer_id, affiliate_code, status, default_commission_percent, data_classification) VALUES (?, ?, 'approved', 20, 'PRODUCTION')`
  )
    .bind(customerId, code)
    .run();
}

function refCookie(code: string): string {
  return `${code}.${Math.floor(Date.now() / 1000)}`;
}

async function createSession(body: Record<string, unknown>, cookie?: string): Promise<any> {
  const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  return res.json<any>();
}

async function fetchAcquisitionSource(purchaseReference: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT acquisition_source AS acquisitionSource FROM purchase_sessions WHERE purchase_reference = ?`)
    .bind(purchaseReference)
    .first<any>();
  return row.acquisitionSource;
}

const BASE_BODY = { productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true };

describe('POST /api/checkout/sessions — acquisition_source classification', () => {
  it("classifies a paid utm_medium (e.g. 'cpc') as 'paid'", async () => {
    const body = await createSession({ ...BASE_BODY, email: 'paid-buyer@example.com', utmSource: 'google', utmMedium: 'cpc' });
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('paid');
  });

  it("classifies utm_medium='organic' as 'organic'", async () => {
    const body = await createSession({ ...BASE_BODY, email: 'organic-utm-buyer@example.com', utmSource: 'google', utmMedium: 'organic' });
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('organic');
  });

  it('classifies a known search-engine referrer with no UTM as organic', async () => {
    const body = await createSession({ ...BASE_BODY, email: 'organic-referrer-buyer@example.com', referrer: 'https://www.google.com/search?q=treasury+bills' });
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('organic');
  });

  it('classifies a visit with no UTM and no referrer as direct', async () => {
    const body = await createSession({ ...BASE_BODY, email: 'direct-buyer@example.com' });
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('direct');
  });

  it('classifies an unrecognized referrer with no UTM as unknown, never fabricating organic/paid/direct', async () => {
    const body = await createSession({ ...BASE_BODY, email: 'unknown-buyer@example.com', referrer: 'https://some-random-forum.example/thread/42' });
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('unknown');
  });

  it('classifies a resolved affiliate referral as affiliate, even when a paid UTM is also present (affiliate takes precedence)', async () => {
    await seedApprovedAffiliate('acquisition-affiliate@example.com', 'RWLACQUIRE');
    const body = await createSession(
      { ...BASE_BODY, email: 'buyer-via-affiliate@example.com', utmSource: 'facebook', utmMedium: 'cpc' },
      `rwl_ref=${refCookie('RWLACQUIRE')}`
    );
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('affiliate');
  });

  it('does NOT classify as affiliate when the referral cookie fails checkout-time re-validation (unapproved code)', async () => {
    const body = await createSession({ ...BASE_BODY, email: 'buyer-of-invalid-ref@example.com' }, 'rwl_ref=NOT-A-REAL-CODE.0');
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('direct');
  });

  it('ignores a client-submitted acquisitionSource value entirely — the server always computes its own', async () => {
    const body = await createSession({ ...BASE_BODY, email: 'spoofed-source@example.com', acquisitionSource: 'affiliate' });
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('direct');
  });
});

describe('POST /api/checkout/sessions — Meta/Facebook Attribution Fix (fbc precedence)', () => {
  it("classifies utm_medium='paid' as 'paid'", async () => {
    const body = await createSession({ ...BASE_BODY, email: 'meta-paid-medium-buyer@example.com', utmSource: 'facebook', utmMedium: 'paid' });
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('paid');
  });

  it("classifies utm_medium='paid_social' as 'paid'", async () => {
    const body = await createSession({ ...BASE_BODY, email: 'meta-paid-social-buyer@example.com', utmSource: 'facebook', utmMedium: 'paid_social' });
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('paid');
  });

  it('core bug case: no recognized UTM medium + a facebook.com referrer + fbc present classifies as paid, not organic', async () => {
    const body = await createSession(
      { ...BASE_BODY, email: 'meta-lost-utm-facebook-buyer@example.com', referrer: 'https://facebook.com/' },
      '_fbc=fb.1.111.aaa'
    );
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('paid');
  });

  it('core bug case: no recognized UTM medium + no referrer + fbc present classifies as paid, not direct/unknown', async () => {
    const body = await createSession({ ...BASE_BODY, email: 'meta-lost-utm-no-referrer-buyer@example.com' }, '_fbc=fb.1.111.aaa');
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('paid');
  });

  it('a genuinely organic Facebook referral (no UTM, no fbc) remains organic', async () => {
    const body = await createSession({ ...BASE_BODY, email: 'organic-facebook-buyer@example.com', referrer: 'https://facebook.com/' });
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('organic');
  });

  it('a genuinely organic Instagram referral (no UTM, no fbc) remains organic', async () => {
    const body = await createSession({ ...BASE_BODY, email: 'organic-instagram-buyer@example.com', referrer: 'https://instagram.com/' });
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('organic');
  });

  it('a visit with no UTM, no referrer, and no fbc remains direct (unaffected by this fix)', async () => {
    const body = await createSession({ ...BASE_BODY, email: 'still-direct-buyer@example.com' });
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('direct');
  });

  it('a Google organic referral (no UTM, no fbc) remains organic (unaffected by this fix)', async () => {
    const body = await createSession({ ...BASE_BODY, email: 'still-google-organic-buyer@example.com', referrer: 'https://www.google.com/search?q=treasury+bills' });
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('organic');
  });

  it('affiliate precedence: a resolved affiliate referral wins over fbc — affiliate attribution must continue to win over Meta attribution', async () => {
    await seedApprovedAffiliate('meta-vs-affiliate@example.com', 'RWLMETAVSAFF');
    const body = await createSession(
      { ...BASE_BODY, email: 'buyer-via-affiliate-with-fbc@example.com' },
      `rwl_ref=${refCookie('RWLMETAVSAFF')}; _fbc=fb.1.111.aaa`
    );
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('affiliate');
  });

  it("explicit organic UTM precedence: utm_medium='organic' wins over fbc — fbc must never override an explicit organic UTM", async () => {
    const body = await createSession(
      { ...BASE_BODY, email: 'organic-utm-with-fbc-buyer@example.com', utmSource: 'facebook', utmMedium: 'organic' },
      '_fbc=fb.1.111.aaa'
    );
    expect(body.success).toBe(true);
    expect(await fetchAcquisitionSource(body.data.purchaseReference)).toBe('organic');
  });
});
