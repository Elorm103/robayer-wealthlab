/**
 * Coupon Service — Version 3.2 Milestone M4 (Commerce & Trust
 * Foundations). See migration 0020_reviews_and_coupons.sql and
 * docs/v3.2-m4c-amendment-2-coupon-security-review.md for the full
 * threat model this file implements.
 *
 * Platform-wide coupons only — no creator/marketplace scope, per the
 * M4B-mandated schema correction (docs/v3.2-m4c-amendment-1-resolution.md).
 *
 * Two-phase redemption discipline, deliberately:
 *   1. validateCoupon() — a soft, non-mutating check, called at
 *      checkout-session creation (before any payment) AND again by the
 *      discount-preview endpoint. Computes the discount, never mutates
 *      redemptions_count.
 *   2. redeemCoupon() — called ONLY after commerceService.ts's webhook
 *      handler has confirmed a real payment (verifySessionAtomic()
 *      already succeeded). Atomically increments redemptions_count,
 *      gated on the limit; always records a coupon_redemptions audit
 *      row regardless of whether the atomic increment won, since the
 *      discount was already genuinely charged either way — this
 *      service never reverses or denies an already-completed payment.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import * as auditService from './admin/auditService';

export function isValidDiscountType(value: unknown): value is 'percentage' | 'fixed' {
  return value === 'percentage' || value === 'fixed';
}

interface CouponRow {
  id: number;
  code: string;
  productId: number | null;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  maxRedemptions: number | null;
  redemptionsCount: number;
  firstPurchaseOnly: number;
  startsAt: string | null;
  expiresAt: string | null;
  status: string;
}

async function findActiveCouponByCode(env: Env, code: string): Promise<CouponRow | null> {
  return env.DB.prepare(
    `SELECT id, code, product_id AS productId, discount_type AS discountType, discount_value AS discountValue,
            max_redemptions AS maxRedemptions, redemptions_count AS redemptionsCount, first_purchase_only AS firstPurchaseOnly,
            starts_at AS startsAt, expires_at AS expiresAt, status
     FROM coupons WHERE code = ?`
  )
    .bind(code)
    .first<CouponRow>();
}

/** Server-computed only — never trust a client-supplied discount amount. Fixed discounts are capped at the purchase amount so a discount can never make the charge negative. */
export function computeDiscountPesewas(discountType: 'percentage' | 'fixed', discountValue: number, amountPesewas: number): number {
  if (discountType === 'percentage') {
    return Math.min(amountPesewas, Math.round((amountPesewas * discountValue) / 100));
  }
  return Math.min(amountPesewas, discountValue);
}

export type ValidateCouponResult =
  | { valid: true; couponId: number; discountPesewas: number; finalAmountPesewas: number }
  | { valid: false; reason: 'not_found' | 'inactive' | 'not_started' | 'expired' | 'product_mismatch' | 'redemption_limit_reached' };

/**
 * Non-mutating. Called both by the discount-preview endpoint (before a
 * checkout even starts) and by createCheckoutSession() (immediately
 * before locking the discounted amount). `redemptions_count <
 * max_redemptions` here is a soft, best-effort check — the atomic,
 * authoritative check happens only in redeemCoupon(), after payment.
 * See the security review's "Redemption-limit race" section for why
 * this two-phase design is deliberate, not a gap.
 */
