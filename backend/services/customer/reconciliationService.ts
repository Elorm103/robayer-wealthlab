/**
 * Customer Purchase Reconciliation Service — Version 3.3 Milestone M5C
 * Phase 2 (Activation, Analytics and Customer Reconciliation). See
 * docs/v3.3-m5c-customer-reconciliation-architecture.md.
 *
 * Recovers "orphaned" purchases: `purchase_sessions` rows with
 * `status = 'verified'` and `customer_id IS NULL`, left over from
 * before Milestone M1 introduced auto-provisioning (or any other path
 * that verified a payment without a customer row ever getting linked).
 *
 * This is a SECOND legitimate call site for
 * `identityService.findOrCreateCustomer()`, alongside
 * `commerceService.ts`'s webhook handler — but it does not weaken
 * ADR-006 ("Purchase-triggered account provisioning only", see
 * docs/v3.0.2-architecture-decision-register.md). It is gated
 * exclusively on an ALREADY-VERIFIED, ALREADY-EXISTING purchase row
 * whose `customer_email` was itself populated only from Paystack's own
 * confirmed payer email at verification time (never client input, see
 * `commerceService.ts`'s webhook handler) — never a free-form email
 * with no purchase behind it. Purchase-triggered, whether
 * contemporaneous (the webhook) or historical (here), never
 * registration-triggered.
 *
 * No-enumeration discipline, identical to
 * `authService.forgotPassword()`: the caller always gets the same
 * generic "if we found something, we emailed you" outcome, whether or
 * not any unclaimed purchase existed for the submitted email. This
 * also means a customer row can be created here without the person yet
 * proving inbox access — but exactly like the existing webhook auto-
 * provision flow, an account with no password set cannot be logged
 * into by anyone (ADR-002/ADR-006), so this creates no ownership
 * transfer on its own. Real access is only granted once they redeem
 * the emailed `customer-purchase-reconciliation` password-setup token,
 * proving they control the inbox Paystack itself already verified.
 *
 * Duplicate prevention is structural, not bookkeeping: the linking
 * UPDATE is gated on `customer_id IS NULL`, so a second, SEQUENTIAL
 * call for the same email simply finds zero unlinked rows left to
 * touch.
 *
 * Remediated in Milestone M5D.1 (Acceptance Remediation): Sprint M5D's
 * independent acceptance review reproduced that this was NOT true for
 * two genuinely CONCURRENT calls (`Promise.all`, not sequential) for
 * the same email — both would read the same unclaimed set before
 * either's UPDATE landed, and both would proceed to audit-log and
 * email the customer, producing 2 duplicate password-setup emails for
 * one reconciliation event (see
 * docs/v3.3-m5d-reconciliation-validation-report.md). The fix does not
 * need a new claim table the way the review-reminder Cron Trigger did
 * (docs/v3.3-m5d1-retry-idempotency-strategy.md): the existing linking
 * UPDATE is already atomic per D1/SQLite's own write serialization —
 * the bug was only that this function never checked how many rows its
 * own UPDATE actually changed before proceeding to notify. It now does:
 * `result.meta.changes` is checked, and only the rows THIS call
 * genuinely won are used for the audit log and to decide whether to
 * notify at all — the same atomic-UPDATE-then-check-`meta.changes`
 * idiom already used throughout this codebase (authService.ts's
 * setPassword(), sessionService.ts's revokeSession()).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { findOrCreateCustomer } from './identityService';
import { issuePasswordToken } from './authService';
import * as auditService from '../admin/auditService';

const MAX_EMAIL_LENGTH = 254;

interface UnclaimedSession {
  id: number;
  marketingOptIn: number;
}

/**
 * Finds and links every unclaimed, verified purchase for this email,
 * then emails a password-setup link. Silently returns (no error, no
 * signal) for an invalid input, an email with zero unclaimed
 * purchases, or an email that already has every purchase claimed —
 * exactly mirroring `authService.forgotPassword()`'s own no-op path.
 */
export async function reconcilePurchases(env: Env, logger: Logger, emailInput: unknown, siteBaseUrl: string): Promise<void> {
  if (typeof emailInput !== 'string' || emailInput.length === 0 || emailInput.length > MAX_EMAIL_LENGTH) return;
  const email = emailInput.trim().toLowerCase();

  const { results: unclaimed } = await env.DB.prepare(
    `SELECT id, marketing_opt_in AS marketingOptIn FROM purchase_sessions WHERE customer_email = ? AND status = 'verified' AND customer_id IS NULL`
  )
    .bind(email)
    .all<UnclaimedSession>();

  if (unclaimed.length === 0) return; // No enumeration signal either way.

  // Only meaningful for a brand-new customer row (findOrCreateCustomer
  // ignores this for an existing one) — seeded true if the visitor
  // opted in on ANY of the historical sessions being reconciled here,
  // matching the spirit of the webhook's per-session seed as closely as
  // a many-to-one reconciliation allows.
  const marketingOptIn = unclaimed.some((row) => row.marketingOptIn === 1);

  const { customerId, isNewCustomer } = await findOrCreateCustomer(env, email, marketingOptIn);

  const ids = unclaimed.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  const updateResult = await env.DB.prepare(
    `UPDATE purchase_sessions SET customer_id = ?, updated_at = datetime('now') WHERE id IN (${placeholders}) AND customer_id IS NULL`
  )
    .bind(customerId, ...ids)
    .run();

  // A concurrent call (genuine Promise.all-style concurrency, not a
  // later sequential retry) can race this exact UPDATE — see this
  // file's own header comment. If it changed zero rows, some other
  // invocation already claimed every one of these purchases first;
  // this call has nothing left to do and must not audit-log or email
  // a second time for the same event.
  if (updateResult.meta.changes === 0) {
    logger.info('customer.purchases_reconciliation_raced', { customerId, attemptedCount: ids.length });
    return;
  }

  // Re-derive exactly which of the attempted ids THIS call actually
  // won, rather than assuming all-or-nothing — a genuine (if rare)
  // partial race, where a concurrent call claims a subset between this
  // function's own read and write, is handled correctly this way too.
  const { results: reconciledRows } = await env.DB.prepare(
    `SELECT id FROM purchase_sessions WHERE id IN (${placeholders}) AND customer_id = ?`
  )
    .bind(...ids, customerId)
    .all<{ id: number }>();
  const reconciledIds = reconciledRows.map((row) => row.id);

  await auditService.record(env, logger, {
    actorType: 'customer',
    actorId: customerId,
    action: 'customer.purchases_reconciled',
    entityType: 'customer',
    entityId: customerId,
    metadata: { reconciledSessionIds: reconciledIds, isNewCustomer },
  });

  await issuePasswordToken(env, logger, customerId, email, siteBaseUrl, 'customer-purchase-reconciliation');

  logger.info('customer.purchases_reconciled', { customerId, isNewCustomer, count: reconciledIds.length });
}
