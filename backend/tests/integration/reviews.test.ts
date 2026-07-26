/**
 * Integration tests: public + customer review endpoints — Version 3.2
 * Milestone M4 (Reviews & Coupons). Exercises GET
 * /api/products/:slug/reviews, GET /api/customer/reviews, and POST
 * /api/customer/reviews through the real Worker fetch handler —
 * purchase-gating, CSRF, and ownership are the central concerns.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession } from '../../services/customer/sessionService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM product_reviews');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

async function seedCustomerWithSession(email: string): Promise<{ customerId: number; cookieHeader: string; csrfSecret: string }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const session = await createSession(env as any, customerId, { ip: null, userAgent: null });
  return { customerId, cookieHeader: `customer_session=${session.sessionToken}`, csrfSecret: session.csrfSecret };
}

async function seedVerifiedPurchase(customerId: number, reference: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, customer_id)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'), ?)`
  )
    .bind(reference, TEST_PRODUCT_SLUG, customerId)
    .run();
}

describe('POST /api/customer/reviews', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productSlug: TEST_PRODUCT_SLUG, rating: 5, body: 'Great!' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a request missing the CSRF header', async () => {
    const { cookieHeader } = await seedCustomerWithSession('no-csrf@example.com');
    const res = await SELF.fetch('https://example.com/api/customer/reviews', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productSlug: TEST_PRODUCT_SLUG, rating: 5, body: 'Great!' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a customer with no verified purchase, with a friendly, non-enumerating error', async () => {
    const { cookieHeader, csrfSecret } = await seedCustomerWithSession('never-bought@example.com');
    const res = await SELF.fetch('https://example.com/api/customer/reviews', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productSlug: TEST_PRODUCT_SLUG, rating: 5, body: 'Never bought this.' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NO_VERIFIED_PURCHASE');

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM product_reviews').first<any>();
    expect(row.n).toBe(0); // never created, purchase-gating held
  });

  it('accepts a review from a customer with a verified purchase and it starts as pending (not immediately public)', async () => {
    const { customerId, cookieHeader, csrfSecret } = await seedCustomerWithSession('real-buyer@example.com');
    await seedVerifiedPurchase(customerId, 'RWL-2026-900001');

    const res = await SELF.fetch('https://example.com/api/customer/reviews', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productSlug: TEST_PRODUCT_SLUG, rating: 5, body: 'Genuinely great guide.' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('pending');

    const publicRes = await SELF.fetch(`https://example.com/api/products/${TEST_PRODUCT_SLUG}/reviews`);
    const publicBody = await publicRes.json<any>();
    expect(publicBody.data.count).toBe(0); // pending is not yet public
  });

  it('rejects an out-of-range rating and an over-length body', async () => {
    const { customerId, cookieHeader, csrfSecret } = await seedCustomerWithSession('validator@example.com');
    await seedVerifiedPurchase(customerId, 'RWL-2026-900002');

    const badRating = await SELF.fetch('https://example.com/api/customer/reviews', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productSlug: TEST_PRODUCT_SLUG, rating: 6, body: 'x' }),
    });
    expect((await badRating.json<any>()).success).toBe(false);

    const badBody = await SELF.fetch('https://example.com/api/customer/reviews', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productSlug: TEST_PRODUCT_SLUG, rating: 5, body: 'x'.repeat(3001) }),
    });
    expect((await badBody.json<any>()).success).toBe(false);
  });
});

describe('GET /api/customer/reviews', () => {
  it("returns only the authenticated customer's own reviews", async () => {
    const { customerId, cookieHeader, csrfSecret } = await seedCustomerWithSession('owner@example.com');
    await seedVerifiedPurchase(customerId, 'RWL-2026-900003');
    await SELF.fetch('https://example.com/api/customer/reviews', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productSlug: TEST_PRODUCT_SLUG, rating: 4, body: 'Mine.' }),
    });

    const { cookieHeader: otherCookie } = await seedCustomerWithSession('other@example.com');
    const res = await SELF.fetch('https://example.com/api/customer/reviews', { headers: { Cookie: otherCookie } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.reviews).toEqual([]);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/reviews');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/products/:slug/reviews', () => {
  it('is public and returns an honest empty result for a product with no reviews', async () => {
    const res = await SELF.fetch(`https://example.com/api/products/${TEST_PRODUCT_SLUG}/reviews`);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ reviews: [], averageRating: null, count: 0 });
  });
});