export async function validateCoupon(env: Env, codeInput: unknown, productSlug: string, amountPesewas: number): Promise<ValidateCouponResult> {
  if (typeof codeInput !== 'string' || codeInput.trim().length === 0 || codeInput.length > 64) {
    return { valid: false, reason: 'not_found' };
  }
  const code = codeInput.trim().toUpperCase();

  const coupon = await findActiveCouponByCode(env, code);
  if (!coupon) return { valid: false, reason: 'not_found' };
  if (coupon.status !== 'active') return { valid: false, reason: 'inactive' };

  const now = new Date().toISOString();
  if (coupon.startsAt && coupon.startsAt > now) return { valid: false, reason: 'not_started' };
  if (coupon.expiresAt && coupon.expiresAt < now) return { valid: false, reason: 'expired' };

  if (coupon.productId !== null) {
    const product = await env.DB.prepare(`SELECT id FROM products WHERE slug = ? AND deleted_at IS NULL`).bind(productSlug).first<{ id: number }>();
    if (!product || product.id !== coupon.productId) return { valid: false, reason: 'product_mismatch' };
  }

  if (coupon.maxRedemptions !== null && coupon.redemptionsCount >= coupon.maxRedemptions) {
    return { valid: false, reason: 'redemption_limit_reached' };
  }

  const discountPesewas = computeDiscountPesewas(coupon.discountType, coupon.discountValue, amountPesewas);
  return { valid: true, couponId: coupon.id, discountPesewas, finalAmountPesewas: amountPesewas - discountPesewas };
}

export interface RedeemCouponResult {
  recorded: boolean;
  limitEnforced: boolean;
}

/**
 * Called only after a real payment has been confirmed
 * (commerceService.ts's handlePaymentWebhook(), immediately after
 * verifySessionAtomic() succeeds). Always records the redemption (the
 * discount was genuinely applied and charged); the redemptions_count
 * increment is a separate, best-effort atomic operation whose failure
 * is logged, never treated as a reason to undo the payment. See the
 * security review's "Redemption-limit race" section.
 */
export async function redeemCoupon(
  env: Env,
  logger: Logger,
  couponId: number,
  purchaseSessionId: number,
  customerEmail: string,
  discountPesewas: number
): Promise<RedeemCouponResult> {
  const incrementResult = await env.DB.prepare(
    `UPDATE coupons SET redemptions_count = redemptions_count + 1, updated_at = datetime('now')
     WHERE id = ? AND (max_redemptions IS NULL OR redemptions_count < max_redemptions)`
  )
    .bind(couponId)
    .run();
  const limitEnforced = incrementResult.meta.changes === 1;

  if (!limitEnforced) {
    logger.error('coupon.redemption_limit_race', { couponId, purchaseSessionId, reason: 'max_redemptions_already_reached_but_payment_already_succeeded' });
  }

  try {
    await env.DB.prepare(
      // Forensic-audit fix (2026-08-28): inherits the COUPON's own
      // classification, not the purchase_session's — matching migration
      // 0029's own established precedent (TRIAL2/TRIAL3's redemptions
      // are DEVELOPMENT even though the purchase_sessions that redeemed
      // them are INTERNAL; a redemption record's meaning is "this coupon
      // was used," judged by what kind of coupon it was).
      `INSERT INTO coupon_redemptions (coupon_id, purchase_session_id, customer_email, discount_pesewas, data_classification)
       VALUES (?, ?, ?, ?, (SELECT data_classification FROM coupons WHERE id = ?))`
    )
      .bind(couponId, purchaseSessionId, customerEmail, discountPesewas, couponId)
      .run();
  } catch (err) {
    // UNIQUE(purchase_session_id) — should never fire in practice (each
    // purchase_sessions row is only ever verified once, per the
    // webhook's own idempotency layers), but never let a duplicate-key
    // error here undo an already-recorded payment.
    logger.error('coupon.redemption_record_failed', { couponId, purchaseSessionId, error: err instanceof Error ? err.message : String(err) });
    return { recorded: false, limitEnforced };
  }

  logger.info('coupon.redeemed', { couponId, purchaseSessionId, discountPesewas, limitEnforced });
  return { recorded: true, limitEnforced };
}

/**
 * Best-effort, detection-only check for the first_purchase_only flag —
 * cannot be enforced before payment in a guest-checkout system (the
 * customer's email isn't known until Paystack confirms it). Called
 * after customer provisioning resolves a real identity; logs an
 * anomaly if violated, never denies or reverses the already-completed
 * payment. See the security review's "first_purchase_only enforcement"
 * section — this mirrors the ARB's own prior, explicit acceptance of
 * this exact risk category.
 */
