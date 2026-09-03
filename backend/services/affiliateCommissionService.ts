/**
 * Affiliate Commission Service: the commission lifecycle:
 * pending -> approved -> payable -> paid, with reversed available from
 * any pre-paid state. See backend/database/migrations/0055_affiliates.sql
 * for the schema this implements against, and couponService.ts's
 * redeemCoupon() for the proven two-phase discipline this mirrors:
 * commission is only ever WRITTEN from the payment-verification path
 * (never at checkout-session creation, which can be abandoned), it is
 * idempotent (UNIQUE(purchase_session_id); a duplicate write is
 * caught and logged, never allowed to throw back into the payment
 * flow), and it never reverses or blocks an already-successful
 * payment.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import * as auditService from './admin/auditService';

export const AFFILIATE_COMMISSION_STATUSES = ['pending', 'approved', 'payable', 'paid', 'reversed'] as const;
export type AffiliateCommissionStatus = (typeof AFFILIATE_COMMISSION_STATUSES)[number];

export interface RecordCommissionInput {
  purchaseSessionId: number;
  affiliateId: number;
  commissionPercent: number;
  /** The actual amount the customer paid (already net of any coupon discount): purchase_sessions.amount_pesewas, never a pre-discount price. */
  grossPesewas: number;
  productId: number;
  /** The customer_id resolved by commerceService.ts's findOrCreateCustomer() moments earlier in the SAME verification pass: the authoritative self-referral check, distinct from and stronger than affiliateAttributionService.ts's checkout-time email heuristic. */
  purchasingCustomerId: number | null;
}

export type RecordCommissionResult =
  | { recorded: true; commissionId: number; commissionPesewas: number }
  | { recorded: false; reason: 'self_referral' | 'duplicate' | 'affiliate_not_eligible' };

/**
 * Called exactly once per successful verification, from
 * commerceService.ts's completeVerifiedPurchase(); see that
 * function's own updated comment for the exact call site. Never
 * throws: every failure mode here is a business outcome (self-
 * referral, a since-suspended affiliate, a duplicate re-entry) logged
 * and returned, not an exception that could interrupt fulfilment.
 */
export async function recordCommission(env: Env, logger: Logger, input: RecordCommissionInput): Promise<RecordCommissionResult> {
  // Authoritative self-referral check: re-verified here against the
  // REAL resolved customer identity (unlike the checkout-time email
  // heuristic in affiliateAttributionService.ts, which has no real
  // customer_id to check against yet at that point in the flow).
  const affiliate = await env.DB.prepare(`SELECT customer_id AS customerId, status FROM affiliates WHERE id = ?`).bind(input.affiliateId).first<{ customerId: number; status: string }>();
  if (!affiliate) {
    logger.error('affiliate.commission_skipped_affiliate_missing', { purchaseSessionId: input.purchaseSessionId, affiliateId: input.affiliateId });
    return { recorded: false, reason: 'affiliate_not_eligible' };
  }
  if (input.purchasingCustomerId !== null && affiliate.customerId === input.purchasingCustomerId) {
    logger.info('affiliate.commission_skipped_self_referral', { purchaseSessionId: input.purchaseSessionId, affiliateId: input.affiliateId });
    return { recorded: false, reason: 'self_referral' };
  }
  if (affiliate.status !== 'approved') {
    // A legitimate case, not an error: the affiliate could have been
    // suspended in the window between checkout-session creation
    // (where the rate was snapshotted) and payment verification.
    logger.info('affiliate.commission_skipped_not_approved', { purchaseSessionId: input.purchaseSessionId, affiliateId: input.affiliateId, status: affiliate.status });
    return { recorded: false, reason: 'affiliate_not_eligible' };
  }

  const commissionPesewas = Math.round((input.grossPesewas * input.commissionPercent) / 100);

  try {
    const insert = await env.DB.prepare(
      `INSERT INTO affiliate_commissions (affiliate_id, purchase_session_id, product_id, gross_pesewas, commission_percent, commission_pesewas, status, data_classification)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 'PRODUCTION')`
    )
      .bind(input.affiliateId, input.purchaseSessionId, input.productId, input.grossPesewas, input.commissionPercent, commissionPesewas)
      .run();

    const commissionId = Number(insert.meta.last_row_id);
    await auditService.record(env, logger, {
      actorType: 'system',
      actorId: null,
      action: 'affiliate.commission_recorded',
      entityType: 'affiliate_commission',
      entityId: commissionId,
      metadata: { affiliateId: input.affiliateId, purchaseSessionId: input.purchaseSessionId, commissionPesewas },
    });
    logger.info('affiliate.commission_recorded', { commissionId, affiliateId: input.affiliateId, purchaseSessionId: input.purchaseSessionId, commissionPesewas });
    return { recorded: true, commissionId, commissionPesewas };
  } catch (err) {
    // UNIQUE(purchase_session_id): the idempotency guard. Should never
    // fire in practice (each purchase_sessions row is only ever
    // verified once), but a re-entry (redelivered webhook, admin
    // reprocess) must never throw back into the payment flow or create
    // a second commission for the same sale.
    logger.error('affiliate.commission_record_failed', { purchaseSessionId: input.purchaseSessionId, error: err instanceof Error ? err.message : String(err) });
    return { recorded: false, reason: 'duplicate' };
  }
}

