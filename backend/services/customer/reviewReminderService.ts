/**
 * Review Reminder Service — Version 3.3 Milestone M5C (Activation,
 * Analytics and Customer Reconciliation) Phase 5, remediated in
 * Milestone M5D.1 (Acceptance Remediation) per
 * docs/v3.3-m5d-review-reminder-validation-report.md's Blocking
 * finding. See docs/v3.3-m5d1-retry-idempotency-strategy.md for the
 * full design rationale.
 *
 * Reminder eligibility (`findDueReminders`) is one query, six
 * conditions, no application-level looping required to decide "should
 * this purchase get a reminder":
 *   1. `status = 'verified'` — never a pending/failed/expired session.
 *   2. `customer_id IS NOT NULL` — the purchase has a real account
 *      behind it (a still-orphaned historical purchase gets no
 *      reminder until Phase 2's reconciliation links it).
 *   3. `verified_at <= now - REMINDER_DELAY_DAYS` — enough time to
 *      actually use the guide before being asked to review it.
 *   4. No terminal `review_reminder_attempts` row (`status IN ('sent',
 *      'permanently_failed')`) and no CURRENTLY-active claim by another
 *      invocation (`status = 'claimed'` and not yet stale) — see
 *      "Idempotency and Concurrency Design" below. This is the fix:
 *      Milestone M5C's original eligibility check (a NOT EXISTS against
 *      `email_log`) could not distinguish "already sent" from "already
 *      attempted and failed," so a single transient failure
 *      permanently and silently suppressed all future reminders for
 *      that purchase — reproduced and confirmed during Sprint M5D.
 *   5. No review already submitted for this (product, customer) pair
 *      — reusing `product_reviews.UNIQUE(product_id, customer_id)`
 *      directly, and no opt-out recorded on `customer_profiles`
 *      (migration 0021).
 *
 * ============================================================
 * Idempotency and Concurrency Design (Milestone M5D.1)
 * ============================================================
 *
 * Cloudflare Cron Triggers are documented as at-least-once delivery,
 * for every plan tier — a genuine, expected operational condition for
 * any recurring Cron Trigger, not a rare edge case to shrug off. Sprint
 * M5D reproduced two concrete failure modes this project's own
 * pre-existing risk mitigation (docs/v3.3-risk-assessment.md: "verify
 * the Cron Trigger's idempotency... before production release") had
 * required be checked, and which Milestone M5C's original
 * implementation did not actually satisfy:
 *
 *   (a) A single failed send (a transient Resend outage, a
 *       misconfigured key) permanently suppressed all future reminders
 *       for that purchase, since ANY email_log row for that purchase +
 *       template, regardless of status, satisfied the old "already
 *       attempted" check.
 *   (b) Two genuinely concurrent scheduled() invocations both read the
 *       same "eligible" state before either had written anything, and
 *       both sent — a duplicate email to the same customer.
 *
 * The fix is a dedicated, atomic per-purchase claim table
 * (`review_reminder_attempts`, migration 0022), NOT a change to
 * email_log itself (email_log is a generic, multi-purpose send log
 * that legitimately allows the same purchase_session_id + template
 * pair to recur for unrelated reasons — e.g. a customer-initiated
 * receipt resend reuses the same purchase_session_id under the
 * 'purchase-receipt' template — so constraining it here would risk an
 * already-working, unrelated feature).
 *
 * `claimReminderAttempt()` is a single atomic
 * `INSERT ... ON CONFLICT(purchase_session_id) DO UPDATE ... WHERE`
 * statement — the same atomic-UPDATE-then-check-`meta.changes` idiom
 * this codebase already uses throughout (authService.ts's
 * setPassword(), sessionService.ts's revokeSession(),
 * unsubscribeService.ts's consumeTokenAtomic()), applied here to a
 * per-row claim rather than a single-token redemption. Its WHERE
 * clause only allows the claim to succeed for a row that does not yet
 * exist, or one in a genuinely retry-eligible state ('failed', or a
 * 'claimed' row stale enough that its owning invocation evidently
 * crashed without ever settling it — CLAIM_STALE_MINUTES, far longer
 * than any single Worker invocation's own CPU/wall-time budget). D1
 * (like the SQLite it's built on) serializes writes, so of two
 * concurrent invocations attempting to claim the same purchase, only
 * one can ever see `meta.changes === 1` for the same row — the other
 * sees 0 and skips it entirely, closing failure mode (b).
 *
 * A completed attempt is then marked terminal ('sent') or classified
 * by `emailService.ts`'s own existing `permanentFailure` signal
 * ('permanently_failed' for a 4xx-rejected recipient, or once
 * MAX_SEND_ATTEMPTS is reached; 'failed', and therefore retry-eligible
 * on a later run, for anything else) — closing failure mode (a): a
 * transient failure is retried on a subsequent scheduled run instead of
 * being silently abandoned forever, while a genuinely permanent failure
 * (or one that has exhausted its retry budget) stops retrying rather
 * than looping indefinitely against an address that will never accept
 * the email.
 *
 * Called from the Worker's `scheduled()` handler (worker/index.ts) —
 * this project's first-ever Cron Trigger.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { sendEmail } from '../emailService';
import { generateReviewReminderOptOutToken } from '../../utils/customerToken';
import * as auditService from '../admin/auditService';

/** Enough time to realistically have started the guide, not so long the purchase has faded from memory. */
const REMINDER_DELAY_DAYS = 5;

