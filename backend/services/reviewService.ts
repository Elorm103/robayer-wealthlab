/**
 * Review Service — Version 3.2 Milestone M4 (Commerce & Trust
 * Foundations). See docs/v3.2-m4-scope-recommendation.md and migration
 * 0020_reviews_and_coupons.sql.
 *
 * Purchase-gated by construction, not by trusting a client-supplied
 * purchase reference: submitOrUpdateReview() looks up the customer's
 * own most recent verified purchase_sessions row for the target
 * product server-side — the same "never trust the client for what
 * matters" discipline commerceService.ts already applies to price.
 * No review can ever be created without a real, owned, verified
 * purchase to back it.
 *
 * One review per (product, customer), enforced at the database layer
 * (product_reviews.UNIQUE(product_id, customer_id)) — a repurchase or
 * a re-submission edits the existing row via a single atomic
 * `INSERT ... ON CONFLICT DO UPDATE`, never a separate check-then-write
 * race. Editing a review resets it to 'pending' — the content changed,
 * so it must be re-moderated, matching this codebase's existing
 * "moderation reflects current content" expectation for every other
 * admin-reviewed surface.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import * as auditService from './admin/auditService';

const MAX_BODY_LENGTH = 3000;

export function isValidRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

export function isValidReviewBody(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= MAX_BODY_LENGTH;
}

export interface SubmitReviewInput {
  productSlug: string;
  rating: number;
  body: string;
}

export type SubmitReviewResult =
  | { ok: true; reviewId: number }
  | { ok: false; reason: 'product_not_found' }
  | { ok: false; reason: 'no_verified_purchase' };

/**
 * Resolves the customer's own latest verified purchase for this
 * product server-side — the client never supplies a purchase
 * reference. Upserts via ON CONFLICT so a repurchase/re-submission is
 * a single atomic statement, not a check-then-branch race.
 */
export async function submitOrUpdateReview(env: Env, logger: Logger, customerId: number, input: SubmitReviewInput): Promise<SubmitReviewResult> {
  const product = await env.DB.prepare(`SELECT id FROM products WHERE slug = ? AND deleted_at IS NULL`).bind(input.productSlug).first<{ id: number }>();
  if (!product) return { ok: false, reason: 'product_not_found' };

  const purchase = await env.DB.prepare(
    `SELECT id FROM purchase_sessions WHERE customer_id = ? AND product_slug = ? AND status = 'verified' ORDER BY id DESC LIMIT 1`
  )
    .bind(customerId, input.productSlug)
    .first<{ id: number }>();
  if (!purchase) return { ok: false, reason: 'no_verified_purchase' };

  const result = await env.DB.prepare(
    `INSERT INTO product_reviews (product_id, customer_id, purchase_session_id, rating, body, status)
     VALUES (?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(product_id, customer_id) DO UPDATE SET
       purchase_session_id = excluded.purchase_session_id,
       rating = excluded.rating,
       body = excluded.body,
       status = 'pending',
       moderated_by = NULL,
       moderated_at = NULL,
       updated_at = datetime('now')`
  )
    .bind(product.id, customerId, purchase.id, input.rating, input.body.trim())
    .run();

  const row = await env.DB.prepare(`SELECT id FROM product_reviews WHERE product_id = ? AND customer_id = ?`)
    .bind(product.id, customerId)
    .first<{ id: number }>();

  logger.info('review.submitted', { productId: product.id, customerId, reviewId: row?.id, changes: result.meta.changes });

  return { ok: true, reviewId: row!.id };
}

export interface CustomerOwnReview {
  id: number;
  productSlug: string;
  productTitle: string;
  rating: number;
  body: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  updatedAt: string;
}

/** A customer's own reviews (any status) — used by the dashboard "My Reviews" view, distinct from the public, approved-only listing below. */
export async function listCustomerOwnReviews(env: Env, customerId: number): Promise<CustomerOwnReview[]> {
  const { results } = await env.DB.prepare(
    `SELECT pr.id, p.slug AS productSlug, p.title AS productTitle, pr.rating, pr.body, pr.status, pr.created_at AS createdAt, pr.updated_at AS updatedAt
     FROM product_reviews pr
     JOIN products p ON p.id = pr.product_id
     WHERE pr.customer_id = ?
     ORDER BY pr.id DESC`
  )
    .bind(customerId)
    .all<CustomerOwnReview>();
  return results;
}

