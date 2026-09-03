/**
 * Affiliate Service: core identity, application, and admin
 * management. See backend/database/migrations/0055_affiliates.sql for
 * the full schema reasoning this file implements against.
 *
 * An affiliate IS an existing `customers` row (affiliates.customer_id
 * UNIQUE), never a second identity/auth system; this file never
 * issues a session or checks a password; every route calling into it
 * is gated by the existing requireCustomerAuth()/requireAuth()
 * middleware first, exactly like every other customer/admin module.
 *
 * Commission-percent precedence (documented once here, the single
 * source of truth other services/routes should point back to rather
 * than re-deriving): a per-(affiliate, product) row in
 * affiliate_product_rates, if one exists, wins outright; otherwise
 * affiliates.default_commission_percent applies. There is no third,
 * platform-wide fallback constant read at commission time: every
 * affiliate always has a real default_commission_percent value (set
 * at application time from DEFAULT_COMMISSION_PERCENT below, and
 * editable by admin via setDefaultCommissionRate()), so the resolution
 * never needs to fall further than that.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import * as auditService from './admin/auditService';
import { sendEmail } from './emailService';

/** The starting default_commission_percent stamped onto every new application; admin-editable per affiliate afterward via setDefaultCommissionRate(). */
export const DEFAULT_COMMISSION_PERCENT = 20;

export const CURRENT_AFFILIATE_TERMS_VERSION = '2026-09-01';

export const AFFILIATE_STATUSES = ['pending', 'approved', 'rejected', 'suspended'] as const;
export type AffiliateStatus = (typeof AFFILIATE_STATUSES)[number];

export function isValidAffiliateStatus(value: unknown): value is AffiliateStatus {
  return typeof value === 'string' && (AFFILIATE_STATUSES as readonly string[]).includes(value);
}

export interface AffiliateProfile {
  id: number;
  customerId: number;
  affiliateCode: string;
  status: AffiliateStatus;
  defaultCommissionPercent: number;
  payoutMethod: 'mobile_money' | 'bank_transfer' | null;
  payoutDetails: string | null;
  appliedAt: string;
  decidedAt: string | null;
  rejectionReason: string | null;
  suspendedReason: string | null;
}

interface AffiliateProfileRow {
  id: number;
  customerId: number;
  affiliateCode: string;
  status: string;
  defaultCommissionPercent: number;
  payoutMethod: string | null;
  payoutDetails: string | null;
  appliedAt: string;
  decidedAt: string | null;
  rejectionReason: string | null;
  suspendedReason: string | null;
}

const PROFILE_SELECT = `SELECT id, customer_id AS customerId, affiliate_code AS affiliateCode, status,
         default_commission_percent AS defaultCommissionPercent, payout_method AS payoutMethod,
         payout_details AS payoutDetails, applied_at AS appliedAt, decided_at AS decidedAt,
         rejection_reason AS rejectionReason, suspended_reason AS suspendedReason
  FROM affiliates`;

function mapProfile(row: AffiliateProfileRow): AffiliateProfile {
  return {
    id: row.id,
    customerId: row.customerId,
    affiliateCode: row.affiliateCode,
    status: row.status as AffiliateStatus,
    defaultCommissionPercent: row.defaultCommissionPercent,
    payoutMethod: row.payoutMethod as AffiliateProfile['payoutMethod'],
    payoutDetails: row.payoutDetails,
    appliedAt: row.appliedAt,
    decidedAt: row.decidedAt,
    rejectionReason: row.rejectionReason,
    suspendedReason: row.suspendedReason,
  };
}

export async function getAffiliateByCustomerId(env: Env, customerId: number): Promise<AffiliateProfile | null> {
  const row = await env.DB.prepare(`${PROFILE_SELECT} WHERE customer_id = ?`).bind(customerId).first<AffiliateProfileRow>();
  return row ? mapProfile(row) : null;
}

export async function getAffiliateById(env: Env, id: number): Promise<AffiliateProfile | null> {
  const row = await env.DB.prepare(`${PROFILE_SELECT} WHERE id = ?`).bind(id).first<AffiliateProfileRow>();
  return row ? mapProfile(row) : null;
}

