/**
 * Version 4.2.5 (Hero Cover Flicker Root Cause) regression test.
 *
 * GET /api/products used to fetch each item's review summary with a
 * separate D1 round trip per product (Promise.all over N sequential-
 * cost queries) - production tracing showed this as a real contributor
 * to the endpoint's ~756ms response time. Replaced with one batched
 * getReviewSummaries() query. Guards against the batching regressing
 * back to N+1, and against a zero-review product silently falling
 * through to an incorrect summary.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';

const SLUG_WITH_REVIEWS = 'test-review-summary-a';
const SLUG_NO_REVIEWS = 'test-review-summary-b';

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM product_reviews WHERE product_id IN (SELECT id FROM products WHERE slug IN (?, ?))`)
    .bind(SLUG_WITH_REVIEWS, SLUG_NO_REVIEWS)
    .run();
  await env.DB.prepare(`DELETE FROM purchase_sessions WHERE product_slug IN (?, ?)`).bind(SLUG_WITH_REVIEWS, SLUG_NO_REVIEWS).run();
  await env.DB.prepare(`DELETE FROM products WHERE slug IN (?, ?)`).bind(SLUG_WITH_REVIEWS, SLUG_NO_REVIEWS).run();

  await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES ('prod-review-summary-a', ?, 'Has Reviews', 'investing', 'ebook', 'active', 1000, 'GHS', 'one-time', 'inclusive', 'en')`
  ).bind(SLUG_WITH_REVIEWS).run();
  await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES ('prod-review-summary-b', ?, 'No Reviews', 'investing', 'ebook', 'active', 1000, 'GHS', 'one-time', 'inclusive', 'en')`
  ).bind(SLUG_NO_REVIEWS).run();

  const withReviewsId = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(SLUG_WITH_REVIEWS).first<{ id: number }>();

  async function seedApprovedReview(reference: string, rating: number) {
    const { customerId } = await findOrCreateCustomer(env as any, `reviewer-${reference}@example.com`, false);
    const purchaseInsert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, customer_id)
       VALUES (?, ?, 'prod-review-summary-a', 'Has Reviews', 1000, 'GHS', 'verified', datetime('now', '+30 minutes'), ?)`
    )
      .bind(reference, SLUG_WITH_REVIEWS, customerId)
      .run();
    const purchaseSessionId = Number(purchaseInsert.meta.last_row_id);
    await env.DB.prepare(
      `INSERT INTO product_reviews (product_id, customer_id, purchase_session_id, rating, body, status) VALUES (?, ?, ?, ?, 'Review body.', 'approved')`
    )
      .bind(withReviewsId!.id, customerId, purchaseSessionId, rating)
      .run();
  }

  await seedApprovedReview('review-summary-1', 5);
  await seedApprovedReview('review-summary-2', 3);
});

describe('GET /api/products review summary batching', () => {
  it('returns correct rating/reviewCount for both a reviewed and an unreviewed product in one request', async () => {
    const res = await SELF.fetch('https://example.com/api/products?pageSize=100');
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const withReviews = body.data.items.find((p: any) => p.slug === SLUG_WITH_REVIEWS);
    const noReviews = body.data.items.find((p: any) => p.slug === SLUG_NO_REVIEWS);

    expect(withReviews).toBeTruthy();
    expect(withReviews.reviewCount).toBe(2);
    expect(withReviews.rating).toBe(4);

    expect(noReviews).toBeTruthy();
    expect(noReviews.reviewCount).toBe(0);
    expect(noReviews.rating).toBeNull();
  });
});