/** A defensive cap on how many reminders one scheduled run sends — this is a brand-new, never-before-run consumer, so a first run against months of unreminded historical purchases must not attempt an unbounded batch in one Worker invocation. Any remainder is simply picked up by the next scheduled run — the eligibility query is idempotent, not a one-shot queue. */
const MAX_REMINDERS_PER_RUN = 200;

/** After this many attempts, a purchase stuck on transient ('failed') outcomes stops retrying — a persistently-failing address is treated as permanently failed rather than retried forever. */
const MAX_SEND_ATTEMPTS = 3;

/** How long a 'claimed' row is treated as "another invocation may still be actively processing it" before this run is willing to treat it as an abandoned claim (the owning invocation crashed or was killed mid-send) and safely retry it. Comfortably longer than any single Worker invocation's own CPU/wall-time budget. */
const CLAIM_STALE_MINUTES = 10;

interface DueReminderRow {
  purchaseSessionId: number;
  customerId: number;
  email: string;
  productSlug: string;
  productTitle: string;
}

async function findDueReminders(env: Env): Promise<DueReminderRow[]> {
  const cutoff = new Date(Date.now() - REMINDER_DELAY_DAYS * 24 * 60 * 60_000).toISOString();
  const staleClaimCutoff = new Date(Date.now() - CLAIM_STALE_MINUTES * 60_000).toISOString();

  const { results } = await env.DB.prepare(
    `SELECT ps.id AS purchaseSessionId, ps.customer_id AS customerId, c.email AS email,
            ps.product_slug AS productSlug, ps.product_title AS productTitle
     FROM purchase_sessions ps
     JOIN customers c ON c.id = ps.customer_id AND c.status = 'active' AND c.deleted_at IS NULL
     JOIN customer_profiles cp ON cp.customer_id = ps.customer_id
     LEFT JOIN products p ON p.slug = ps.product_slug AND p.deleted_at IS NULL
     LEFT JOIN review_reminder_attempts rra ON rra.purchase_session_id = ps.id
     WHERE ps.status = 'verified'
       AND ps.customer_id IS NOT NULL
       AND ps.verified_at <= ?
       AND cp.review_reminder_opt_out = 0
       AND (
         rra.id IS NULL
         OR rra.status = 'failed'
         OR (rra.status = 'claimed' AND rra.claimed_at <= ?)
       )
       AND (
         p.id IS NULL OR NOT EXISTS (
           SELECT 1 FROM product_reviews pr WHERE pr.product_id = p.id AND pr.customer_id = ps.customer_id
         )
       )
     ORDER BY ps.verified_at ASC
     LIMIT ?`
  )
    .bind(cutoff, staleClaimCutoff, MAX_REMINDERS_PER_RUN)
    .all<DueReminderRow>();

  return results;
}

