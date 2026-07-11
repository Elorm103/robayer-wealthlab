-- Robayer WealthLab — D1 Migration 0003 (Version 1.2 Sprint 2.4, Payment Verification)
--
-- See backend/database/schema.sql for full column-by-column rationale
-- and docs/payment-verification.md for the architecture this supports.
--
-- Two changes, each requiring a table recreate (SQLite cannot ALTER a
-- CHECK constraint or a foreign key target in place):
--   1. purchase_sessions: status enum revised (paid -> verified,
--      abandoned removed, cancelled/refunded added), plus new columns
--      product_id / product_version / provider_status / verified_at.
--   2. payment_transactions: order_id (referencing the deprecated
--      `orders` table) replaced by purchase_session_id (referencing
--      purchase_sessions), plus a new event_type column.
--
-- Written as a real, correct migration (recreate + copy + swap) even
-- though no production data exists yet for either table — this
-- project treats every migration as if it will run against a live
-- database, per this sprint's "resist shortcuts" instruction.

PRAGMA foreign_keys = OFF;

-- ============================================================
-- 1. purchase_sessions
-- ============================================================
CREATE TABLE purchase_sessions_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_reference  TEXT UNIQUE,
  product_slug        TEXT NOT NULL,
  product_id          TEXT NOT NULL,
  product_version     TEXT,
  product_title       TEXT NOT NULL,
  amount_pesewas      INTEGER NOT NULL CHECK (amount_pesewas >= 0),
  currency             TEXT NOT NULL DEFAULT 'GHS',
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'expired', 'cancelled', 'refunded')),
  provider             TEXT NOT NULL DEFAULT 'paystack',
  provider_reference   TEXT,
  provider_status      TEXT,
  checkout_url         TEXT,
  customer_email       TEXT,
  verified_at          TEXT,
  expires_at           TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Backfill: product_id has no prior column to copy from (Sprint 2.3
-- never stored it) — falls back to product_slug for any pre-existing
-- row, an honest "we don't actually know the real content id for this
-- old row" placeholder, not a fabricated value. status values are
-- remapped: 'paid' -> 'verified' (same meaning, renamed); 'abandoned'
-- (never actually reachable by Sprint 2.3 code, see schema.sql's note)
-- -> 'expired', the closest honest equivalent for any row that
-- somehow held it.
INSERT INTO purchase_sessions_new (
  id, purchase_reference, product_slug, product_id, product_version, product_title,
  amount_pesewas, currency, status, provider, provider_reference, checkout_url,
  customer_email, expires_at, created_at, updated_at
)
SELECT
  id, purchase_reference, product_slug, product_slug, NULL, product_title,
  amount_pesewas, currency,
  CASE status WHEN 'paid' THEN 'verified' WHEN 'abandoned' THEN 'expired' ELSE status END,
  provider, provider_reference, checkout_url,
  customer_email, expires_at, created_at, updated_at
FROM purchase_sessions;

DROP TABLE purchase_sessions;
ALTER TABLE purchase_sessions_new RENAME TO purchase_sessions;

CREATE INDEX idx_purchase_sessions_status ON purchase_sessions(status);
CREATE INDEX idx_purchase_sessions_product ON purchase_sessions(product_slug);
CREATE INDEX idx_purchase_sessions_reference ON purchase_sessions(purchase_reference);

-- ============================================================
-- 2. payment_transactions
-- ============================================================
CREATE TABLE payment_transactions_new (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_session_id  INTEGER REFERENCES purchase_sessions(id),
  paystack_reference   TEXT NOT NULL UNIQUE,
  event_type           TEXT NOT NULL DEFAULT 'charge.success',
  amount_pesewas       INTEGER NOT NULL,
  currency             TEXT NOT NULL DEFAULT 'GHS',
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'abandoned')),
  gateway_response     TEXT,
  verified_at          TEXT,
  webhook_received_at  TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Backfill: order_id (referencing the now-deprecated `orders` table)
-- never had a real target to resolve under the live architecture, so
-- purchase_session_id is set to NULL for any pre-existing row —
-- honest, since there is no way to correctly infer which
-- purchase_sessions row an old order_id-keyed row would have meant.
INSERT INTO payment_transactions_new (
  id, purchase_session_id, paystack_reference, amount_pesewas, currency, status,
  gateway_response, verified_at, webhook_received_at, created_at, updated_at
)
SELECT
  id, NULL, paystack_reference, amount_pesewas, currency, status,
  gateway_response, verified_at, webhook_received_at, created_at, updated_at
FROM payment_transactions;

DROP TABLE payment_transactions;
ALTER TABLE payment_transactions_new RENAME TO payment_transactions;

CREATE INDEX idx_payment_transactions_purchase_session ON payment_transactions(purchase_session_id);
CREATE INDEX idx_payment_transactions_status ON payment_transactions(status);

PRAGMA foreign_keys = ON;
