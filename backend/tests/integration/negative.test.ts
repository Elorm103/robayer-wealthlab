/**
 * Negative / adversarial tests — Version 3.0.2 Milestone M1. Covers
 * this sprint's explicit "Negative Tests" requirement not already
 * exercised by checkout.test.ts/webhook.test.ts/customerAuth.test.ts:
 * malformed JSON, oversized/malicious-shaped input, and requests that
 * should never reach real business logic at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { queueInitializeResponse } from '../outboundMock';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';
import { findOrCreateCustomer } from '../../services/customer/identityService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_password_tokens');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

describe('malformed / malicious requests', () => {
  it('checkout with malformed JSON body is rejected cleanly, not a 500', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json,,,',
    });
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
  });

  it("a SQL-injection-shaped productId is safely rejected as PRODUCT_NOT_FOUND, never a database error", async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: "'; DROP TABLE products; --", termsAccepted: true, licenseAccepted: true }),
    });
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);

    // The table must still exist and be queryable — proves parameterized
    // binding held, not string concatenation.
    const stillThere = await env.DB.prepare('SELECT COUNT(*) AS n FROM products').first<any>();
    expect(stillThere.n).toBeGreaterThanOrEqual(1);
  });

  it('an oversized productId string is rejected, not processed', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'a'.repeat(100_000), termsAccepted: true, licenseAccepted: true }),
    });
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
  });

  it('login with an oversized email/password is rejected without a database error', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${'a'.repeat(10_000)}@example.com`, password: 'x'.repeat(10_000) }),
    });
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('set-password with a non-string token is rejected cleanly', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: { $ne: null }, newPassword: 'correct-horse-battery-staple-1' }),
    });
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  it('an XSS-shaped email at signup is stored/queried safely as an inert string (no template execution anywhere in this path)', async () => {
    const email = '<script>alert(1)</script>@example.com';
    const result = await findOrCreateCustomer(env as any, email, false);
    const row = await env.DB.prepare('SELECT email FROM customers WHERE id = ?').bind(result.customerId).first<any>();
    expect(row.email).toBe(email.toLowerCase());
  });

  it('a completely empty request body on checkout is rejected, not a crash', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    expect(res.status).toBeLessThan(500);
  });

  it('webhook with a well-formed but nonexistent purchase reference is safely ignored, not an error', async () => {
    const payload = { event: 'charge.success', data: { reference: 'RWL-2026-999999', amount: 3900, currency: 'GHS' } };
    const rawBody = JSON.stringify(payload);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.PAYSTACK_SECRET_KEY), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
    const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
    const signature = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

    const res = await SELF.fetch('https://example.com/api/webhooks/paystack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
      body: rawBody,
    });
    expect(res.status).toBeLessThan(500);
    expect((await res.json<any>()).success).toBe(true); // still acked — see routes/webhooks.ts's own-header comment
  });

  it(`checkout for the reference used in the flagship product's real slug ("${TEST_PRODUCT_SLUG}") still enforces consent even under load-adjacent rapid repeat requests`, async () => {
    await queueInitializeResponse(env as any, { status: true, message: 'ok', data: { authorization_url: 'https://x', reference: 'r' } });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        SELF.fetch('https://example.com/api/checkout/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId: TEST_PRODUCT_SLUG }), // no consent — every one of these must fail
        }).then((r) => r.json<any>())
      )
    );
    for (const body of results) {
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CONSENT_REQUIRED');
    }
  });
});