// ============================================================
// Lifecycle transitions
// ============================================================

export type TransitionResult = { ok: true } | { ok: false; reason: 'not_found' | 'invalid_state' };

export async function approveCommission(env: Env, logger: Logger, adminId: number, commissionId: number): Promise<TransitionResult> {
  return transition(env, logger, { actorType: 'admin', actorId: adminId }, commissionId, 'pending', 'approved', { approved_at: "datetime('now')" });
}

export async function markCommissionPayable(env: Env, logger: Logger, adminId: number | null, commissionId: number): Promise<TransitionResult> {
  return transition(env, logger, { actorType: adminId ? 'admin' : 'system', actorId: adminId }, commissionId, 'approved', 'payable', { payable_at: "datetime('now')" });
}

async function transition(
  env: Env,
  logger: Logger,
  actor: { actorType: 'admin' | 'system'; actorId: number | null },
  commissionId: number,
  fromStatus: AffiliateCommissionStatus,
  toStatus: AffiliateCommissionStatus,
  extraSets: Record<string, string>
): Promise<TransitionResult> {
  const setClauses = Object.entries(extraSets)
    .map(([col, expr]) => `${col} = ${expr}`)
    .join(', ');
  const result = await env.DB.prepare(`UPDATE affiliate_commissions SET status = ?, ${setClauses}, updated_at = datetime('now') WHERE id = ? AND status = ?`)
    .bind(toStatus, commissionId, fromStatus)
    .run();
  if (result.meta.changes !== 1) {
    const exists = await env.DB.prepare(`SELECT id FROM affiliate_commissions WHERE id = ?`).bind(commissionId).first<{ id: number }>();
    return { ok: false, reason: exists ? 'invalid_state' : 'not_found' };
  }
  await auditService.record(env, logger, { actorType: actor.actorType, actorId: actor.actorId, action: `affiliate.commission_${toStatus}`, entityType: 'affiliate_commission', entityId: commissionId, metadata: null });
  return { ok: true };
}

/**
 * Reverses a commission that has NOT yet been paid: the correct
 * response to a refund/cancellation/chargeback discovered before
 * payout. A `paid` commission is deliberately NOT reversible through
 * this path; a post-payout correction is an explicit, audited manual
 * adjustment instead (adjustCommission() below), never an automatic
 * clawback. Idempotent: reversing an already-reversed commission is a
 * no-op success, not an error, so a refund webhook firing twice can
 * never create two reversal audit rows with different reasons.
 *
 * The commission-status transition itself is a single, atomically
 * gated UPDATE (`WHERE status NOT IN ('paid', 'reversed')`), not a
 * SELECT-then-branch: this is what actually decides the race against a
 * concurrent processPayout() finalizing the SAME commission, the exact
 * "genuine correctness defect" a post-commit audit found in the
 * previous, read-then-write version. Whichever statement's WHERE
 * clause matches first (D1/SQLite serializes individual writes to the
 * same row) wins; the loser's own gated UPDATE simply matches zero
 * rows and no-ops, the same status-gated-conditional-UPDATE pattern
 * this codebase already relies on elsewhere (verifySessionAtomic(),
 * revokePurchase(), affiliatePayoutService.ts's own claim step).
 *
 * If this commission had already been claimed into a payout that has
 * not yet been finalized ('requested'/'approved'/'processing'), that
 * payout's own recorded amount_pesewas is shrunk by this commission's
 * share in the SAME call, atomically gated on the PAYOUT's own status
 * so a payout that has ALREADY been marked 'paid' is never touched
 * here (see processPayout()'s own comment for why it, not this
 * decrement, is the final authority on what actually got paid).
 * payout_id is deliberately left in place, not nulled: status =
 * 'reversed' is what excludes this commission from every payable/paid
 * aggregate (getAffiliateOverview, requestPayout()'s claim query,
 * processPayout()'s finalize query) and from ever being reclaimed;
 * keeping payout_id preserves which payout it was originally part of
 * for audit/support purposes instead of severing that history.
 */
