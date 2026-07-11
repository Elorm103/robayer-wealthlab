-- Robayer WealthLab — Cloudflare D1 Schema (Version 1.2 Sprint 2)
--
-- STATUS: Design only. This file has never been run against a real
-- D1 database. No database exists yet. See docs/database-design.md
-- for the full field-by-field rationale behind every table.
--
-- Conventions used throughout:
--   - Every table has a surrogate INTEGER PRIMARY KEY, plus a natural
--     unique key (slug/email/reference/token) where one exists.
--   - Timestamps are TEXT in ISO 8601 (D1/SQLite has no native DATETIME
--     type; storing as text keeps values human-readable and sortable).
--   - Money is stored in the smallest currency unit (pesewas for GHS),
--     never as a float — see docs/database-design.md's note on why
--     this differs from content/products/{slug}.json's plain-Cedis
--     `price` field, and how the two stay in sync.
--   - Booleans are stored as INTEGER (0/1), SQLite's own convention.
--   - `deleted_at` (nullable) implements soft delete only where a
--     record plausibly needs hiding without losing history — see
--     docs/database-design.md for which tables use it and why.

-- ============================================================
-- PRODUCTS
-- Mirrors content/products/{slug}.json — the transactional/queryable
-- counterpart to that content file, not a replacement for it.
-- ============================================================
CREATE TABLE products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  subtitle          TEXT,
  category          TEXT NOT NULL, -- references content/categories/index.json's slug; not a D1 foreign key — see docs/database-design.md
  price_pesewas     INTEGER NOT NULL CHECK (price_pesewas >= 0),
  currency          TEXT NOT NULL DEFAULT 'GHS',
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  sku               TEXT UNIQUE,
  cover_image_key   TEXT, -- R2 object key, e.g. covers/{slug}.jpg
  download_file_key TEXT, -- R2 object key, e.g. ebooks/{slug}.pdf — never served directly, see docs/storage-strategy.md
  max_downloads     INTEGER NOT NULL DEFAULT 5,
  download_expires_days INTEGER NOT NULL DEFAULT 30,
  featured          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at        TEXT
);

CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_status ON products(status);

-- ============================================================
-- CUSTOMERS
-- Deliberately minimal — no password, no login. A customer is an
-- email address with an order history (see docs/admin-module.md's
-- "Customers" section for why no separate account system exists).
-- ============================================================
CREATE TABLE customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- ORDERS
-- This project's own business-level purchase record — distinct from
-- payment_transactions (Paystack's own record of the payment attempt).
-- ============================================================
CREATE TABLE orders (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  order_reference         TEXT NOT NULL UNIQUE, -- e.g. RWL-starting-to-invest-with-gh100-1751760000-x7f2
  customer_id             INTEGER NOT NULL REFERENCES customers(id),
  product_id              INTEGER NOT NULL REFERENCES products(id),
  amount_pesewas          INTEGER NOT NULL CHECK (amount_pesewas >= 0),
  currency                TEXT NOT NULL DEFAULT 'GHS',
  status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  payment_transaction_id  INTEGER REFERENCES payment_transactions(id),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at              TEXT
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_product ON orders(product_id);
CREATE INDEX idx_orders_status ON orders(status);

-- ============================================================
-- PAYMENT_TRANSACTIONS
-- The raw record of what Paystack reported — kept separate from
-- orders because one order can have more than one payment attempt
-- (e.g. a failed attempt followed by a successful retry).
-- ============================================================
CREATE TABLE payment_transactions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id             INTEGER REFERENCES orders(id),
  paystack_reference   TEXT NOT NULL UNIQUE,
  amount_pesewas       INTEGER NOT NULL,
  currency             TEXT NOT NULL DEFAULT 'GHS',
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'abandoned')),
  gateway_response     TEXT, -- raw Paystack response text, for support/debugging only
  verified_at          TEXT, -- set only after a server-side Verify Transaction call succeeds
  webhook_received_at  TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
  -- No deleted_at: financial transaction records are never deleted, soft or hard.
);

CREATE INDEX idx_payment_transactions_order ON payment_transactions(order_id);
CREATE INDEX idx_payment_transactions_status ON payment_transactions(status);

-- ============================================================
-- DOWNLOADS
-- The entitlement record: "this order may download this product
-- N times, until this date." Policy values are copied from the
-- product at time of purchase so a later product-policy change never
-- retroactively affects an existing buyer's entitlement.
-- ============================================================
CREATE TABLE downloads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES orders(id),
  product_id      INTEGER NOT NULL REFERENCES products(id),
  max_downloads   INTEGER NOT NULL,
  downloads_used  INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_downloads_order ON downloads(order_id);
CREATE INDEX idx_downloads_product ON downloads(product_id);

