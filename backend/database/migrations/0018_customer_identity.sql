-- ============================================================
-- 0018_customer_identity.sql — Version 3.0.2 Milestone M1
-- (Customer Identity & Guest Checkout)
--
-- Implements exactly the schema ratified in
-- docs/v3.0.2-commerce-architecture-blueprint.md's Deliverable 3
-- ("customers", "customer_profiles", "customer_sessions",
-- "purchase_sessions" extension) plus a "customer_password_tokens"
-- table (the single-use, expiring token backing BOTH the initial
-- password-setup flow and any later password reset — see
-- docs/v3.0.2-architecture-decision-register.md ADR-006). Every table
-- deliberately mirrors an already-proven shape from admin auth
-- (admin_sessions -> customer_sessions, password_reset_tokens ->
-- customer_password_tokens) rather than inventing a new pattern.
--
-- Scoped strictly to M1. Deliberately NOT added here (belongs to a
-- later milestone, per the ratified roadmap):
--   - licenses, receipts, order_items (Milestone M2)
--   - notification_queue, support_requests (M5/M6)
--   - platform_users rename / customer_id bridge (M7)
--
-- All changes are additive: two new columns on purchase_sessions plus
-- five new tables. No existing column, table, or row is altered or
-- dropped.
-- ============================================================

-- ============================================================
-- CUSTOMERS
-- The customer-facing identity — deliberately separate from
-- admin_users (see ADR-004: customers and platform_users/admin_users
-- must never merge). Provisioning is scoped to purchase-triggered only
-- (ADR-006): the only INSERT into this table in M1 is the
-- find-or-create call at payment verification — there is no public
-- registration endpoint.
--
-- password_hash is nullable BY DESIGN: an account with no password set
-- cannot be logged into by anyone, including an attacker who knows the
-- email — this is what lets a customer receive and access a purchase
-- with zero account-creation friction (ratified Blueprint, Deliverable
-- 1 stage 14).
-- ============================================================
CREATE TABLE customers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT NOT NULL UNIQUE,
  password_hash      TEXT,                       -- NULL until the customer sets a password; PBKDF2-SHA256, same format as admin_users.password_hash
  email_verified_at  TEXT,                        -- set immediately at purchase-triggered creation (a successful payment is itself the identity signal — see ADR-006), never left NULL for a provisioned account
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at         TEXT                         -- soft delete on account-closure request — see the ratified Blueprint's Data Governance & Compliance section
);

CREATE INDEX idx_customers_status ON customers(status);
CREATE INDEX idx_customers_deleted_at ON customers(deleted_at);

-- ============================================================
-- CUSTOMER_PROFILES
-- 1:1 with customers, holding everything NOT authentication-critical —
-- kept separate so profile growth never touches the auth-sensitive
-- table. A row is created (empty, all-NULL beyond customer_id) at the
-- same moment the customers row is provisioned, ready for the
-- customer to fill in later via a dashboard Profile page (M3) — M1
-- does not build that editing UI, only the storage.
-- ============================================================
CREATE TABLE customer_profiles (
  customer_id           INTEGER PRIMARY KEY REFERENCES customers(id),
  display_name          TEXT,
  country                TEXT,
  marketing_opt_in       INTEGER NOT NULL DEFAULT 0,  -- seeded from purchase_sessions.marketing_opt_in at provisioning time; editable later from the dashboard (M3)
  preferred_topics       TEXT,                         -- comma-separated, matching products.topic's vocabulary — not populated in M1
  avatar_media_id        INTEGER REFERENCES media_assets(id),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- CUSTOMER_SESSIONS
-- Direct mirror of admin_sessions' proven shape (see migration
-- 0006_admin_auth_foundation.sql) — same token/CSRF/expiry/revocation
-- pattern, applied to a second audience rather than reinvented. See
-- docs/v3.0.2-architecture-decision-register.md ADR's endorsement of
-- reusing proven security patterns over building parallel ones.
-- ============================================================
CREATE TABLE customer_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT NOT NULL UNIQUE,        -- 256-bit, same generation pattern as admin_sessions.token
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  csrf_secret  TEXT NOT NULL,               -- per-session, backs the double-submit CSRF pattern
  ip_created   TEXT,                        -- CF-Connecting-IP at login, audit/anomaly context only, never an access decision
  user_agent   TEXT,
  expires_at   TEXT NOT NULL,               -- absolute lifetime, mirrors admin_sessions' sliding-up-to-cap discipline
  revoked_at   TEXT,                        -- set on logout; a revoked session is never valid again regardless of expires_at
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_customer_sessions_customer ON customer_sessions(customer_id);
CREATE INDEX idx_customer_sessions_expires ON customer_sessions(expires_at);

-- ============================================================
-- CUSTOMER_PASSWORD_TOKENS
-- Single-use, short-lived — same generation pattern and same shape as
-- password_reset_tokens (migration 0013_identity_security.sql). One
-- table serves both the initial password-setup flow (welcome email,
-- after a first purchase) and any later password-reset request: the
-- mechanics (mint a token, email a link, redeem once) are identical in
-- both cases — only the triggering email's copy differs, not the
-- underlying token record. See docs/v3.0.2-commerce-architecture-blueprint.md's
-- Email Architecture (Deliverable 7): "Password creation" and
-- "Password reset" are two emails sharing one mechanism.
-- ============================================================
CREATE TABLE customer_password_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT NOT NULL UNIQUE,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_customer_password_tokens_customer ON customer_password_tokens(customer_id);

-- ============================================================
-- PURCHASE_SESSIONS extension
-- customer_id: added per the ratified Blueprint's Deliverable 3 ("Orders
-- = purchase_sessions, existing, extended") — nullable, since a
-- purchase_sessions row exists (status='pending') before the customer
-- has even been provisioned; set only at verification, alongside the
-- find-or-create step.
--
-- Consent fields: NOT originally in the ratified Blueprint's schema —
-- added here because M1's own functional requirements (this sprint)
-- require capturing Terms of Service / License Agreement / marketing
-- consent, which the architecture never modeled. This is an additive
-- gap-fill consistent with the architecture's own snapshot-at-checkout-
-- time discipline (every other checkout-time fact — price, title,
-- version — is already locked onto this exact row the same way), not
-- a reversal of any ADR. Per the ratified checkout flow (ADR-002: no
-- form on Robayer's own checkout page), these are captured as a
-- purchase-time consent record (the click-to-purchase action itself,
-- for Terms/License; an explicit, separate, unchecked-by-default
-- checkbox for marketing) rather than typed form fields — see
-- js/components/buy-button.js and backend/routes/books.ts for the
-- exact UI. terms_accepted_at/license_accepted_at are always set
-- together with the purchase attempt (required); marketing_opt_in
-- defaults to 0 (opt-out) and is genuinely optional.
-- ============================================================
ALTER TABLE purchase_sessions ADD COLUMN customer_id INTEGER REFERENCES customers(id);
ALTER TABLE purchase_sessions ADD COLUMN terms_accepted_at TEXT;
ALTER TABLE purchase_sessions ADD COLUMN terms_version TEXT;
ALTER TABLE purchase_sessions ADD COLUMN license_accepted_at TEXT;
ALTER TABLE purchase_sessions ADD COLUMN license_version TEXT;
ALTER TABLE purchase_sessions ADD COLUMN marketing_opt_in INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_purchase_sessions_customer ON purchase_sessions(customer_id);
