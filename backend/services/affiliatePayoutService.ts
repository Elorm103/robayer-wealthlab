/**
 * Affiliate Payout Service: the internal payout ledger. Deliberately
 * no payment-provider integration (per explicit product instruction):
 * `processPayout()` only RECORDS that an admin has already sent the
 * money externally (mobile money / bank transfer) and provides a real
 * reference for it; this service never itself moves money. Structured
 * so a future automated payout integration can slot in at exactly the
 * `processing` -> `paid` transition without touching the commission
 * engine or the request/approval steps before it.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import * as auditService from './admin/auditService';
import { sendEmail } from './emailService';

export const MIN_PAYOUT_PESEWAS = 5000; // GHS 50.00: the minimum payable balance before a payout can be requested.

export const AFFILIATE_PAYOUT_STATUSES = ['requested', 'approved', 'processing', 'paid', 'failed', 'cancelled'] as const;
export type AffiliatePayoutStatus = (typeof AFFILIATE_PAYOUT_STATUSES)[number];

export type RequestPayoutResult =
  | { ok: true; payoutId: number; amountPesewas: number }
  | { ok: false; reason: 'below_threshold' | 'no_payout_method' | 'no_payable_balance' };

/**
 * An affiliate requests a payout for their ENTIRE current `payable`
 * balance (no partial-amount requests: keeps the reconciliation
 * between affiliate_commissions.payout_id and affiliate_payouts.amount_pesewas
 * exact and simple).
 *
 * Claiming is structured so the ONE genuinely atomic step, a single
 * UPDATE statement, serialized by D1/SQLite the same way
 * verifySessionAtomic()/revokePurchase()'s status-gated conditional
 * UPDATEs already are elsewhere in this codebase, is what actually
 * decides which commissions this payout gets, not a SELECT read
 * beforehand. A pre-read SUM followed by a separate INSERT/UPDATE would
 * let two genuinely concurrent requests both read the same unclaimed
 * balance and both create a payout row for the full amount, even
 * though only one of them can actually claim the underlying commission
 * rows: a real duplicate-money bug. Instead: create the payout row
 * first (with a harmless placeholder amount, corrected below; the
 * `amount_pesewas > 0` CHECK constraint requires SOME positive value at
 * insert time), then run the one atomic claiming UPDATE, then compute
 * the real amount from whatever that UPDATE actually claimed, never
 * from a stale pre-read. If nothing was claimed (a concurrent request
 * won the race, or there was nothing payable) or the claimed total
 * doesn't meet the threshold, the placeholder payout row is discarded
 * and any claim released.
 */
export async function requestPayout(env: Env, logger: Logger, affiliateId: number): Promise<RequestPayoutResult> {
  const affiliate = await env.DB.prepare(`SELECT payout_method AS payoutMethod FROM affiliates WHERE id = ?`).bind(affiliateId).first<{ payoutMethod: string | null }>();
  if (!affiliate?.payoutMethod) return { ok: false, reason: 'no_payout_method' };

  const insert = await env.DB.prepare(`INSERT INTO affiliate_payouts (affiliate_id, amount_pesewas, status, method, data_classification) VALUES (?, 1, 'requested', ?, 'PRODUCTION')`)
    .bind(affiliateId, affiliate.payoutMethod)
    .run();
  const payoutId = Number(insert.meta.last_row_id);

  // The one atomic step: only commissions still 'payable' and unclaimed
  // at the exact moment this statement runs are claimed. A concurrent
  // requestPayout() call's own claim UPDATE is serialized against this
  // one by D1: whichever runs second matches zero of the same rows.
  const claim = await env.DB.prepare(`UPDATE affiliate_commissions SET payout_id = ?, updated_at = datetime('now') WHERE affiliate_id = ? AND status = 'payable' AND payout_id IS NULL`)
    .bind(payoutId, affiliateId)
    .run();

  if (claim.meta.changes === 0) {
    await env.DB.prepare(`DELETE FROM affiliate_payouts WHERE id = ?`).bind(payoutId).run();
    return { ok: false, reason: 'no_payable_balance' };
  }

  const claimed = await env.DB.prepare(`SELECT COALESCE(SUM(commission_pesewas), 0) AS total FROM affiliate_commissions WHERE payout_id = ?`).bind(payoutId).first<{ total: number }>();
  const amountPesewas = claimed?.total ?? 0;

  if (amountPesewas < MIN_PAYOUT_PESEWAS) {
    // Release the claim and discard the payout row: this affiliate's
    // genuinely-claimable balance doesn't meet the threshold. The
    // released commissions remain 'payable' and claimable by a future request.
    await env.DB.prepare(`UPDATE affiliate_commissions SET payout_id = NULL, updated_at = datetime('now') WHERE payout_id = ?`).bind(payoutId).run();
    await env.DB.prepare(`DELETE FROM affiliate_payouts WHERE id = ?`).bind(payoutId).run();
    return { ok: false, reason: 'below_threshold' };
  }

  await env.DB.prepare(`UPDATE affiliate_payouts SET amount_pesewas = ? WHERE id = ?`).bind(amountPesewas, payoutId).run();

  await auditService.record(env, logger, { actorType: 'customer', actorId: null, action: 'affiliate.payout_requested', entityType: 'affiliate_payout', entityId: payoutId, metadata: { affiliateId, amountPesewas } });
  logger.info('affiliate.payout_requested', { payoutId, affiliateId, amountPesewas });
  return { ok: true, payoutId, amountPesewas };
}