export async function reverseCommission(env: Env, logger: Logger, purchaseSessionId: number, reason: string): Promise<{ ok: true; reversed: boolean }> {
  const existing = await env.DB.prepare(`SELECT id, payout_id AS payoutId, commission_pesewas AS commissionPesewas, status FROM affiliate_commissions WHERE purchase_session_id = ?`)
    .bind(purchaseSessionId)
    .first<{ id: number; payoutId: number | null; commissionPesewas: number; status: string }>();
  if (!existing) return { ok: true, reversed: false }; // no commission was ever attributed to this purchase: nothing to reverse

  const transitioned = await env.DB.prepare(
    `UPDATE affiliate_commissions SET status = 'reversed', reversed_at = datetime('now'), reversed_reason = ?, updated_at = datetime('now')
     WHERE id = ? AND status NOT IN ('paid', 'reversed')`
  )
    .bind(reason, existing.id)
    .run();

  if (transitioned.meta.changes === 0) {
    // Lost the race (or arrived after the fact) to either an
    // already-completed reversal (idempotent no-op) or a payout that
    // finished paying this exact commission first (blocked, by
    // design: a paid commission is never reversed automatically).
    if (existing.status === 'paid') {
      logger.error('affiliate.commission_reversal_blocked_already_paid', { commissionId: existing.id, purchaseSessionId, reason });
    }
    return { ok: true, reversed: false };
  }

  if (existing.payoutId !== null) {
    // A plain `amount_pesewas = amount_pesewas - ?` can violate the
    // `amount_pesewas > 0` CHECK constraint outright if this was the
    // payout's only (or last remaining) claimed commission, which would
    // throw straight out of a real refund's revokePurchase() call. The
    // CASE expression keeps this a single atomic statement while never
    // writing a non-positive amount: if the decrement would land at or
    // below zero, the payout is failed instead (nothing legitimately
    // left to honor), and amount_pesewas is left as whatever it already
    // was rather than an invalid value.
    const shrunk = await env.DB.prepare(
      `UPDATE affiliate_payouts SET
         amount_pesewas = CASE WHEN amount_pesewas - ? > 0 THEN amount_pesewas - ? ELSE amount_pesewas END,
         status = CASE WHEN amount_pesewas - ? > 0 THEN status ELSE 'failed' END,
         failure_reason = CASE WHEN amount_pesewas - ? > 0 THEN failure_reason ELSE ? END,
         updated_at = datetime('now')
       WHERE id = ? AND status IN ('requested', 'approved', 'processing')`
    )
      .bind(
        existing.commissionPesewas,
        existing.commissionPesewas,
        existing.commissionPesewas,
        existing.commissionPesewas,
        'All claimed commissions were reversed before this payout could be finalized; nothing was actually owed.',
        existing.payoutId
      )
      .run();

    if (shrunk.meta.changes === 1) {
      const payoutNow = await env.DB.prepare(`SELECT status, amount_pesewas AS amountPesewas FROM affiliate_payouts WHERE id = ?`).bind(existing.payoutId).first<{ status: string; amountPesewas: number }>();
      if (payoutNow?.status === 'failed') {
        await auditService.record(env, logger, {
          actorType: 'system',
          actorId: null,
          action: 'affiliate.payout_failed_all_commissions_reversed',
          entityType: 'affiliate_payout',
          entityId: existing.payoutId,
          metadata: { commissionId: existing.id, purchaseSessionId, reason },
        });
        logger.error('affiliate.payout_failed_all_commissions_reversed', { payoutId: existing.payoutId, commissionId: existing.id });
      } else {
        await auditService.record(env, logger, {
          actorType: 'system',
          actorId: null,
          action: 'affiliate.payout_amount_reduced_by_reversal',
          entityType: 'affiliate_payout',
          entityId: existing.payoutId,
          metadata: { commissionId: existing.id, purchaseSessionId, reducedByPesewas: existing.commissionPesewas, reason },
        });
        logger.info('affiliate.payout_amount_reduced_by_reversal', { payoutId: existing.payoutId, commissionId: existing.id, reducedByPesewas: existing.commissionPesewas });
      }
    }
    // shrunk.meta.changes === 0 means the payout had already reached
    // 'paid' (or a terminal 'failed'/'cancelled' state) by the time this
    // ran: processPayout()'s own recomputation step (see its own
    // comment) is what guarantees correctness in that exact window, not
    // this decrement.
  }

  await auditService.record(env, logger, { actorType: 'system', actorId: null, action: 'affiliate.commission_reversed', entityType: 'affiliate_commission', entityId: existing.id, metadata: { reason, purchaseSessionId, wasClaimedIntoPayoutId: existing.payoutId } });
  logger.info('affiliate.commission_reversed', { commissionId: existing.id, purchaseSessionId, reason });
  return { ok: true, reversed: true };
}

