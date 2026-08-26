/**
 * Integration test: end-to-end proof that a RATE_LIMIT_KV outage no
 * longer crashes checkout. Production incident, 2026-08-26 —
 * RATE_LIMIT_KV hit Cloudflare's daily KV write quota, and every
 * `isRateLimited()` call (checkout included, since it's the very
 * first thing handleCreateCheckoutSession does) threw uncaught,
 * turning into a real 500 for a real customer's checkout attempt. See
 * middleware/rateLimit.ts's own header comment for the fix.
 *
 * Mocks env.RATE_LIMIT_KV.get()/put() to reject, exactly mirroring the
 * real Cloudflare error ("KV put() limit exceeded for the day."), then
 * exercises the real Worker via SELF.fetch — not a direct call to
 * isRateLimited() — so this specifically proves the fix reaches all
 * the way through worker/index.ts's route dispatch and
 * routes/checkout.ts, not just the middleware function in isolation
 * (that narrower contract is covered by tests/unit/rateLimit.test.ts).
 *
 * The checkout payload here is intentionally invalid (no productId/
 * consent/email) so the request fails ordinary validation immediately
 * after the rate-limit check — this reaches createCheckoutSession()
 * and any real Paystack call. No purchase_sessions row is created, no
 * Paystack session is initialized, matching the explicit "confirm no
 * real payment is created during testing" requirement.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RATE_LIMIT_KV outage — checkout stays available', () => {
  it('POST /api/checkout/sessions returns a normal VALIDATION_ERROR, not a 500, when RATE_LIMIT_KV.get() throws', async () => {
    vi.spyOn(env.RATE_LIMIT_KV, 'get').mockRejectedValue(new Error('KV get() limit exceeded for the day.'));
    const putSpy = vi.spyOn(env.RATE_LIMIT_KV, 'put');

    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.90' },
      body: JSON.stringify({}),
    });
    const body = await res.json<any>();

    expect(res.status).not.toBe(500);
    expect(body.error.code).not.toBe('RATE_LIMITED');
    expect(body.error.code).not.toBe('INTERNAL_ERROR');
    expect(body.error.code).toBe('VALIDATION_ERROR');

    // No purchase_sessions row was ever created — the request never
    // got far enough to touch Paystack or persist anything.
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM purchase_sessions WHERE created_at > datetime('now', '-1 minute')`
    ).first<{ n: number }>();
    expect(row?.n).toBe(0);

    // The fallback path never attempts a put() after a get() failure
    // on the SAME request — confirms the fix didn't just swallow the
    // error and continue as if nothing happened.
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('POST /api/analytics/event does not fail with a KV-quota 500 when RATE_LIMIT_KV is down', async () => {
    vi.spyOn(env.RATE_LIMIT_KV, 'get').mockRejectedValue(new Error('KV get() limit exceeded for the day.'));
    vi.spyOn(env.RATE_LIMIT_KV, 'put').mockRejectedValue(new Error('KV put() limit exceeded for the day.'));

    const res = await SELF.fetch('https://example.com/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.91' },
      body: JSON.stringify({ eventType: 'page_view', pagePath: '/', sessionId: 'kv-outage-test-session' }),
    });
    const body = await res.json<any>();

    expect(res.status).not.toBe(500);
    expect(body.success).toBe(true);
  });

  it('normal rate limiting still functions when RATE_LIMIT_KV is healthy (no regression from the fallback change)', async () => {
    const ip = '203.0.113.92';
    const results: any[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({}),
      });
      results.push(await res.json());
    }

    // checkout's real limit is 10/60s (routes/checkout.ts's own
    // RATE_LIMIT constant) - unchanged by this fix.
    for (let i = 0; i < 10; i++) {
      expect(results[i].error.code).toBe('VALIDATION_ERROR');
    }
    expect(results[10].error.code).toBe('RATE_LIMITED');
  });
});