export type PayoutTransitionResult = { ok: true } | { ok: false; reason: 'not_found' | 'invalid_state' | 'invalid_input' };

export async function approvePayout(env: Env, logger: Logger, adminId: number, payoutId: number): Promise<PayoutTransitionResult> {
  const result = await env.DB.prepare(`UPDATE affiliate_payouts SET status = 'approved', approved_at = datetime('now'), approved_by = ?, updated_at = datetime('now') WHERE id = ? AND status = 'requested'`)
    .bind(adminId, payoutId)
    .run();
  if (result.meta.changes !== 1) return await notFoundOrInvalidState(env, payoutId);
  await auditService.record(env, logger, { actorType: 'admin', actorId: adminId, action: 'affiliate.payout_approved', entityType: 'affiliate_payout', entityId: payoutId, metadata: null });
  return { ok: true };
}

/**
 * Records that the admin has ALREADY sent the money externally and is
 * now logging the real reference for it; this function does not, and
 * cannot, itself move money (see this file's own header comment). A
 * fabricated/placeholder reference is a misuse of this endpoint, not
 * something this service can detect; the admin UI makes clear this
 * marks a real, already-completed external payment.
 */
export async function processPayout(env: Env, logger: Logger, adminId: number, payoutId: number, reference: string): Promise<PayoutTransitionResult> {
  if (!reference || reference.trim().length < 3) return { ok: false, reason: 'invalid_input' };

  const result = await env.DB.prepare(
    `UPDATE affiliate_payouts SET status = 'paid', reference = ?, processed_at = datetime('now'), processed_by = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('approved', 'processing')`
  )
    .bind(reference.trim(), adminId, payoutId)
    .run();
  if (result.meta.changes !== 1) return await notFoundOrInvalidState(env, payoutId);

  await env.DB.prepare(`UPDATE affiliate_commissions SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now') WHERE payout_id = ?`).bind(payoutId).run();

  await auditService.record(env, logger, { actorType: 'admin', actorId: adminId, action: 'affiliate.payout_paid', entityType: 'affiliate_payout', entityId: payoutId, metadata: { reference: reference.trim() } });
  logger.info('affiliate.payout_paid', { payoutId, reference: reference.trim() });

  const row = await env.DB.prepare(
    `SELECT c.email AS email, p.amount_pesewas AS amountPesewas, p.method FROM affiliate_payouts p
     JOIN affiliates a ON a.id = p.affiliate_id JOIN customers c ON c.id = a.customer_id WHERE p.id = ?`
  )
    .bind(payoutId)
    .first<{ email: string; amountPesewas: number; method: string }>();
  if (row) {
    await sendEmail(env, logger, {
      template: 'affiliate-payout-paid',
      to: row.email,
      data: {
        amount: `GH₵${(row.amountPesewas / 100).toFixed(2)}`,
        method: row.method === 'mobile_money' ? 'Mobile Money' : 'Bank Transfer',
        reference: reference.trim(),
        dashboardUrl: `${env.SITE_BASE_URL}/affiliate/earnings/`,
      },
      entityType: 'affiliate_payout',
      entityId: payoutId,
    });
  }

  return { ok: true };
}

