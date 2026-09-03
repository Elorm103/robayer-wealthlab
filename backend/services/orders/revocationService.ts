/**
 * Revocation Service - Version 3.0.2 Milestone M2 (Orders, Receipts &
 * Customer Library). Implements ADR-003's binding requirement: any
 * process revoking access to a purchase must set both
 * `licenses.revoked_at` and `deliveries.status = 'revoked'` in one
 * logical operation - never one without the other, since a license
 * document saying "revoked" while the file remains downloadable is a
 * real control gap, not a cosmetic inconsistency.
 *
 * This is the only function anywhere in this codebase that ever sets
 * `licenses.revoked_at`. `deliveries.status = 'revoked'` was already a
 * live, valid enum value since before M1 (provisioned for exactly
 * this) but never actually set by any code path until this function.
 *
 * Per the M2A Product Owner's approved scope resolution: this sprint
 * implements internal, admin-triggered revocation only - no
 * customer-facing refund request workflow, no refund portal, no
 * approval queue, no policy management. See
 * docs/v3.0.2-m2-architecture-compliance-report.md's scope-boundary
 * finding for the full reasoning.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { reverseCommission } from '../affiliateCommissionService';

export type RevocationReason = 'refund' | 'chargeback';

export type RevokePurchaseResult =
  | { ok: true; purchaseSessionId: number; licenseIds: number[]; deliveryIds: number[] }
  | { ok: false; reason: 'not_found' | 'not_verified' | 'already_revoked' };

interface PurchaseSessionRow {
  id: number;
  status: string;
}

/**
 * Revokes every license and delivery tied to one purchase session, in
 * one D1 batch (D1's `batch()` executes as a single implicit
 * transaction - the closest primitive this runtime offers to "both
 * writes succeed together or neither does," matching ADR-003's own
 * "in one logical operation" wording). Idempotent under genuine
 * concurrency, not just sequential re-calls: the `purchase_sessions`
 * statement inside the batch is itself a status-gated conditional
 * UPDATE (`WHERE status = 'verified'`), the exact same
 * atomic-race-arbitration pattern `commerceService.ts`'s
 * `verifySessionAtomic()` already uses for webhook idempotency. Two
 * truly simultaneous calls (e.g. two concurrent admin refund clicks)
 * both read `status = 'verified'` before either writes, but only the
 * batch that physically commits first can still match that WHERE
 * clause - D1/SQLite serializes concurrent writes, so the second
 * batch's conditional UPDATE affects zero rows even though its own
 * licenses/deliveries statements were also gated the same
 * (`revoked_at IS NULL` / `status != 'revoked'`) and therefore no-op
 * too. This function inspects the batch's own per-statement result to
 * tell which case happened, rather than trusting the read that
 * happened before the batch ran (advisory only, same "informational
 * pre-check, atomic real check" split `entitlementService.ts`'s
 * `consumeTokenAtomic()` already established).
 *
 * Also transitions `purchase_sessions.status` to `'refunded'` (an
 * enum value already live since before M1) so the customer-facing
 * status surfaced by `fulfilmentService.getFulfilmentStatus()` reads
 * correctly afterward.
 */
export async function revokePurchase(env: Env, logger: Logger, purchaseReference: string, reason: RevocationReason): Promise<RevokePurchaseResult> {
  const session = await env.DB.prepare(`SELECT id, status FROM purchase_sessions WHERE purchase_reference = ?`).bind(purchaseReference).first<PurchaseSessionRow>();

  if (!session) return { ok: false, reason: 'not_found' };
  if (session.status === 'refunded') return { ok: false, reason: 'already_revoked' };
  if (session.status !== 'verified') return { ok: false, reason: 'not_verified' };

  const { results: licenseRows } = await env.DB.prepare(`SELECT id FROM licenses WHERE purchase_session_id = ? AND revoked_at IS NULL`)
    .bind(session.id)
    .all<{ id: number }>();
  const { results: deliveryRows } = await env.DB.prepare(`SELECT id FROM deliveries WHERE purchase_session_id = ? AND status != 'revoked'`)
    .bind(session.id)
    .all<{ id: number }>();

  const licenseIds = licenseRows.map((r) => r.id);
  const deliveryIds = deliveryRows.map((r) => r.id);

  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE licenses SET revoked_at = datetime('now') WHERE purchase_session_id = ? AND revoked_at IS NULL`).bind(session.id),
    env.DB.prepare(`UPDATE deliveries SET status = 'revoked', updated_at = datetime('now') WHERE purchase_session_id = ? AND status != 'revoked'`).bind(session.id),
    env.DB.prepare(`UPDATE purchase_sessions SET status = 'refunded', updated_at = datetime('now') WHERE id = ? AND status = 'verified'`).bind(session.id),
  ]);

  const wonRace = results[2].meta.changes === 1;
  if (!wonRace) {
    // Lost the race to a concurrent caller that committed first - that
    // caller's batch already revoked every license/delivery (their
    // WHERE clauses match the exact same rows this call just read), so
    // this call must report the same outcome a second sequential call
    // would: already handled, no new state change, no new audit entry.
    logger.info('order.revoke_lost_race', { purchaseReference, purchaseSessionId: session.id });
    return { ok: false, reason: 'already_revoked' };
  }

  logger.info('order.revoked', {
    purchaseReference,
    purchaseSessionId: session.id,
    reason,
    licenseCount: licenseIds.length,
    deliveryCount: deliveryIds.length,
  });

  // Affiliate Programme: this is the SAME, single, existing
  // revocation path every refund/chargeback already goes through
  // (this function's own header comment: "the only function anywhere
  // in this codebase that ever sets licenses.revoked_at"); no
  // parallel refund mechanism was introduced. reverseCommission() is
  // itself idempotent (a no-op if no commission was ever attributed
  // to this purchase, or if it was already reversed) and never
  // reverses a commission that has already been paid, see its own
  // header comment in affiliateCommissionService.ts.
  await reverseCommission(env, logger, session.id, reason === 'refund' ? 'Order refunded' : 'Chargeback');

  return { ok: true, purchaseSessionId: session.id, licenseIds, deliveryIds };
}