export type AdjustResult = { ok: true } | { ok: false; reason: 'not_found' | 'invalid_input' };

/**
 * The one path a commission's pesewas amount or status can change
 * outside its normal lifecycle: always admin-initiated, always
 * requires a real, non-empty reason, always audited with both the
 * before and after values. Never called by any automatic path.
 */
export async function adjustCommission(
  env: Env,
  logger: Logger,
  adminId: number,
  commissionId: number,
  input: { newStatus?: AffiliateCommissionStatus; newCommissionPesewas?: number; reason: string }
): Promise<AdjustResult> {
  if (!input.reason || input.reason.trim().length < 5) return { ok: false, reason: 'invalid_input' };
  if (input.newCommissionPesewas !== undefined && (!Number.isInteger(input.newCommissionPesewas) || input.newCommissionPesewas < 0)) {
    return { ok: false, reason: 'invalid_input' };
  }

  const existing = await env.DB.prepare(`SELECT id, status, commission_pesewas AS commissionPesewas FROM affiliate_commissions WHERE id = ?`)
    .bind(commissionId)
    .first<{ id: number; status: string; commissionPesewas: number }>();
  if (!existing) return { ok: false, reason: 'not_found' };

  const sets: string[] = ['adjustment_note = ?'];
  const bindings: unknown[] = [input.reason.trim()];
  if (input.newStatus) {
    sets.push('status = ?');
    bindings.push(input.newStatus);
  }
  if (input.newCommissionPesewas !== undefined) {
    sets.push('commission_pesewas = ?');
    bindings.push(input.newCommissionPesewas);
  }
  sets.push("updated_at = datetime('now')");

  await env.DB.prepare(`UPDATE affiliate_commissions SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...bindings, commissionId)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId: adminId,
    action: 'affiliate.commission_adjusted',
    entityType: 'affiliate_commission',
    entityId: commissionId,
    metadata: { reason: input.reason.trim(), before: { status: existing.status, commissionPesewas: existing.commissionPesewas }, after: { status: input.newStatus ?? existing.status, commissionPesewas: input.newCommissionPesewas ?? existing.commissionPesewas } },
  });
  return { ok: true };
}

// ============================================================
// Affiliate-facing reads
// ============================================================

export interface CommissionHistoryItem {
  id: number;
  productTitle: string;
  grossPesewas: number;
  commissionPercent: number;
  commissionPesewas: number;
  status: AffiliateCommissionStatus;
  createdAt: string;
  paidAt: string | null;
  reversedReason: string | null;
}

interface CommissionHistoryRow extends Omit<CommissionHistoryItem, 'status'> {
  status: string;
}

export async function listCommissionsForAffiliate(env: Env, affiliateId: number, page: number, pageSize: number): Promise<{ items: CommissionHistoryItem[]; total: number }> {
  const offset = (page - 1) * pageSize;
  const [rows, countRow] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id, p.title AS productTitle, c.gross_pesewas AS grossPesewas, c.commission_percent AS commissionPercent,
              c.commission_pesewas AS commissionPesewas, c.status, c.created_at AS createdAt, c.paid_at AS paidAt, c.reversed_reason AS reversedReason
       FROM affiliate_commissions c JOIN products p ON p.id = c.product_id
       WHERE c.affiliate_id = ? ORDER BY c.id DESC LIMIT ? OFFSET ?`
    )
      .bind(affiliateId, pageSize, offset)
      .all<CommissionHistoryRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM affiliate_commissions WHERE affiliate_id = ?`).bind(affiliateId).first<{ total: number }>(),
  ]);
  return { items: rows.results.map((r) => ({ ...r, status: r.status as AffiliateCommissionStatus })), total: countRow?.total ?? 0 };
}

export interface AffiliateOverviewStats {
  clicks: number;
  conversions: number;
  revenuePesewas: number;
  earnedPesewas: number;
  pendingPesewas: number;
  payablePesewas: number;
  paidPesewas: number;
}

export async function getAffiliateOverview(env: Env, affiliateId: number): Promise<AffiliateOverviewStats> {
  const [clicksRow, totalsRow] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS clicks FROM affiliate_clicks WHERE affiliate_id = ?`).bind(affiliateId).first<{ clicks: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS conversions, COALESCE(SUM(gross_pesewas), 0) AS revenuePesewas, COALESCE(SUM(commission_pesewas), 0) AS earnedPesewas,
              COALESCE(SUM(CASE WHEN status = 'pending' OR status = 'approved' THEN commission_pesewas ELSE 0 END), 0) AS pendingPesewas,
              COALESCE(SUM(CASE WHEN status = 'payable' THEN commission_pesewas ELSE 0 END), 0) AS payablePesewas,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_pesewas ELSE 0 END), 0) AS paidPesewas
       FROM affiliate_commissions WHERE affiliate_id = ? AND status != 'reversed'`
    )
      .bind(affiliateId)
      .first<{ conversions: number; revenuePesewas: number; earnedPesewas: number; pendingPesewas: number; payablePesewas: number; paidPesewas: number }>(),
  ]);

  return {
    clicks: clicksRow?.clicks ?? 0,
    conversions: totalsRow?.conversions ?? 0,
    revenuePesewas: totalsRow?.revenuePesewas ?? 0,
    earnedPesewas: totalsRow?.earnedPesewas ?? 0,
    pendingPesewas: totalsRow?.pendingPesewas ?? 0,
    payablePesewas: totalsRow?.payablePesewas ?? 0,
    paidPesewas: totalsRow?.paidPesewas ?? 0,
  };
}

// ============================================================
// Admin: commission listing across all affiliates
// ============================================================

export interface AdminCommissionListItem extends CommissionHistoryItem {
  affiliateCode: string;
}
interface AdminCommissionRow extends Omit<AdminCommissionListItem, 'status'> {
  status: string;
}

export async function listAllCommissions(env: Env, filter: { status?: AffiliateCommissionStatus }, page: number, pageSize: number): Promise<{ items: AdminCommissionListItem[]; total: number }> {
  const where = filter.status ? 'WHERE c.status = ?' : '';
  const bindings = filter.status ? [filter.status] : [];
  const offset = (page - 1) * pageSize;

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id, a.affiliate_code AS affiliateCode, p.title AS productTitle, c.gross_pesewas AS grossPesewas, c.commission_percent AS commissionPercent,
              c.commission_pesewas AS commissionPesewas, c.status, c.created_at AS createdAt, c.paid_at AS paidAt, c.reversed_reason AS reversedReason
       FROM affiliate_commissions c JOIN affiliates a ON a.id = c.affiliate_id JOIN products p ON p.id = c.product_id
       ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`
    )
      .bind(...bindings, pageSize, offset)
      .all<AdminCommissionRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM affiliate_commissions c ${where}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);
  return { items: rows.results.map((r) => ({ ...r, status: r.status as AffiliateCommissionStatus })), total: countRow?.total ?? 0 };
}