export interface PublicReview {
  id: number;
  rating: number;
  body: string;
  createdAt: string;
}

export interface PublicReviewsResult {
  reviews: PublicReview[];
  averageRating: number | null;
  count: number;
}

/** Approved-only, public — never exposes customer identity (no name/email), matching this project's general "no unnecessary customer PII on public pages" posture. */
export async function listPublicReviews(env: Env, productSlug: string): Promise<PublicReviewsResult> {
  const product = await env.DB.prepare(`SELECT id FROM products WHERE slug = ? AND deleted_at IS NULL`).bind(productSlug).first<{ id: number }>();
  if (!product) return { reviews: [], averageRating: null, count: 0 };

  const { results } = await env.DB.prepare(
    `SELECT id, rating, body, created_at AS createdAt FROM product_reviews WHERE product_id = ? AND status = 'approved' ORDER BY id DESC`
  )
    .bind(product.id)
    .all<PublicReview>();

  const count = results.length;
  const averageRating = count > 0 ? Math.round((results.reduce((sum, r) => sum + r.rating, 0) / count) * 10) / 10 : null;

  return { reviews: results, averageRating, count };
}

export interface ReviewSummary {
  averageRating: number | null;
  count: number;
}

/**
 * Version 3.4.2 Milestone M6.2 (Product Cards) - a single-aggregate-query
 * summary for product cards and the book detail header, which only ever
 * need the star rating and count, never the review bodies. Kept
 * separate from listPublicReviews() above rather than having callers
 * throw away its full review list, since a product grid calling this
 * once per card would otherwise also be pulling every review's full
 * text for every product on the page.
 */
export async function getReviewSummary(env: Env, productId: number): Promise<ReviewSummary> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count, AVG(rating) AS avg FROM product_reviews WHERE product_id = ? AND status = 'approved'`
  )
    .bind(productId)
    .first<{ count: number; avg: number | null }>();
  const count = row?.count ?? 0;
  return { count, averageRating: count > 0 && row?.avg != null ? Math.round(row.avg * 10) / 10 : null };
}

// ============================================================
// Admin moderation
// ============================================================

export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export function isValidReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === 'string' && (REVIEW_STATUSES as readonly string[]).includes(value);
}

export interface AdminReviewListItem {
  id: number;
  productSlug: string;
  productTitle: string;
  customerEmail: string;
  rating: number;
  body: string;
  status: ReviewStatus;
  createdAt: string;
}

export interface ListReviewsForModerationQuery {
  status: ReviewStatus | null;
  page: number;
  pageSize: number;
}

export interface ListReviewsForModerationResult {
  items: AdminReviewListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listReviewsForModeration(env: Env, query: ListReviewsForModerationQuery): Promise<ListReviewsForModerationResult> {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (query.status) {
    conditions.push('pr.status = ?');
    bindings.push(query.status);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (query.page - 1) * query.pageSize;

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(
      `SELECT pr.id, p.slug AS productSlug, p.title AS productTitle, c.email AS customerEmail, pr.rating, pr.body, pr.status, pr.created_at AS createdAt
       FROM product_reviews pr
       JOIN products p ON p.id = pr.product_id
       JOIN customers c ON c.id = pr.customer_id
       ${whereClause}
       ORDER BY pr.created_at DESC LIMIT ? OFFSET ?`
    )
      .bind(...bindings, query.pageSize, offset)
      .all<AdminReviewListItem>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM product_reviews pr ${whereClause}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);

  return { items: rows.results, total: countRow?.total ?? 0, page: query.page, pageSize: query.pageSize };
}

export type ModerateReviewResult = { ok: true } | { ok: false; reason: 'not_found' };

export async function moderateReview(env: Env, logger: Logger, actorId: number, id: number, status: 'approved' | 'rejected'): Promise<ModerateReviewResult> {
  const result = await env.DB.prepare(
    `UPDATE product_reviews SET status = ?, moderated_by = ?, moderated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  )
    .bind(status, actorId, id)
    .run();

  if (result.meta.changes !== 1) return { ok: false, reason: 'not_found' };

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: status === 'approved' ? 'review.approved' : 'review.rejected',
    entityType: 'product_review',
    entityId: id,
  });

  return { ok: true };
}