-- ============================================================
-- DOWNLOAD_TOKENS
-- One short-lived, single-use token per actual download attempt —
-- distinct from the longer-lived "downloads" entitlement above.
-- See docs/storage-strategy.md for the signed-URL flow this supports.
-- ============================================================
CREATE TABLE download_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL UNIQUE,
  download_id INTEGER NOT NULL REFERENCES downloads(id),
  expires_at  TEXT NOT NULL, -- short TTL (minutes), independent of downloads.expires_at
  used_at     TEXT, -- set once redeemed; a used token is never valid again
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_download_tokens_download ON download_tokens(download_id);

-- ============================================================
-- NEWSLETTER_SUBSCRIBERS
-- ============================================================
CREATE TABLE newsletter_subscribers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email            TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'subscribed' CHECK (status IN ('subscribed', 'unsubscribed')),
  source           TEXT, -- e.g. "homepage-footer", "consultation-page" — honest provenance, not guessed
  subscribed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  unsubscribed_at  TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_newsletter_subscribers_status ON newsletter_subscribers(status);

-- ============================================================
-- CONSULTATION_REQUESTS
-- Mirrors the fields already collected by consultation/index.html's
-- form (Sprint 3) — this table is what that form should eventually
-- submit to, closing the "form submits nowhere" gap flagged in
-- docs/admin-module.md.
-- ============================================================
CREATE TABLE consultation_requests (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  name                      TEXT NOT NULL,
  email                     TEXT NOT NULL,
  phone                     TEXT,
  country                   TEXT NOT NULL,
  category                  TEXT NOT NULL,
  description               TEXT NOT NULL,
  preferred_contact_method  TEXT NOT NULL CHECK (preferred_contact_method IN ('email', 'phone')),
  consent_given             INTEGER NOT NULL DEFAULT 0,
  status                    TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'responded', 'closed')),
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at                TEXT
);

CREATE INDEX idx_consultation_requests_status ON consultation_requests(status);
CREATE INDEX idx_consultation_requests_email ON consultation_requests(email);

-- ============================================================
-- CONTACT_MESSAGES
-- Added in Version 1.2 Sprint 3. Mirrors contact/index.html's existing
-- form fields exactly (Name, Email, Phone, Message). Distinct from
-- consultation_requests because a general enquiry has no category,
-- no preferred contact method, and no consultation-specific manual-
-- review workflow — conflating the two would blur a real distinction
-- already established on the live site (docs/commerce-architecture.md's
-- Phase 1 audit: general enquiries vs. consultation requests are
-- deliberately kept apart).
-- ============================================================
CREATE TABLE contact_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'responded', 'closed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT
);

CREATE INDEX idx_contact_messages_status ON contact_messages(status);
CREATE INDEX idx_contact_messages_email ON contact_messages(email);

-- ============================================================
-- ADMIN_USERS
-- ============================================================
CREATE TABLE admin_users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL, -- hashing algorithm decided in docs/authentication-strategy.md; never plain text
  role           TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('super_admin', 'editor', 'support')),
  is_active      INTEGER NOT NULL DEFAULT 1,
  last_login_at  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT
);

-- ============================================================
-- AUDIT_LOGS
-- Append-only by design — no deleted_at. Deleting an audit record
-- would defeat the reason it exists.
-- ============================================================
CREATE TABLE audit_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('admin', 'system', 'customer')),
  actor_id     INTEGER, -- nullable: system-initiated actions have no actor
  action       TEXT NOT NULL, -- e.g. 'product.updated', 'order.refunded', 'admin.login'
  entity_type  TEXT,
  entity_id    INTEGER,
  metadata     TEXT, -- free-form JSON blob, e.g. { "before": {...}, "after": {...} }
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);

-- ============================================================
-- EMAIL_LOG
-- Added alongside docs/email-architecture.md. Tracks every outbound
-- email attempt so a failed send can be retried by a scheduled Worker
-- (Cron Trigger) without ever blocking the business action that
-- triggered it (see docs/email-architecture.md's "Retry strategy").
-- Uses the same generic entity_type/entity_id pattern as audit_logs,
-- since one send can relate to an order, a consultation request, a
-- newsletter subscriber, or (future) an admin user.
-- ============================================================
CREATE TABLE email_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  template       TEXT NOT NULL, -- e.g. 'purchase-receipt', matching backend/emails/templates/{name}.html
  recipient      TEXT NOT NULL,
  entity_type    TEXT, -- e.g. 'order', 'consultation_request', 'newsletter_subscriber'
  entity_id      INTEGER,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'permanently_failed')),
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  provider_id    TEXT, -- Resend's own message ID, once sent — for cross-referencing a bounce/complaint webhook back to this row
  sent_at        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  -- No deleted_at: a send log is a factual record of what was attempted, not something to hide — matches audit_logs' reasoning.
);

CREATE INDEX idx_email_log_status ON email_log(status);
CREATE INDEX idx_email_log_entity ON email_log(entity_type, entity_id);
