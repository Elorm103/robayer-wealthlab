/**
 * Purchase Follow-up Service — Version 4.0 Milestone C1 (Core Email
 * Lifecycle). The one genuinely new time-delayed automation this
 * milestone adds, filling the one real gap found in the Email
 * Architecture Audit: nothing previously checked in on a buyer between
 * the immediate purchase-receipt/secure-download emails (sent inline
 * at fulfilment, see fulfilmentService.ts) and the existing 5-day
 * review-reminder (reviewReminderService.ts).
 *
 * This is a deliberate, near-exact structural copy of
 * reviewReminderService.ts — not a new design. That service's atomic
 * per-purchase claim table already solved the two real concurrency
 * bugs a naive "has this been sent" check has under Cloudflare's
 * documented at-least-once Cron Trigger delivery (see its own header
 * comment and docs/v3.3-m5d1-retry-idempotency-strategy.md) — reusing
 * the same proven shape for a second, structurally identical
 * "one-time-only, delayed, per-purchase" send is the correct
 * "reuse existing infrastructure, don't duplicate functionality"
 * choice, not premature abstraction: the two services stay separate
 * because they're independently opt-out-able (customer_profiles has
 * two distinct opt-out flags — turning off a review reminder must
 * never silently turn off the follow-up check-in, or vice versa) and
 * run at different delays for different purposes.
 *
 * Called from the Worker's `scheduled()` handler (worker/index.ts),
 * the SAME Cron Trigger sendDueReviewReminders() already runs on — no
 * new Cron Trigger, no new schedule, one more consumer of the one
 * that already exists.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { sendEmail } from '../emailService';
import { generatePurchaseFollowupOptOutToken } from '../../utils/customerToken';
import * as auditService from '../admin/auditService';

/** Long enough that a buyer has plausibly opened their download at least once, short enough the purchase is still fresh — deliberately well before REMINDER_DELAY_DAYS (5) in reviewReminderService.ts, so this arrives first. */
const FOLLOWUP_DELAY_DAYS = 2;

/** Same defensive per-run cap and reasoning as reviewReminderService.ts's MAX_REMINDERS_PER_RUN — a brand-new consumer must not attempt an unbounded batch against months of unfollowed-up historical purchases on its first run. */
const MAX_FOLLOWUPS_PER_RUN = 200;

/** Same reasoning as reviewReminderService.ts's MAX_SEND_ATTEMPTS. */
const MAX_SEND_ATTEMPTS = 3;

/** Same reasoning as reviewReminderService.ts's CLAIM_STALE_MINUTES. */
const CLAIM_STALE_MINUTES = 10;

const RESOURCES_URL_PATH = '/resources/';

interface DueFollowupRow {
  purchaseSessionId: number;
  customerId: number;
  email: string;
  productTitle: string;
  purchaseReference: string;
}

async function findDueFollowups(env: Env): Promise<DueFollowupRow[]> {
  const cutoff = new Date(Date.now() - FOLLOWUP_DELAY_DAYS * 24 * 60 * 60_000).toISOString();
  const staleClaimCutoff = new Date(Date.now() - CLAIM_STALE_MINUTES * 60_000).toISOString();

  const { results } = await env.DB.prepare(
    `SELECT ps.id AS purchaseSessionId, ps.customer_id AS customerId, c.email AS email,
            ps.product_title AS productTitle, ps.purchase_reference AS purchaseReference
     FROM purchase_sessions ps
     JOIN customers c ON c.id = ps.customer_id AND c.status = 'active' AND c.deleted_at IS NULL
     JOIN customer_profiles cp ON cp.customer_id = ps.customer_id
     LEFT JOIN purchase_followup_attempts pfa ON pfa.purchase_session_id = ps.id
     WHERE ps.status = 'verified'
       AND ps.customer_id IS NOT NULL
       AND ps.verified_at <= ?
       AND cp.purchase_followup_opt_out = 0
       AND (
         pfa.id IS NULL
         OR pfa.status = 'failed'
         OR (pfa.status = 'claimed' AND pfa.claimed_at <= ?)
       )
     ORDER BY ps.verified_at ASC
     LIMIT ?`
  )
    .bind(cutoff, staleClaimCutoff, MAX_FOLLOWUPS_PER_RUN)
    .all<DueFollowupRow>();

  return results;
}

/** Same atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE idiom as reviewReminderService.ts's claimReminderAttempt() — see that function's own comment for the full concurrency reasoning, identical here. */
async function claimFollowupAttempt(env: Env, purchaseSessionId: number): Promise<boolean> {
  const now = new Date().toISOString();
  const staleClaimCutoff = new Date(Date.now() - CLAIM_STALE_MINUTES * 60_000).toISOString();

  const result = await env.DB.prepare(
    `INSERT INTO purchase_followup_attempts (purchase_session_id, status, attempt_count, claimed_at)
     VALUES (?, 'claimed', 1, ?)
     ON CONFLICT(purchase_session_id) DO UPDATE SET
       status = 'claimed',
       attempt_count = purchase_followup_attempts.attempt_count + 1,
       claimed_at = ?,
       completed_at = NULL
     WHERE purchase_followup_attempts.status = 'failed'
        OR (purchase_followup_attempts.status = 'claimed' AND purchase_followup_attempts.claimed_at <= ?)`
  )
    .bind(purchaseSessionId, now, now, staleClaimCutoff)
    .run();

  return result.meta.changes === 1;
}