export async function checkFirstPurchaseOnlyViolation(env: Env, logger: Logger, couponId: number, customerId: number, currentPurchaseSessionId: number): Promise<void> {
  const coupon = await env.DB.prepare(`SELECT first_purchase_only AS firstPurchaseOnly FROM coupons WHERE id = ?`).bind(couponId).first<{ firstPurchaseOnly: number }>();
  if (!coupon || coupon.firstPurchaseOnly !== 1) return;

  const priorPurchase = await env.DB.prepare(
    `SELECT id FROM purchase_sessions WHERE customer_id = ? AND status = 'verified' AND id != ? LIMIT 1`
  )
    .bind(customerId, currentPurchaseSessionId)
    .first<{ id: number }>();

  if (priorPurchase) {
    logger.error('coupon.first_purchase_only_violated', { couponId, customerId, currentPurchaseSessionId, priorPurchaseSessionId: priorPurchase.id });
  }
}

// ============================================================
// Admin CRUD
// ============================================================

export const COUPON_STATUSES = ['active', 'disabled', 'expired'] as const;
export type CouponStatus = (typeof COUPON_STATUSES)[number];

export function isValidCouponStatus(value: unknown): value is CouponStatus {
  return typeof value === 'string' && (COUPON_STATUSES as readonly string[]).includes(value);
}

export interface AdminCouponListItem {
  id: number;
  code: string;
  productSlug: string | null;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  maxRedemptions: number | null;
  redemptionsCount: number;
  firstPurchaseOnly: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  status: CouponStatus;
  createdAt: string;
}

interface AdminCouponRow {
  id: number;
  code: string;
  productSlug: string | null;
  discountType: string;
  discountValue: number;
  maxRedemptions: number | null;
  redemptionsCount: number;
  firstPurchaseOnly: number;
  startsAt: string | null;
  expiresAt: string | null;
  status: string;
  createdAt: string;
}

function mapAdminRow(row: AdminCouponRow): AdminCouponListItem {
  return {
    id: row.id,
    code: row.code,
    productSlug: row.productSlug,
    discountType: row.discountType as 'percentage' | 'fixed',
    discountValue: row.discountValue,
    maxRedemptions: row.maxRedemptions,
    redemptionsCount: row.redemptionsCount,
    firstPurchaseOnly: row.firstPurchaseOnly === 1,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    status: row.status as CouponStatus,
    createdAt: row.createdAt,
  };
}

export async function listCoupons(env: Env, page: number, pageSize: number): Promise<{ items: AdminCouponListItem[]; total: number; page: number; pageSize: number }> {
  const offset = (page - 1) * pageSize;
  const [rows, countRow] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id, c.code, p.slug AS productSlug, c.discount_type AS discountType, c.discount_value AS discountValue,
              c.max_redemptions AS maxRedemptions, c.redemptions_count AS redemptionsCount, c.first_purchase_only AS firstPurchaseOnly,
              c.starts_at AS startsAt, c.expires_at AS expiresAt, c.status, c.created_at AS createdAt
       FROM coupons c
       LEFT JOIN products p ON p.id = c.product_id
       ORDER BY c.id DESC LIMIT ? OFFSET ?`
    )
      .bind(pageSize, offset)
      .all<AdminCouponRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM coupons`).first<{ total: number }>(),
  ]);
  return { items: rows.results.map(mapAdminRow), total: countRow?.total ?? 0, page, pageSize };
}

export interface CreateCouponInput {
  code: string;
  productSlug: string | null;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  maxRedemptions: number | null;
  firstPurchaseOnly: boolean;
  startsAt: string | null;
  expiresAt: string | null;
}

export type CreateCouponResult = { ok: true; id: number } | { ok: false; reason: 'invalid_input' | 'duplicate_code' | 'product_not_found' };

function isValidCouponCode(value: string): boolean {
  return /^[A-Z0-9_-]{3,32}$/.test(value);
}