/**
 * Used at attribution time (checkout-session creation) and by the
 * click-tracking endpoint: deliberately returns a row regardless of
 * status; the CALLER decides what to do with a non-'approved' status
 * (see affiliateAttributionService.ts), since "affiliate code exists
 * but isn't currently eligible" and "affiliate code doesn't exist at
 * all" are different, both-real outcomes worth distinguishing in a
 * log line even though neither ever attributes a sale.
 */
export async function getAffiliateByCode(env: Env, codeInput: unknown): Promise<AffiliateProfile | null> {
  if (typeof codeInput !== 'string') return null;
  const code = codeInput.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,24}$/.test(code)) return null;
  const row = await env.DB.prepare(`${PROFILE_SELECT} WHERE affiliate_code = ?`).bind(code).first<AffiliateProfileRow>();
  return row ? mapProfile(row) : null;
}

/**
 * Server-generated only: never client-supplied, and never the raw
 * surrogate id (a public referral URL must not leak a database id).
 * Format: an uppercase, alphanumeric-only slice of the customer's
 * email local-part (a human-recognizable prefix, matching the
 * "RWLROBERT"-style example) plus a short random suffix, retried on
 * the rare collision. Always prefixed "RWL" so a code is recognizable
 * as a Robayer WealthLab affiliate code at a glance, distinct from,
 * say, a coupon code.
 */
async function generateUniqueAffiliateCode(env: Env, emailSeed: string): Promise<string> {
  const localPart = emailSeed.split('@')[0] ?? 'AFFILIATE';
  const base = ('RWL' + localPart.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()).slice(0, 14);

  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = attempt === 0 ? '' : Math.random().toString(36).slice(2, 6).toUpperCase();
    const candidate = (base + suffix).slice(0, 20);
    const existing = await env.DB.prepare(`SELECT id FROM affiliates WHERE affiliate_code = ?`).bind(candidate).first<{ id: number }>();
    if (!existing) return candidate;
  }
  // Exhausted the friendly-prefix retries (extremely unlikely at any
  // real scale); fall back to a fully random code rather than fail
  // the application outright.
  return 'RWL' + Math.random().toString(36).slice(2, 10).toUpperCase();
}

export type ApplyForAffiliateResult =
  | { ok: true; affiliateCode: string; status: AffiliateStatus }
  | { ok: false; reason: 'already_pending' | 'already_approved' | 'suspended' };

/**
 * A customer applies (or, after an earlier rejection, re-applies;
 * the row is reused via UPDATE, never a second row, since
 * affiliates.customer_id is UNIQUE). A suspended affiliate cannot
 * self-reapply; only an admin's reactivateAffiliate() can restore
 * them, a deliberate friction point matching PHASE 10's "administrator
 * reactivation" requirement.
 */