async function settleFollowupAttempt(
  env: Env,
  purchaseSessionId: number,
  status: 'sent' | 'failed' | 'permanently_failed',
  emailLogId: number | null
): Promise<void> {
  await env.DB.prepare(
    `UPDATE purchase_followup_attempts SET status = ?, completed_at = ?, last_email_log_id = ? WHERE purchase_session_id = ?`
  )
    .bind(status, new Date().toISOString(), emailLogId, purchaseSessionId)
    .run();
}

/** Same lazy-generation-on-first-send precedent as reviewReminderService.ts's getOrCreateOptOutToken(). */
async function getOrCreateOptOutToken(env: Env, customerId: number): Promise<string> {
  const existing = await env.DB.prepare(`SELECT purchase_followup_opt_out_token AS token FROM customer_profiles WHERE customer_id = ?`)
    .bind(customerId)
    .first<{ token: string | null }>();
  if (existing?.token) return existing.token;

  const token = generatePurchaseFollowupOptOutToken();
  await env.DB.prepare(`UPDATE customer_profiles SET purchase_followup_opt_out_token = ? WHERE customer_id = ?`)
    .bind(token, customerId)
    .run();
  return token;
}

export interface PurchaseFollowupRunResult {
  eligible: number;
  claimed: number;
  sent: number;
}

/** Same "never throws, finds/claims/sends/settles" shape as reviewReminderService.ts's sendDueReviewReminders() — see that function's own comment. */
export async function sendDuePurchaseFollowups(env: Env, logger: Logger, siteBaseUrl: string): Promise<PurchaseFollowupRunResult> {
  const due = await findDueFollowups(env);
  let claimed = 0;
  let sent = 0;

  for (const row of due) {
    const won = await claimFollowupAttempt(env, row.purchaseSessionId);
    if (!won) continue;
    claimed += 1;

    const optOutToken = await getOrCreateOptOutToken(env, row.customerId);
    const fulfilmentUrl = `${siteBaseUrl}/checkout/callback/?ref=${encodeURIComponent(row.purchaseReference)}`;
    const resourcesUrl = `${siteBaseUrl}${RESOURCES_URL_PATH}`;
    const optOutUrl = `${siteBaseUrl}/api/customer/purchase-followup/opt-out?token=${optOutToken}`;

    const result = await sendEmail(env, logger, {
      template: 'customer-purchase-followup',
      to: row.email,
      data: { productTitle: row.productTitle, fulfilmentUrl, resourcesUrl, optOutUrl },
      entityType: 'purchase_session',
      entityId: row.purchaseSessionId,
    });

    const attemptRow = await env.DB.prepare(`SELECT attempt_count AS attemptCount FROM purchase_followup_attempts WHERE purchase_session_id = ?`)
      .bind(row.purchaseSessionId)
      .first<{ attemptCount: number }>();
    const attemptCount = attemptRow?.attemptCount ?? 1;

    if (result.sent) {
      sent += 1;
      await settleFollowupAttempt(env, row.purchaseSessionId, 'sent', result.emailLogId);
      await auditService.record(env, logger, {
        actorType: 'system',
        actorId: null,
        action: 'customer.purchase_followup_sent',
        entityType: 'purchase_session',
        entityId: row.purchaseSessionId,
        metadata: { customerId: row.customerId },
      });
    } else {
      const terminal = result.permanentFailure || attemptCount >= MAX_SEND_ATTEMPTS;
      const status = terminal ? 'permanently_failed' : 'failed';
      await settleFollowupAttempt(env, row.purchaseSessionId, status, result.emailLogId);

      if (terminal) {
        await auditService.record(env, logger, {
          actorType: 'system',
          actorId: null,
          action: 'customer.purchase_followup_failed',
          entityType: 'purchase_session',
          entityId: row.purchaseSessionId,
          metadata: { customerId: row.customerId, attemptCount, permanentFailure: result.permanentFailure },
        });
      }
    }
  }

  logger.info('purchase_followups.run_complete', { eligible: due.length, claimed, sent });

  return { eligible: due.length, claimed, sent };
}

/** Same "always succeeds, never errors" one-click opt-out as reviewReminderService.ts's optOutOfReviewReminders() — see that function's own comment. */
export async function optOutOfPurchaseFollowups(env: Env, logger: Logger, tokenInput: unknown): Promise<void> {
  if (typeof tokenInput !== 'string' || tokenInput.length === 0) return;

  const result = await env.DB.prepare(`UPDATE customer_profiles SET purchase_followup_opt_out = 1 WHERE purchase_followup_opt_out_token = ?`)
    .bind(tokenInput)
    .run();

  if (result.meta.changes === 1) {
    logger.info('customer.purchase_followups_opted_out', {});
  }
}
