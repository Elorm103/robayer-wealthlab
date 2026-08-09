/**
 * Integration tests: checkout endpoint — Version 3.0.2 Milestone M1.
 * Exercises the real Worker fetch handler (SELF), not the service
 * function directly, so consent validation, rate limiting, and the
 * response envelope are all covered as a real client would see them.
 *
 * Uses tests/outboundMock.ts to intercept the worker's outbound
 * fetch() to Paystack's /transaction/initialize endpoint — see that
 * file's own header comment for why (undici's MockAgent and a real
 * local HTTP server were both tried and both fail in this sandbox).
 * No real network call to Paystack is ever made.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { queueInitializeResponse } from '../outboundMock';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM purchase_sessions');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

describe('POST /api/checkout/sessions', () => {
  it('rejects a request with no consent fields at all', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONSENT_REQUIRED');
  });

  it('rejects termsAccepted: false even if licenseAccepted is true', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: false, licenseAccepted: true }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONSENT_REQUIRED');
  });

  it('rejects a truthy-but-not-boolean-true consent value (e.g. the string "true")', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: 'true', licenseAccepted: true }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONSENT_REQUIRED');
  });

  it('accepts a valid request with both consents true and stamps a purchase_sessions row with the current terms/license version', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, marketingOptIn: true, email: 'checkout-test@example.com' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.purchaseReference).toMatch(/^RWL-\d{4}-\d+$/);

    const row = await env.DB.prepare(
      'SELECT terms_accepted_at, terms_version, license_accepted_at, license_version, marketing_opt_in FROM purchase_sessions WHERE purchase_reference = ?'
    )
      .bind(body.data.purchaseReference)
      .first<any>();
    expect(row.terms_accepted_at).toBeTruthy();
    expect(row.terms_version).toBe('v1.0');
    expect(row.license_accepted_at).toBeTruthy();
    expect(row.license_version).toBe('v1.0');
    expect(row.marketing_opt_in).toBe(1);
  });

  it('marketingOptIn defaults to false (0) when omitted', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'checkout-test@example.com' }),
    });
    const body = await res.json<any>();
    const row = await env.DB.prepare('SELECT marketing_opt_in FROM purchase_sessions WHERE purchase_reference = ?')
      .bind(body.data.purchaseReference)
      .first<any>();
    expect(row.marketing_opt_in).toBe(0);
  });

  it('rejects an unknown product slug', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'this-product-does-not-exist', termsAccepted: true, licenseAccepted: true, email: 'checkout-test@example.com' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('surfaces PAYSTACK_API_ERROR and marks the session failed if the provider rejects initialization', async () => {
    await queueInitializeResponse(env as any, { status: false, message: 'simulated provider failure' });

    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'checkout-test@example.com' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PAYSTACK_API_ERROR');
  });
});
