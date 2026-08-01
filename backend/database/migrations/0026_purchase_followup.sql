-- ============================================================
-- 0026_purchase_followup.sql — Version 4.0 Milestone C1 (Core Email
-- Lifecycle)
--
-- Adds the one genuinely new time-delayed automation this milestone
-- builds: a "purchase follow-up" check-in email, sent a few days after
-- a purchase — after the immediate purchase-receipt/secure-download
-- emails (sent inline at fulfilment), and well before the existing
-- 5-day review-reminder (services/customer/reviewReminderService.ts).
-- This fills the one real gap in the purchase lifecycle: nothing
-- currently checks in on a buyer between "here's your download" and
-- "please leave a review."
--
-- Both additions here are a direct, deliberate copy of the exact
-- pattern migrations 0021 + 0022 already established and already
-- fixed a real production concurrency bug in
-- (docs/v3.3-m5d1-retry-idempotency-strategy.md) — not a new design,
-- reusing a proven one for a second, structurally identical
-- "one-time-only, delayed, per-purchase" send:
--
--   1. Two opt-out columns on customer_profiles (mirrors
--      review_reminder_opt_out / review_reminder_opt_out_token from
--      migration 0021) — a customer can turn off follow-up check-ins
--      independently of review reminders; these are two different
--      emails serving two different purposes, so one opt-out must
--      never silently affect the other.
--   2. A dedicated atomic per-purchase claim table (mirrors
--      review_reminder_attempts from migration 0022, same status enum,
--      same reasoning for why this belongs in its own table rather
--      than layered onto the generic, multi-purpose email_log) — this
--      is what makes the Cron Trigger's at-least-once delivery safe:
--      a transient failure is retried, a permanent one is not, and two
--      concurrent invocations can never both send.
--
-- Both new tables/columns are additive only. Zero DROP, zero column
-- removal, no existing row's meaning changes.
--
-- Rollback: `ALTER TABLE customer_profiles DROP COLUMN
-- purchase_followup_opt_out; ALTER TABLE customer_profiles DROP COLUMN
-- purchase_followup_opt_out_token; DROP TABLE
-- purchase_followup_attempts;` — safe at any time. No other table
-- references either addition, and
-- services/customer/purchaseFollowupService.ts's own eligibility query
-- falls back to treating every purchase as never-attempted if the
-- attempts table doesn't exist, which would only mean a purchase
-- already followed-up gets a duplicate follow-up once — not a data
-- loss or corruption risk.
-- ============================================================

ALTER TABLE customer_profiles ADD COLUMN purchase_followup_opt_out INTEGER NOT NULL DEFAULT 0 CHECK (purchase_followup_opt_out IN (0, 1));

-- Generated lazily on first send, exactly like review_reminder_opt_out_token
-- — a single, stable, long-lived value per customer, not single-use,
-- not expiring. A reused/forwarded link can, at worst, opt someone out
-- of a follow-up email again, never grant access to anything sensitive.
ALTER TABLE customer_profiles ADD COLUMN purchase_followup_opt_out_token TEXT;

CREATE TABLE purchase_followup_attempts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_session_id  INTEGER NOT NULL UNIQUE REFERENCES purchase_sessions(id),
  status               TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'failed', 'permanently_failed')),
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  claimed_at           TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at         TEXT,
  last_email_log_id    INTEGER REFERENCES email_log(id)
);

CREATE INDEX idx_purchase_followup_attempts_status ON purchase_followup_attempts(status);
