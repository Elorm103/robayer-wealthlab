/**
 * Integration tests: attribution capture at checkout — P0-C
 * (Attribution Continuity, Business Intelligence backbone). Exercises
 * the real Worker fetch handler (SELF), matching checkout.test.ts's
 * own convention for this endpoint: consent/rate-limiting/response
 * envelope all covered as a real client would see them, Paystack's
 * outbound call intercepted via tests/outboundMock.ts.
 *
 * Central concerns: UTM values submitted by the client are persisted
 * as-is (trimmed/capped, empty -> NULL); attribution_confidence is
 * always computed server-side from UTM + fbc, never accepted from the
 * client even when supplied.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM purchase_sessions');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

const BASE_BODY = { productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'attribution-test@example.com' };

async function createSession(body: Record<string, unknown>, cookie?: string): Promise<any> {
  const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  return res.json<any>();
}

async function fetchSession(purchaseReference: string): Promise<any> {
  return env.DB.prepare(
    'SELECT utm_source AS utmSource, utm_medium AS utmMedium, utm_campaign AS utmCampaign, attribution_confidence AS attributionConfidence FROM purchase_sessions WHERE purchase_reference = ?'
  )
    .bind(purchaseReference)
    .first<any>();
}

describe('POST /api/checkout/sessions — attribution capture (P0-C)', () => {
  it('persists submitted utmSource/utmMedium/utmCampaign exactly as sent', async () => {
    const body = await createSession({ ...BASE_BODY, utmSource: 'meta', utmMedium: 'cpc', utmCampaign: 'RWL | Book 3 | Ghana | Purchase' });
    expect(body.success).toBe(true);

    const row = await fetchSession(body.data.purchaseReference);
    expect(row.utmSource).toBe('meta');
    expect(row.utmMedium).toBe('cpc');
    expect(row.utmCampaign).toBe('RWL | Book 3 | Ghana | Purchase');
  });

  it('stores empty-string UTM values as NULL, not empty strings', async () => {
    const body = await createSession({ ...BASE_BODY, utmSource: '', utmMedium: '   ', utmCampaign: '' });
    expect(body.success).toBe(true);

    const row = await fetchSession(body.data.purchaseReference);
    expect(row.utmSource).toBeNull();
    expect(row.utmMedium).toBeNull();
    expect(row.utmCampaign).toBeNull();
  });

  it('trims whitespace and caps an oversized UTM value rather than rejecting the checkout', async () => {
    const overlong = 'x'.repeat(500);
    const body = await createSession({ ...BASE_BODY, utmSource: '  meta  ', utmCampaign: overlong });
    expect(body.success).toBe(true);

    const row = await fetchSession(body.data.purchaseReference);
    expect(row.utmSource).toBe('meta');
    expect(row.utmCampaign!.length).toBeLessThanOrEqual(100);
  });

  it("labels attribution_confidence 'utm' when UTM is present, even if fbc is also present", async () => {
    const body = await createSession({ ...BASE_BODY, utmSource: 'meta', utmCampaign: 'test-campaign' }, '_fbc=fb.1.111.aaa; _fbp=fb.1.222.bbb');
    expect(body.success).toBe(true);

    const row = await fetchSession(body.data.purchaseReference);
    expect(row.attributionConfidence).toBe('utm');
  });

  it("labels attribution_confidence 'meta_click' when fbc is present but no UTM was submitted", async () => {
    const body = await createSession({ ...BASE_BODY }, '_fbc=fb.1.111.aaa; _fbp=fb.1.222.bbb');
    expect(body.success).toBe(true);

    const row = await fetchSession(body.data.purchaseReference);
    expect(row.attributionConfidence).toBe('meta_click');
  });

  it("labels attribution_confidence 'unknown' when neither UTM nor fbc is present (no referrer evidence exists to support 'direct')", async () => {
    const body = await createSession({ ...BASE_BODY });
    expect(body.success).toBe(true);

    const row = await fetchSession(body.data.purchaseReference);
    expect(row.attributionConfidence).toBe('unknown');
  });

  it('ignores a client-submitted attributionConfidence value entirely — the server always computes its own', async () => {
    const body = await createSession({ ...BASE_BODY, attributionConfidence: 'utm', utmSource: null });
    expect(body.success).toBe(true);

    const row = await fetchSession(body.data.purchaseReference);
    // No UTM, no fbc submitted -> server-computed 'unknown', not the client's 'utm'.
    expect(row.attributionConfidence).toBe('unknown');
  });

  it('still succeeds for a request that sends no attribution fields at all (backward compatibility)', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'legacy-client@example.com' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const row = await fetchSession(body.data.purchaseReference);
    expect(row.utmSource).toBeNull();
    expect(row.utmMedium).toBeNull();
    expect(row.utmCampaign).toBeNull();
    expect(row.attributionConfidence).toBe('unknown');
  });
});
