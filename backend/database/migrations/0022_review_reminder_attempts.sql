-- ============================================================
-- 0022_review_reminder_attempts.sql — Version 3.3 Milestone M5D.1
-- (Acceptance Remediation)
--
-- Fixes the one Blocking finding from docs/v3.3-m5d-review-reminder-validation-report.md:
-- services/customer/reviewReminderService.ts's eligibility check
-- (a NOT EXISTS against email_log) does not distinguish "sent
-- successfully" from "attempted and failed," and provides no atomic
-- claim step, so it fails in two reproduced ways:
--   1. A single failed send (e.g. a transient Resend outage) writes an
--      email_log row regardless of outcome, which then PERMANENTLY
--      excludes that purchase from ever being reminded again — the
--      customer silently never receives the review invitation.
--   2. Two genuinely concurrent scheduled() invocations (Cloudflare's
--      own documented at-least-once Cron Trigger delivery guarantee,
--      not a contrived edge case) both read the same "eligible" state
--      before either has written anything, and both send — a
--      duplicate email to the same customer for the same purchase.
--
-- This table is the fix: a dedicated, narrow, per-purchase claim and
-- status record, deliberately NOT layered onto the existing email_log
-- table. email_log is a generic, multi-purpose send-log that already
-- allows the same (entity_type, entity_id, template) triple to recur
-- legitimately for OTHER templates (e.g. a customer-initiated receipt
-- resend reuses the same purchase_session_id and 'purchase-receipt'
-- template) — adding a UNIQUE constraint there to solve this
-- template's problem would risk breaking that unrelated, already-
-- working feature. A dedicated table with its own UNIQUE constraint
-- on purchase_session_id carries no such risk.
--
-- status values:
--   'claimed'            — a send attempt is in progress (or crashed
--                           mid-attempt without ever settling — see
--                           the staleness window in
--                           reviewReminderService.ts's own claim query).
--   'sent'                — terminal, success. Never re-attempted.
--   'failed'              — a transient failure (network error, a
--                           non-4xx Resend response) — see
--                           emailService.ts's SendEmailResult.permanentFailure.
--                           Retry-eligible on a later scheduled run,
--                           up to MAX_SEND_ATTEMPTS.
--   'permanently_failed'  — either emailService.ts classified the
--                           failure as permanent (a 4xx Resend
--                           rejection, e.g. an invalid recipient), or
--                           MAX_SEND_ATTEMPTS was reached. Terminal.
--                           Never re-attempted, but distinct from
--                           'sent' so this is never miscounted as a
--                           successful reminder anywhere (e.g. in
--                           analyticsService.ts's reviewsSubmitted-
--                           adjacent metrics, none of which currently
--                           reference this table, but future ones might).
--
-- The atomic claim itself is a single INSERT ... ON CONFLICT DO UPDATE
-- ... WHERE statement (see findDueReminders()/claimReminderAttempt() in
-- reviewReminderService.ts) whose WHERE clause only matches a row that
-- is genuinely retry-eligible (status = 'failed', or a stale 'claimed'
-- row whose owning invocation evidently crashed) — the same
-- atomic-UPDATE-then-check-meta.changes idiom this codebase already
-- uses throughout (services/customer/authService.ts's setPassword(),
-- sessionService.ts's revokeSession(), unsubscribeService.ts's
-- consumeTokenAtomic()), applied here for the first time to a
-- multi-row batch-claim scenario rather than a single-token redemption.
--
-- Rollback: `DROP TABLE review_reminder_attempts;` — safe at any time.
-- No other table references it, and reviewReminderService.ts's own
-- eligibility query falls back to treating every purchase as never-
-- attempted if this table doesn't exist, which would only mean a
-- purchase already reminded gets reminded again once — not a data
-- loss or corruption risk, just a reversion to this exact migration's
-- own "before" state.
-- ============================================================

CREATE TABLE review_reminder_attempts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_session_id  INTEGER NOT NULL UNIQUE REFERENCES purchase_sessions(id),
  status               TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'failed', 'permanently_failed')),
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  claimed_at           TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at         TEXT,
  last_email_log_id    INTEGER REFERENCES email_log(id)
);

CREATE INDEX idx_review_reminder_attempts_status ON review_reminder_attempts(status);
