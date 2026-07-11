-- Robayer WealthLab — D1 Migration 0002 (Version 1.2 Sprint 2.3, Commerce Foundation)
--
-- Adds purchase_sessions only — see backend/database/schema.sql for
-- the full table definition and rationale (why this is additive, not
-- built on the pre-existing orders/customers/products tables), and
-- docs/commerce-foundation.md for the architecture this supports.

CREATE TABLE purchase_sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_reference  TEXT UNIQUE,
  product_slug        TEXT NOT NULL,
  product_title       TEXT NOT NULL,
  amount_pesewas      INTEGER NOT NULL CHECK (amount_pesewas >= 0),
  currency             TEXT NOT NULL DEFAULT 'GHS',
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'abandoned', 'expired')),
  provider             TEXT NOT NULL DEFAULT 'paystack',
  provider_reference   TEXT,
  checkout_url         TEXT,
  customer_email       TEXT,
  expires_at           TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_purchase_sessions_status ON purchase_sessions(status);
CREATE INDEX idx_purchase_sessions_product ON purchase_sessions(product_slug);
CREATE INDEX idx_purchase_sessions_reference ON purchase_sessions(purchase_reference);