/**
 * Atomically claims one purchase for this invocation to attempt. Returns
 * true only if this call genuinely won the claim (no other invocation
 * currently holds a fresh, unexpired claim, and no prior attempt already
 * settled as 'sent' or 'permanently_failed') — the single statement
 * that makes concurrent double-sending structurally impossible.
 */
async function claimReminderAttempt(env: Env, purchaseSessionId: number): Promise<boolean> {
  // Deliberately a JS-computed ISO timestamp bound as a parameter, NOT
  // SQL's own `datetime('now')` — matching sessionService.ts's own
  // established convention (expires_at/now are always both
  // JS-ISO-formatted where they're compared). Mixing the two formats is
  // a real bug, not a style preference: SQLite's `datetime('now')`
  // produces "YYYY-MM-DD HH:MM:SS" (a space, no milliseconds, no `Z`),
  // while `new Date().toISOString()` produces "YYYY-MM-DDTHH:MM:SS.sssZ".
  // Because `' '` (0x20) sorts before `'T'` (0x54) in a plain TEXT
  // comparison, a SQLite-formatted timestamp compares as "less than" a
  // same-day JS-ISO timestamp REGARDLESS of actual time-of-day —
  // confirmed directly: `datetime('now') < '2026-07-26T00:00:00.000Z'`
  // evaluates true even when "now" is chronologically later that same
  // day. This silently defeated the staleness check below during this
  // very remediation sprint (both of two genuinely concurrent claims
  // succeeded, since every 'claimed' row was always treated as
  // "stale") until caught by direct testing — see
  // docs/v3.3-m5d1-retry-idempotency-strategy.md.
  const now = new Date().toISOString();
  const staleClaimCutoff = new Date(Date.now() - CLAIM_STALE_MINUTES * 60_000).toISOString();

  const result = await env.DB.prepare(
    `INSERT INTO review_reminder_attempts (purchase_session_id, status, attempt_count, claimed_at)
     VALUES (?, 'claimed', 1, ?)
     ON CONFLICT(purchase_session_id) DO UPDATE SET
       status = 'claimed',
       attempt_count = review_reminder_attempts.attempt_count + 1,
       claimed_at = ?,
       completed_at = NULL
     WHERE review_reminder_attempts.status = 'failed'
        OR (review_reminder_attempts.status = 'claimed' AND review_reminder_attempts.claimed_at <= ?)`
  )
    .bind(purchaseSessionId, now, now, staleClaimCutoff)
    .run();

  return result.meta.changes === 1;
}

async function settleReminderAttempt(
  env: Env,
  purchaseSessionId: number,
  status: 'sent' | 'failed' | 'permanently_failed',
  emailLogId: number | null
): Promise<void> {
  await env.DB.prepare(
    `UPDATE review_reminder_attempts SET status = ?, completed_at = ?, last_email_log_id = ? WHERE purchase_session_id = ?`
  )
    .bind(status, new Date().toISOString(), emailLogId, purchaseSessionId)
    .run();
}

/** Returns this customer's existing opt-out token if one exists, otherwise mints and persists one — lazily, on first send, matching unsubscribeService.ts's getOrCreateUnsubscribeToken() precedent exactly (see migration 0021's own header comment for why this can't just reuse unsubscribe_tokens). */
async function getOrCreateOptOutToken(env: Env, customerId: number): Promise<string> {
  const existing = await env.DB.prepare(`SELECT review_reminder_opt_out_token AS token FROM customer_profiles WHERE customer_id = ?`)
    .bind(customerId)
    .first<{ token: string | null }>();
  if (existing?.token) return existing.token;

  const token = generateReviewReminderOptOutToken();
  await env.DB.prepare(`UPDATE customer_profiles SET review_reminder_opt_out_token = ? WHERE customer_id = ?`)
    .bind(token, customerId)
    .run();
  return token;
}

export interface ReviewReminderRunResult {
  eligible: number;
  claimed: number;
  sent: number;
}

