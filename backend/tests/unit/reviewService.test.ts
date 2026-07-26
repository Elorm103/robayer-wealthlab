/**
 * Unit tests: review moderation and purchase-gating — Version 3.2
 * Milestone M4 (Reviews & Coupons). Exercises services/reviewService.ts
 * directly against a real D1 instance, independent of the HTTP layer
 * (that is covered separately in tests/integration/reviews.test.ts and
 * tests/integration/adminReviews.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createLogger } from '../../utils/logger';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';
import {
  submitOrUpdateReview,
  listPublicReviews,
  listCustomerOwnReviews,
  listReviewsForModeration,
  moderateReview,
  isValidRating,
  isValidReviewBody,
} from '../../services/reviewService';

const logger = createLogger('test-request-id', 'test');

beforeEach(async () => {
  await env.DB.exec('DELETE FROM product_reviews');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customers');
  await env.DB.exec('DELETE FROM admin_users');
  await env.DB.exec('DELETE FROM audit_logs');
  await cleanupTestProduct(env as any);
});

async function seedCustomer(email: string): Promise<number> {
  const insert = await env.DB.prepare(`INSERT INTO customers (email) VALUES (?)`).bind(email).run();
  return Number(insert.meta.last_row_id);
}

async function seedVerifiedPurchase(customerId: number, reference: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, customer_id)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'), ?)`
  )
    .bind(reference, TEST_PRODUCT_SLUG, customerId)
    .run();
}

async function seedAdmin(): Promise<number> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role) VALUES (?, 'x:1:x', 'super_admin')`)
    .bind(`admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  return Number(insert.meta.last_row_id);
}

describe('isValidRating / isValidReviewBody', () => {
  it('accepts integers 1 through 5 only', () => {
    expect(isValidRating(1)).toBe(true);
    expect(isValidRating(5)).toBe(true);
    expect(isValidRating(0)).toBe(false);
    expect(isValidRating(6)).toBe(false);
    expect(isValidRating(3.5)).toBe(false);
    expect(isValidRating('3')).toBe(false);
  });

  it('rejects empty/whitespace-only and over-length review bodies', () => {
    expect(isValidReviewBody('Good guide.')).toBe(true);
    expect(isValidReviewBody('')).toBe(false);
    expect(isValidReviewBody('   ')).toBe(false);
    expect(isValidReviewBody('x'.repeat(3001))).toBe(false);
    expect(isValidReviewBody('x'.repeat(3000))).toBe(true);
  });
});

describe('submitOrUpdateReview', () => {
  it('rejects a customer with no verified purchase of the product', async () => {
    await seedTestProduct(env as any);
    const customerId = await seedCustomer('no-purchase@example.com');

    const result = await submitOrUpdateReview(env as any, logger, customerId, { productSlug: TEST_PRODUCT_SLUG, rating: 5, body: 'Great!' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_verified_purchase');
  });

  it('creates a pending review for a customer with a real verified purchase', async () => {
    await seedTestProduct(env as any);
    const customerId = await seedCustomer('owner@example.com');
    await seedVerifiedPurchase(customerId, 'RWL-2026-700001');

    const result = await submitOrUpdateReview(env as any, logger, customerId, { productSlug: TEST_PRODUCT_SLUG, rating: 4, body: 'Solid guide.' });
    expect(result.ok).toBe(true);

    const row = await env.DB.prepare('SELECT rating, status FROM product_reviews WHERE id = ?').bind((result as any).reviewId).first<any>();
    expect(row.rating).toBe(4);
    expect(row.status).toBe('pending');
  });

  it('editing an existing review resets it to pending and does not create a second row (one review per product/customer)', async () => {
    await seedTestProduct(env as any);
    const customerId = await seedCustomer('editor@example.com');
    await seedVerifiedPurchase(customerId, 'RWL-2026-700002');
    const adminId = await seedAdmin();

    const first = await submitOrUpdateReview(env as any, logger, customerId, { productSlug: TEST_PRODUCT_SLUG, rating: 3, body: 'It was okay.' });
    expect(first.ok).toBe(true);
    await moderateReview(env as any, logger, adminId, (first as any).reviewId, 'approved');

    const second = await submitOrUpdateReview(env as any, logger, customerId, { productSlug: TEST_PRODUCT_SLUG, rating: 5, body: 'Actually, it was excellent.' });
    expect(second.ok).toBe(true);
    expect((second as any).reviewId).toBe((first as any).reviewId); // same row, not a new one

    const row = await env.DB.prepare('SELECT rating, body, status, moderated_by AS moderatedBy FROM product_reviews WHERE id = ?')
      .bind((first as any).reviewId)
      .first<any>();
    expect(row.rating).toBe(5);
    expect(row.status).toBe('pending'); // edited content requires re-moderation
    expect(row.moderatedBy).toBeNull(); // prior moderation decision cleared

    const { results } = await env.DB.prepare('SELECT id FROM product_reviews').all();
    expect(results.length).toBe(1); // never a second row for the same (product, customer)
  });

  it('rejects a review for a nonexistent product', async () => {
    const customerId = await seedCustomer('ghost@example.com');
    const result = await submitOrUpdateReview(env as any, logger, customerId, { productSlug: 'does-not-exist', rating: 5, body: 'N/A' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('product_not_found');
  });
});

describe('listPublicReviews', () => {
  it('returns only approved reviews, never pending or rejected ones, and never exposes customer identity', async () => {
    await seedTestProduct(env as any);
    const adminId = await seedAdmin();

    const approvedCustomer = await seedCustomer('approved@example.com');
    await seedVerifiedPurchase(approvedCustomer, 'RWL-2026-700003');
    const approved = await submitOrUpdateReview(env as any, logger, approvedCustomer, { productSlug: TEST_PRODUCT_SLUG, rating: 5, body: 'Loved it.' });
    await moderateReview(env as any, logger, adminId, (approved as any).reviewId, 'approved');

    const pendingCustomer = await seedCustomer('pending@example.com');
    await seedVerifiedPurchase(pendingCustomer, 'RWL-2026-700004');
    await submitOrUpdateReview(env as any, logger, pendingCustomer, { productSlug: TEST_PRODUCT_SLUG, rating: 2, body: 'Still pending.' });

    const rejectedCustomer = await seedCustomer('rejected@example.com');
    await seedVerifiedPurchase(rejectedCustomer, 'RWL-2026-700005');
    const rejected = await submitOrUpdateReview(env as any, logger, rejectedCustomer, { productSlug: TEST_PRODUCT_SLUG, rating: 1, body: 'Rejected content.' });
    await moderateReview(env as any, logger, adminId, (rejected as any).reviewId, 'rejected');

    const result = await listPublicReviews(env as any, TEST_PRODUCT_SLUG);
    expect(result.count).toBe(1);
    expect(result.reviews[0].body).toBe('Loved it.');
    expect(result.averageRating).toBe(5);
    expect(Object.keys(result.reviews[0])).not.toContain('customerEmail');
  });

  it('computes averageRating rounded to one decimal across multiple approved reviews', async () => {
    await seedTestProduct(env as any);
    const adminId = await seedAdmin();

    for (const [email, ref, rating] of [
      ['a@example.com', 'RWL-2026-700006', 5],
      ['b@example.com', 'RWL-2026-700007', 4],
      ['c@example.com', 'RWL-2026-700008', 4],
    ] as const) {
      const customerId = await seedCustomer(email);
      await seedVerifiedPurchase(customerId, ref);
      const submitted = await submitOrUpdateReview(env as any, logger, customerId, { productSlug: TEST_PRODUCT_SLUG, rating, body: 'Review body.' });
      await moderateReview(env as any, logger, adminId, (submitted as any).reviewId, 'approved');
    }

    const result = await listPublicReviews(env as any, TEST_PRODUCT_SLUG);
    expect(result.count).toBe(3);
    expect(result.averageRating).toBe(4.3); // (5+4+4)/3 = 4.333... -> 4.3
  });

  it('returns an honest empty result, not an error, for a product with no reviews', async () => {
    await seedTestProduct(env as any);
    const result = await listPublicReviews(env as any, TEST_PRODUCT_SLUG);
    expect(result).toEqual({ reviews: [], averageRating: null, count: 0 });
  });
});

describe('listCustomerOwnReviews', () => {
  it("returns a customer's own reviews regardless of status", async () => {
    await seedTestProduct(env as any);
    const customerId = await seedCustomer('me@example.com');
    await seedVerifiedPurchase(customerId, 'RWL-2026-700009');
    await submitOrUpdateReview(env as any, logger, customerId, { productSlug: TEST_PRODUCT_SLUG, rating: 3, body: 'Mine.' });

    const reviews = await listCustomerOwnReviews(env as any, customerId);
    expect(reviews.length).toBe(1);
    expect(reviews[0].status).toBe('pending');
    expect(reviews[0].productSlug).toBe(TEST_PRODUCT_SLUG);
  });
});

describe('listReviewsForModeration / moderateReview', () => {
  it('filters by status and paginates', async () => {
    await seedTestProduct(env as any);
    const adminId = await seedAdmin();

    const customerA = await seedCustomer('mod-a@example.com');
    await seedVerifiedPurchase(customerA, 'RWL-2026-700010');
    const reviewA = await submitOrUpdateReview(env as any, logger, customerA, { productSlug: TEST_PRODUCT_SLUG, rating: 5, body: 'A' });

    const customerB = await seedCustomer('mod-b@example.com');
    await seedVerifiedPurchase(customerB, 'RWL-2026-700011');
    const reviewB = await submitOrUpdateReview(env as any, logger, customerB, { productSlug: TEST_PRODUCT_SLUG, rating: 4, body: 'B' });
    await moderateReview(env as any, logger, adminId, (reviewB as any).reviewId, 'approved');

    const pendingOnly = await listReviewsForModeration(env as any, { status: 'pending', page: 1, pageSize: 20 });
    expect(pendingOnly.items.length).toBe(1);
    expect(pendingOnly.items[0].id).toBe((reviewA as any).reviewId);

    const all = await listReviewsForModeration(env as any, { status: null, page: 1, pageSize: 20 });
    expect(all.total).toBe(2);
  });

  it('moderateReview writes an audit log entry and returns not_found for a nonexistent review', async () => {
    await seedTestProduct(env as any);
    const adminId = await seedAdmin();
    const customerId = await seedCustomer('audit@example.com');
    await seedVerifiedPurchase(customerId, 'RWL-2026-700012');
    const review = await submitOrUpdateReview(env as any, logger, customerId, { productSlug: TEST_PRODUCT_SLUG, rating: 5, body: 'Audit me.' });

    const result = await moderateReview(env as any, logger, adminId, (review as any).reviewId, 'approved');
    expect(result.ok).toBe(true);

    const audit = await env.DB.prepare(`SELECT action, actor_id AS actorId, entity_id AS entityId FROM audit_logs WHERE action = 'review.approved'`).first<any>();
    expect(audit).toBeTruthy();
    expect(audit.actorId).toBe(adminId);
    expect(audit.entityId).toBe((review as any).reviewId);

    const missing = await moderateReview(env as any, logger, adminId, 999999, 'rejected');
    expect(missing.ok).toBe(false);
  });
});