export async function applyForAffiliate(env: Env, logger: Logger, customerId: number, customerEmail: string): Promise<ApplyForAffiliateResult> {
  const existing = await env.DB.prepare(`SELECT id, status FROM affiliates WHERE customer_id = ?`).bind(customerId).first<{ id: number; status: string }>();

  if (existing) {
    if (existing.status === 'pending') return { ok: false, reason: 'already_pending' };
    if (existing.status === 'approved') return { ok: false, reason: 'already_approved' };
    if (existing.status === 'suspended') return { ok: false, reason: 'suspended' };

    // status === 'rejected': re-apply by resetting the same row.
    const code = await generateUniqueAffiliateCode(env, customerEmail);
    await env.DB.prepare(
      `UPDATE affiliates SET status = 'pending', affiliate_code = ?, terms_accepted_at = datetime('now'), terms_version = ?,
         applied_at = datetime('now'), decided_at = NULL, decided_by = NULL, rejection_reason = NULL, updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(code, CURRENT_AFFILIATE_TERMS_VERSION, existing.id)
      .run();
    await auditService.record(env, logger, { actorType: 'customer', actorId: customerId, action: 'affiliate.reapplied', entityType: 'affiliate', entityId: existing.id, metadata: null });
    return { ok: true, affiliateCode: code, status: 'pending' };
  }

  const code = await generateUniqueAffiliateCode(env, customerEmail);
  let insert;
  try {
    insert = await env.DB.prepare(
      `INSERT INTO affiliates (customer_id, affiliate_code, status, default_commission_percent, terms_accepted_at, terms_version, applied_at, data_classification)
       VALUES (?, ?, 'pending', ?, datetime('now'), ?, datetime('now'), 'PRODUCTION')`
    )
      .bind(customerId, code, DEFAULT_COMMISSION_PERCENT, CURRENT_AFFILIATE_TERMS_VERSION)
      .run();
  } catch {
    // affiliates.customer_id UNIQUE: a genuine double-submit (two
    // near-simultaneous apply requests from the same customer, e.g. a
    // double-click before the button visually disables) loses this race
    // rather than crashing with a raw 500. The winning request already
    // created the real row; this one just reports the same "already
    // pending" outcome a sequential second call would.
    return { ok: false, reason: 'already_pending' };
  }

  const id = Number(insert.meta.last_row_id);
  await auditService.record(env, logger, { actorType: 'customer', actorId: customerId, action: 'affiliate.applied', entityType: 'affiliate', entityId: id, metadata: null });
  return { ok: true, affiliateCode: code, status: 'pending' };
}

// ============================================================
// Commission-rate resolution
// ============================================================

/** See this file's own header comment for the full precedence explanation. */
export async function resolveCommissionPercent(env: Env, affiliateId: number, productId: number): Promise<number> {
  const override = await env.DB.prepare(`SELECT commission_percent AS pct FROM affiliate_product_rates WHERE affiliate_id = ? AND product_id = ?`)
    .bind(affiliateId, productId)
    .first<{ pct: number }>();
  if (override) return override.pct;

  const affiliate = await env.DB.prepare(`SELECT default_commission_percent AS pct FROM affiliates WHERE id = ?`).bind(affiliateId).first<{ pct: number }>();
  return affiliate?.pct ?? DEFAULT_COMMISSION_PERCENT;
}

// ============================================================
// Admin: moderation / status transitions / rate management
// ============================================================

export type ModerateResult = { ok: true } | { ok: false; reason: 'not_found' | 'invalid_state' };

export async function moderateApplication(
  env: Env,
  logger: Logger,
  adminId: number,
  affiliateId: number,
  decision: 'approved' | 'rejected',
  rejectionReason: string | null
): Promise<ModerateResult> {
  const result = await env.DB.prepare(
    `UPDATE affiliates SET status = ?, decided_at = datetime('now'), decided_by = ?, rejection_reason = ?, updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'`
  )
    .bind(decision, adminId, decision === 'rejected' ? rejectionReason : null, affiliateId)
    .run();

  if (result.meta.changes !== 1) {
    const exists = await env.DB.prepare(`SELECT id FROM affiliates WHERE id = ?`).bind(affiliateId).first<{ id: number }>();
    return { ok: false, reason: exists ? 'invalid_state' : 'not_found' };
  }

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId: adminId,
    action: decision === 'approved' ? 'affiliate.approved' : 'affiliate.rejected',
    entityType: 'affiliate',
    entityId: affiliateId,
    metadata: decision === 'rejected' ? { reason: rejectionReason } : null,
  });

  // Never blocks/reverses the decision above if the send fails, same
  // "log, don't throw" discipline emailService.ts's own sendEmail()
  // already guarantees for every other caller in this codebase.
  const row = await env.DB.prepare(`SELECT c.email AS email, a.affiliate_code AS affiliateCode FROM affiliates a JOIN customers c ON c.id = a.customer_id WHERE a.id = ?`)
    .bind(affiliateId)
    .first<{ email: string; affiliateCode: string }>();
  if (row) {
    if (decision === 'approved') {
      await sendEmail(env, logger, {
        template: 'affiliate-application-approved',
        to: row.email,
        data: { affiliateCode: row.affiliateCode, dashboardUrl: `${env.SITE_BASE_URL}/affiliate/` },
        entityType: 'affiliate',
        entityId: affiliateId,
      });
    } else {
      await sendEmail(env, logger, {
        template: 'affiliate-application-rejected',
        to: row.email,
        data: { reason: rejectionReason ?? "This doesn't reflect on you personally. We're being selective as the programme grows." },
        entityType: 'affiliate',
        entityId: affiliateId,
      });
    }
  }

  return { ok: true };
}