export async function failPayout(env: Env, logger: Logger, adminId: number, payoutId: number, reason: string): Promise<PayoutTransitionResult> {
  const result = await env.DB.prepare(`UPDATE affiliate_payouts SET status = 'failed', failure_reason = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('requested', 'approved', 'processing')`)
    .bind(reason, payoutId)
    .run();
  if (result.meta.changes !== 1) return await notFoundOrInvalidState(env, payoutId);

  // Release the claimed commissions back to 'payable' (unclaimed) so they can be retried in a future payout.
  await env.DB.prepare(`UPDATE affiliate_commissions SET payout_id = NULL, updated_at = datetime('now') WHERE payout_id = ?`).bind(payoutId).run();

  await auditService.record(env, logger, { actorType: 'admin', actorId: adminId, action: 'affiliate.payout_failed', entityType: 'affiliate_payout', entityId: payoutId, metadata: { reason } });
  return { ok: true };
}

export async function cancelPayout(env: Env, logger: Logger, adminId: number, payoutId: number, reason: string): Promise<PayoutTransitionResult> {
  const result = await env.DB.prepare(`UPDATE affiliate_payouts SET status = 'cancelled', cancelled_reason = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('requested', 'approved')`)
    .bind(reason, payoutId)
    .run();
  if (result.meta.changes !== 1) return await notFoundOrInvalidState(env, payoutId);

  await env.DB.prepare(`UPDATE affiliate_commissions SET payout_id = NULL, updated_at = datetime('now') WHERE payout_id = ?`).bind(payoutId).run();

  await auditService.record(env, logger, { actorType: 'admin', actorId: adminId, action: 'affiliate.payout_cancelled', entityType: 'affiliate_payout', entityId: payoutId, metadata: { reason } });
  return { ok: true };
}

async function notFoundOrInvalidState(env: Env, payoutId: number): Promise<PayoutTransitionResult> {
  const exists = await env.DB.prepare(`SELECT id FROM affiliate_payouts WHERE id = ?`).bind(payoutId).first<{ id: number }>();
  return { ok: false, reason: exists ? 'invalid_state' : 'not_found' };
}

export interface PayoutListItem {
  id: number;
  amountPesewas: number;
  status: AffiliatePayoutStatus;
  method: string;
  reference: string | null;
  requestedAt: string;
  processedAt: string | null;
}
interface PayoutRow extends Omit<PayoutListItem, 'status'> {
  status: string;
}

export async function listPayoutsForAffiliate(env: Env, affiliateId: number): Promise<PayoutListItem[]> {
  const rows = await env.DB.prepare(
    `SELECT id, amount_pesewas AS amountPesewas, status, method, reference, requested_at AS requestedAt, processed_at AS processedAt
     FROM affiliate_payouts WHERE affiliate_id = ? ORDER BY id DESC`
  )
    .bind(affiliateId)
    .all<PayoutRow>();
  return rows.results.map((r) => ({ ...r, status: r.status as AffiliatePayoutStatus }));
}

export interface AdminPayoutListItem extends PayoutListItem {
  affiliateCode: string;
  customerEmail: string;
}
interface AdminPayoutRow extends Omit<AdminPayoutListItem, 'status'> {
  status: string;
}

export async function listAllPayouts(env: Env, filter: { status?: AffiliatePayoutStatus }, page: number, pageSize: number): Promise<{ items: AdminPayoutListItem[]; total: number }> {
  const where = filter.status ? 'WHERE p.status = ?' : '';
  const bindings = filter.status ? [filter.status] : [];
  const offset = (page - 1) * pageSize;

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(
      `SELECT p.id, a.affiliate_code AS affiliateCode, c.email AS customerEmail, p.amount_pesewas AS amountPesewas, p.status, p.method,
              p.reference, p.requested_at AS requestedAt, p.processed_at AS processedAt
       FROM affiliate_payouts p JOIN affiliates a ON a.id = p.affiliate_id JOIN customers c ON c.id = a.customer_id
       ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`
    )
      .bind(...bindings, pageSize, offset)
      .all<AdminPayoutRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM affiliate_payouts p ${where}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);
  return { items: rows.results.map((r) => ({ ...r, status: r.status as AffiliatePayoutStatus })), total: countRow?.total ?? 0 };
}