/**
 * Sends every currently-due, currently-claimable review reminder, one
 * email per successfully-claimed purchase. Never throws: an individual
 * send failure is recorded via settleReminderAttempt() (as 'failed' or
 * 'permanently_failed', per emailService.ts's own permanentFailure
 * signal and the MAX_SEND_ATTEMPTS cap) and, for a 'failed' outcome,
 * leaves that purchase eligible again on a later scheduled run — this
 * function's own job is only to find candidates, atomically claim each
 * one, and hand it to the same email pipeline every other transactional
 * email already goes through.
 */
export async function sendDueReviewReminders(env: Env, logger: Logger, siteBaseUrl: string): Promise<ReviewReminderRunResult> {
  const due = await findDueReminders(env);
  let claimed = 0;
  let sent = 0;

  for (const row of due) {
    const won = await claimReminderAttempt(env, row.purchaseSessionId);
    if (!won) {
      // Another invocation is currently processing this purchase (or
      // already settled it since findDueReminders() ran) — skip, not an
      // error. This is exactly the race findDueReminders() alone cannot
      // prevent on its own; the atomic claim is what actually does.
      continue;
    }
    claimed += 1;

    const optOutToken = await getOrCreateOptOutToken(env, row.customerId);
    const reviewUrl = `${siteBaseUrl}/books/${row.productSlug}/#reviews`;
    const optOutUrl = `${siteBaseUrl}/api/customer/review-reminders/opt-out?token=${optOutToken}`;

    const result = await sendEmail(env, logger, {
      template: 'customer-review-reminder',
      to: row.email,
      data: { productTitle: row.productTitle, reviewUrl, optOutUrl },
      entityType: 'purchase_session',
      entityId: row.purchaseSessionId,
    });

    const attemptRow = await env.DB.prepare(`SELECT attempt_count AS attemptCount FROM review_reminder_attempts WHERE purchase_session_id = ?`)
      .bind(row.purchaseSessionId)
      .first<{ attemptCount: number }>();
    const attemptCount = attemptRow?.attemptCount ?? 1;

    if (result.sent) {
      sent += 1;
      await settleReminderAttempt(env, row.purchaseSessionId, 'sent', result.emailLogId);
      await auditService.record(env, logger, {
        actorType: 'system',
        actorId: null,
        action: 'customer.review_reminder_sent',
        entityType: 'purchase_session',
        entityId: row.purchaseSessionId,
        metadata: { customerId: row.customerId, productSlug: row.productSlug },
      });
    } else {
      const terminal = result.permanentFailure || attemptCount >= MAX_SEND_ATTEMPTS;
      const status = terminal ? 'permanently_failed' : 'failed';
      await settleReminderAttempt(env, row.purchaseSessionId, status, result.emailLogId);

      if (terminal) {
        // Closes the audit-visibility gap Sprint M5D found: a failed
        // send previously left zero trace anywhere. A terminal failure
        // (permanent, or retries exhausted) is now a real, findable
        // audit event, not a silent dead end.
        await auditService.record(env, logger, {
          actorType: 'system',
          actorId: null,
          action: 'customer.review_reminder_failed',
          entityType: 'purchase_session',
          entityId: row.purchaseSessionId,
          metadata: { customerId: row.customerId, productSlug: row.productSlug, attemptCount, permanentFailure: result.permanentFailure },
        });
      }
    }
  }

  logger.info('review_reminders.run_complete', { eligible: due.length, claimed, sent });

  return { eligible: due.length, claimed, sent };
}

/**
 * One-click opt-out — mirrors unsubscribeService.ts's own "always
 * succeeds, never errors" philosophy exactly (see migration 0021's
 * header comment for why a reused/forwarded link is low-stakes here:
 * at worst it opts someone out of a reminder email again, never
 * grants access to anything). An unrecognized token is a silent no-op,
 * not a distinct error state — there is no meaningful "reason" to
 * surface to whoever clicked it.
 */
export async function optOutOfReviewReminders(env: Env, logger: Logger, tokenInput: unknown): Promise<void> {
  if (typeof tokenInput !== 'string' || tokenInput.length === 0) return;

  const result = await env.DB.prepare(`UPDATE customer_profiles SET review_reminder_opt_out = 1 WHERE review_reminder_opt_out_token = ?`)
    .bind(tokenInput)
    .run();

  if (result.meta.changes === 1) {
    logger.info('customer.review_reminders_opted_out', {});
  }
}
