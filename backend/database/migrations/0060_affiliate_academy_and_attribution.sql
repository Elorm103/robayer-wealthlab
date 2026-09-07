-- ============================================================
-- 0060_affiliate_academy_and_attribution.sql — Affiliate Programme 2.0:
-- free registration email verification, Affiliate Academy completion
-- tracking, and unified acquisition-source attribution.
--
-- Three independent, additive changes, grouped in one migration because
-- they ship together as one feature:
--
-- 1. customer_email_verification_tokens: a dedicated table, deliberately
--    NOT a reuse of customer_password_tokens — that table's redemption
--    path (authService.ts's setPassword()) sets a new password hash,
--    which is the wrong side-effect for "confirm this email address is
--    real." Same shape/lifecycle (single-use, expiring, one row per
--    issue) as its proven sibling, just for a different assertion.
--
-- 2. affiliates.academy_*: whole-programme completion state (not
--    per-module — see the Academy service's own header comment for why
--    module-level granularity is deliberately out of scope for this
--    pass). One row per affiliate already exists; these are simply new
--    nullable/defaulted columns on it, matching every other additive
--    column this table already has (suspended_at, reactivated_at, etc.)
--
-- 3. purchase_sessions.acquisition_source: the unified 5-way
--    classification (organic/paid/affiliate/direct/unknown) computed
--    once, server-side, at the exact point attribution_confidence
--    already is (commerceService.ts's createCheckoutSession()) — same
--    "locked at checkout, never re-derived later" discipline as every
--    other attribution field on this table. Distinct from
--    attribution_confidence (a narrower "how sure are we" signal that
--    already existed) — this is the "which channel" answer reporting
--    actually needs.
--
-- Rollback:
--   ALTER TABLE purchase_sessions DROP COLUMN acquisition_source;
--   ALTER TABLE affiliates DROP COLUMN academy_version;
--   ALTER TABLE affiliates DROP COLUMN academy_completed_at;
--   ALTER TABLE affiliates DROP COLUMN academy_started_at;
--   ALTER TABLE affiliates DROP COLUMN academy_status;
--   DROP TABLE customer_email_verification_tokens;
-- ============================================================

CREATE TABLE customer_email_verification_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT NOT NULL UNIQUE,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_customer_email_verification_tokens_customer ON customer_email_verification_tokens(customer_id);

ALTER TABLE affiliates ADD COLUMN academy_status TEXT NOT NULL DEFAULT 'not_started'
  CHECK (academy_status IN ('not_started', 'in_progress', 'completed'));
ALTER TABLE affiliates ADD COLUMN academy_started_at TEXT;
ALTER TABLE affiliates ADD COLUMN academy_completed_at TEXT;
ALTER TABLE affiliates ADD COLUMN academy_version TEXT;

ALTER TABLE purchase_sessions ADD COLUMN acquisition_source TEXT NOT NULL DEFAULT 'unknown'
  CHECK (acquisition_source IN ('organic', 'paid', 'affiliate', 'direct', 'unknown'));