export async function suspendAffiliate(env: Env, logger: Logger, adminId: number, affiliateId: number, reason: string): Promise<ModerateResult> {
  const result = await env.DB.prepare(
    `UPDATE affiliates SET status = 'suspended', suspended_at = datetime('now'), suspended_reason = ?, updated_at = datetime('now')
     WHERE id = ? AND status = 'approved'`
  )
    .bind(reason, affiliateId)
    .run();
  if (result.meta.changes !== 1) {
    const exists = await env.DB.prepare(`SELECT id FROM affiliates WHERE id = ?`).bind(affiliateId).first<{ id: number }>();
    return { ok: false, reason: exists ? 'invalid_state' : 'not_found' };
  }
  await auditService.record(env, logger, { actorType: 'admin', actorId: adminId, action: 'affiliate.suspended', entityType: 'affiliate', entityId: affiliateId, metadata: { reason } });
  return { ok: true };
}

export async function reactivateAffiliate(env: Env, logger: Logger, adminId: number, affiliateId: number): Promise<ModerateResult> {
  const result = await env.DB.prepare(
    `UPDATE affiliates SET status = 'approved', reactivated_at = datetime('now'), suspended_reason = NULL, updated_at = datetime('now')
     WHERE id = ? AND status = 'suspended'`
  )
    .bind(affiliateId)
    .run();
  if (result.meta.changes !== 1) {
    const exists = await env.DB.prepare(`SELECT id FROM affiliates WHERE id = ?`).bind(affiliateId).first<{ id: number }>();
    return { ok: false, reason: exists ? 'invalid_state' : 'not_found' };
  }
  await auditService.record(env, logger, { actorType: 'admin', actorId: adminId, action: 'affiliate.reactivated', entityType: 'affiliate', entityId: affiliateId, metadata: null });
  return { ok: true };
}

export type SetRateResult = { ok: true } | { ok: false; reason: 'not_found' | 'invalid_percent' | 'product_not_found' };

export async function setDefaultCommissionRate(env: Env, logger: Logger, adminId: number, affiliateId: number, percent: number): Promise<SetRateResult> {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return { ok: false, reason: 'invalid_percent' };
  const result = await env.DB.prepare(`UPDATE affiliates SET default_commission_percent = ?, updated_at = datetime('now') WHERE id = ?`).bind(percent, affiliateId).run();
  if (result.meta.changes !== 1) return { ok: false, reason: 'not_found' };
  await auditService.record(env, logger, { actorType: 'admin', actorId: adminId, action: 'affiliate.default_rate_set', entityType: 'affiliate', entityId: affiliateId, metadata: { percent } });
  return { ok: true };
}

export async function setProductCommissionRate(env: Env, logger: Logger, adminId: number, affiliateId: number, productSlug: string, percent: number): Promise<SetRateResult> {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return { ok: false, reason: 'invalid_percent' };
  const affiliate = await env.DB.prepare(`SELECT id FROM affiliates WHERE id = ?`).bind(affiliateId).first<{ id: number }>();
  if (!affiliate) return { ok: false, reason: 'not_found' };
  const product = await env.DB.prepare(`SELECT id FROM products WHERE slug = ? AND deleted_at IS NULL`).bind(productSlug).first<{ id: number }>();
  if (!product) return { ok: false, reason: 'product_not_found' };

  await env.DB.prepare(
    `INSERT INTO affiliate_product_rates (affiliate_id, product_id, commission_percent, set_by, data_classification)
     VALUES (?, ?, ?, ?, 'PRODUCTION')
     ON CONFLICT(affiliate_id, product_id) DO UPDATE SET commission_percent = excluded.commission_percent, set_by = excluded.set_by, updated_at = datetime('now')`
  )
    .bind(affiliateId, product.id, percent, adminId)
    .run();

  await auditService.record(env, logger, { actorType: 'admin', actorId: adminId, action: 'affiliate.product_rate_set', entityType: 'affiliate', entityId: affiliateId, metadata: { productSlug, percent } });
  return { ok: true };
}

// ============================================================
// Admin: listing / detail
// ============================================================

export interface AdminAffiliateListItem {
  id: number;
  affiliateCode: string;
  status: AffiliateStatus;
  customerEmail: string;
  defaultCommissionPercent: number;
  appliedAt: string;
  decidedAt: string | null;
}