export async function createCoupon(env: Env, logger: Logger, actorId: number, input: CreateCouponInput): Promise<CreateCouponResult> {
  const code = input.code.trim().toUpperCase();
  if (!isValidCouponCode(code)) return { ok: false, reason: 'invalid_input' };
  if (!Number.isInteger(input.discountValue) || input.discountValue <= 0) return { ok: false, reason: 'invalid_input' };
  if (input.discountType === 'percentage' && input.discountValue > 100) return { ok: false, reason: 'invalid_input' };
  if (input.maxRedemptions !== null && (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions <= 0)) return { ok: false, reason: 'invalid_input' };

  let productId: number | null = null;
  if (input.productSlug) {
    const product = await env.DB.prepare(`SELECT id FROM products WHERE slug = ? AND deleted_at IS NULL`).bind(input.productSlug).first<{ id: number }>();
    if (!product) return { ok: false, reason: 'product_not_found' };
    productId = product.id;
  }

  const existing = await env.DB.prepare(`SELECT id FROM coupons WHERE code = ?`).bind(code).first<{ id: number }>();
  if (existing) return { ok: false, reason: 'duplicate_code' };

  const insert = await env.DB.prepare(
    // Forensic-audit fix (2026-08-28): unlike purchase_sessions (created
    // by anonymous public traffic, some against a test Paystack key), a
    // coupon only ever gets created by a real authenticated admin
    // through this one production admin panel — there is no "test
    // environment" for this insert to distinguish. Defaults to
    // PRODUCTION, matching migration 0029's own treatment of
    // products/resources ("no ambiguity ... classify PRODUCTION
    // unconditionally"). A genuine test/internal coupon (e.g. TRIAL2,
    // NALIA1) still needs the same human-judgment reclassification pass
    // 0029/0047/0048 already established — that distinction isn't
    // mechanically knowable at creation time.
    `INSERT INTO coupons (code, product_id, discount_type, discount_value, max_redemptions, first_purchase_only, starts_at, expires_at, created_by, data_classification)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PRODUCTION')`
  )
    .bind(code, productId, input.discountType, input.discountValue, input.maxRedemptions, input.firstPurchaseOnly ? 1 : 0, input.startsAt, input.expiresAt, actorId)
    .run();

  const id = Number(insert.meta.last_row_id);
  await auditService.record(env, logger, { actorType: 'admin', actorId, action: 'coupon.created', entityType: 'coupon', entityId: id, metadata: { code } });
  return { ok: true, id };
}

export type UpdateCouponResult = { ok: true } | { ok: false; reason: 'not_found' | 'invalid_input' };

/** Only status, max_redemptions, and expires_at are editable after creation — code/discount/product are immutable once a coupon may already have been shown to a customer (changing a discount's meaning after the fact would be confusing/exploitable). */
export async function updateCoupon(env: Env, logger: Logger, actorId: number, id: number, input: { status?: CouponStatus; maxRedemptions?: number | null; expiresAt?: string | null }): Promise<UpdateCouponResult> {
  const existing = await env.DB.prepare(`SELECT id FROM coupons WHERE id = ?`).bind(id).first<{ id: number }>();
  if (!existing) return { ok: false, reason: 'not_found' };

  if (input.maxRedemptions !== undefined && input.maxRedemptions !== null && (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions <= 0)) {
    return { ok: false, reason: 'invalid_input' };
  }

  const sets: string[] = [];
  const bindings: unknown[] = [];
  if (input.status !== undefined) {
    sets.push('status = ?');
    bindings.push(input.status);
  }
  if (input.maxRedemptions !== undefined) {
    sets.push('max_redemptions = ?');
    bindings.push(input.maxRedemptions);
  }
  if (input.expiresAt !== undefined) {
    sets.push('expires_at = ?');
    bindings.push(input.expiresAt);
  }
  if (sets.length === 0) return { ok: true };

  sets.push("updated_at = datetime('now')");
  await env.DB.prepare(`UPDATE coupons SET ${sets.join(', ')} WHERE id = ?`).bind(...bindings, id).run();

  await auditService.record(env, logger, { actorType: 'admin', actorId, action: 'coupon.updated', entityType: 'coupon', entityId: id, metadata: input });
  return { ok: true };
}