interface AdminAffiliateListRow extends Omit<AdminAffiliateListItem, 'status'> {
  status: string;
}

export async function listAffiliates(
  env: Env,
  filter: { status?: AffiliateStatus; search?: string },
  page: number,
  pageSize: number
): Promise<{ items: AdminAffiliateListItem[]; total: number; page: number; pageSize: number }> {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (filter.status) {
    conditions.push('a.status = ?');
    bindings.push(filter.status);
  }
  if (filter.search) {
    conditions.push('(c.email LIKE ? OR a.affiliate_code LIKE ?)');
    const like = `%${filter.search}%`;
    bindings.push(like, like);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * pageSize;

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(
      `SELECT a.id, a.affiliate_code AS affiliateCode, a.status, c.email AS customerEmail,
              a.default_commission_percent AS defaultCommissionPercent, a.applied_at AS appliedAt, a.decided_at AS decidedAt
       FROM affiliates a JOIN customers c ON c.id = a.customer_id
       ${where}
       ORDER BY a.id DESC LIMIT ? OFFSET ?`
    )
      .bind(...bindings, pageSize, offset)
      .all<AdminAffiliateListRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM affiliates a JOIN customers c ON c.id = a.customer_id ${where}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);

  return {
    items: rows.results.map((r) => ({ ...r, status: r.status as AffiliateStatus })),
    total: countRow?.total ?? 0,
    page,
    pageSize,
  };
}

export interface AdminAffiliateDetail extends AdminAffiliateListItem {
  payoutMethod: string | null;
  productRates: Array<{ productSlug: string; productTitle: string; commissionPercent: number }>;
  totals: { clicks: number; conversions: number; grossPesewas: number; commissionPesewas: number; paidPesewas: number; payablePesewas: number };
}

export async function getAffiliateDetail(env: Env, affiliateId: number): Promise<AdminAffiliateDetail | null> {
  const base = await env.DB.prepare(
    `SELECT a.id, a.affiliate_code AS affiliateCode, a.status, c.email AS customerEmail,
            a.default_commission_percent AS defaultCommissionPercent, a.payout_method AS payoutMethod,
            a.applied_at AS appliedAt, a.decided_at AS decidedAt
     FROM affiliates a JOIN customers c ON c.id = a.customer_id WHERE a.id = ?`
  )
    .bind(affiliateId)
    .first<AdminAffiliateListRow & { payoutMethod: string | null }>();
  if (!base) return null;

  const [rates, clicksRow, commissionTotals] = await Promise.all([
    env.DB.prepare(
      `SELECT p.slug AS productSlug, p.title AS productTitle, r.commission_percent AS commissionPercent
       FROM affiliate_product_rates r JOIN products p ON p.id = r.product_id WHERE r.affiliate_id = ?`
    )
      .bind(affiliateId)
      .all<{ productSlug: string; productTitle: string; commissionPercent: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS clicks FROM affiliate_clicks WHERE affiliate_id = ?`).bind(affiliateId).first<{ clicks: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS conversions, COALESCE(SUM(gross_pesewas), 0) AS grossPesewas, COALESCE(SUM(commission_pesewas), 0) AS commissionPesewas,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_pesewas ELSE 0 END), 0) AS paidPesewas,
              COALESCE(SUM(CASE WHEN status = 'payable' THEN commission_pesewas ELSE 0 END), 0) AS payablePesewas
       FROM affiliate_commissions WHERE affiliate_id = ? AND status != 'reversed'`
    )
      .bind(affiliateId)
      .first<{ conversions: number; grossPesewas: number; commissionPesewas: number; paidPesewas: number; payablePesewas: number }>(),
  ]);

  return {
    ...base,
    status: base.status as AffiliateStatus,
    productRates: rates.results,
    totals: {
      clicks: clicksRow?.clicks ?? 0,
      conversions: commissionTotals?.conversions ?? 0,
      grossPesewas: commissionTotals?.grossPesewas ?? 0,
      commissionPesewas: commissionTotals?.commissionPesewas ?? 0,
      paidPesewas: commissionTotals?.paidPesewas ?? 0,
      payablePesewas: commissionTotals?.payablePesewas ?? 0,
    },
  };
}
