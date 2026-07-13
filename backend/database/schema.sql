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
-- PAYMENT_TRANSACTIONS
-- The raw, append-only record of every webhook delivery this project
-- has received from Paystack — kept separate from purchase_sessions
-- because one purchase session can have more than one payment/webhook
-- attempt (a failed charge followed by a successful retry, or Paystack
-- redelivering the same webhook). This is Sprint 2.4's primary
-- idempotency ledger: `paystack_reference UNIQUE` means a duplicate
-- webhook delivery for the same transaction fails to insert a second
-- row (INSERT OR IGNORE, checked via rows-affected) rather than racing
-- a read-then-write check — see docs/payment-verification.md's
-- "Idempotency" for the full two-layer design (this table, plus the
-- status-gated conditional UPDATE on purchase_sessions itself).
--
-- Updated Version 1.2 Sprint 2.4: `order_id` (referencing an
-- earlier-planned `orders` table that was never populated under the
-- live architecture, and was dropped entirely in migration 0008,
-- Version 2.0 Phase 2) is replaced by `purchase_session_id`,
-- referencing the real, live checkout record.
-- ============================================================
CREATE TABLE payment_transactions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_session_id  INTEGER REFERENCES purchase_sessions(id), -- nullable: a webhook could in principle arrive for a reference with no matching session (see docs/payment-verification.md) — the row is still recorded for audit, just with no session to link
  paystack_reference   TEXT NOT NULL UNIQUE,
  event_type           TEXT NOT NULL, -- e.g. "charge.success", "charge.failed" — the raw Paystack webhook event name, for audit
  amount_pesewas       INTEGER NOT NULL,
  currency             TEXT NOT NULL DEFAULT 'GHS',
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'abandoned')),
  gateway_response     TEXT, -- raw webhook payload (JSON text), for support/debugging only — never contains a secret, Paystack doesn't echo API keys in webhook bodies
  verified_at          TEXT, -- set only after a server-side Verify Transaction call succeeds
  webhook_received_at  TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
  -- No deleted_at: financial transaction records are never deleted, soft or hard.
);

CREATE INDEX idx_payment_transactions_purchase_session ON payment_transactions(purchase_session_id);
CREATE INDEX idx_payment_transactions_status ON payment_transactions(status);

-- ============================================================
-- DELIVERIES
-- Added in Version 1.2 Sprint 2.5 (Digital Fulfilment Platform) — see
-- docs/digital-fulfilment.md. The real entitlement record: "this
-- purchase may download this specific digital asset, N times, until
-- this date (or unlimited/lifetime — see `content/SCHEMA.md`'s
-- `downloads` policy object)." One row per (purchase, asset) pair,
-- created once, atomically, at fulfilment time (right after payment
-- verification succeeds — see backend/services/fulfilmentService.ts).
--
-- Policy values (`max_downloads`, `access_expires_at`) are snapshotted
-- from the product's `downloads` policy **at fulfilment time**, same
-- reasoning as `purchase_sessions.product_title`/`amount_pesewas`: a
-- later policy change on the product never retroactively affects an
-- already-granted entitlement.
--
-- Deliberately references `purchase_sessions`, not a `products` row
-- directly — `asset_id` is a plain TEXT value matching a
-- `product_files.asset_id` (Version 2.0 Phase 2 — see migration
-- 0008_products_module.sql), so a later product edit (even a file
-- swap) never retroactively affects an already-granted entitlement.
-- ============================================================
CREATE TABLE deliveries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_session_id INTEGER NOT NULL REFERENCES purchase_sessions(id),
  asset_id            TEXT NOT NULL, -- content/products/{slug}.json's downloadFiles[].assetId
  product_slug        TEXT NOT NULL, -- denormalized snapshot, same convenience/audit reasoning as purchase_sessions.product_title
  max_downloads       INTEGER, -- NULL = unlimited, snapshotted from the product's download policy at fulfilment time
  access_expires_at   TEXT, -- NULL = lifetime access, snapshotted from the product's download policy at fulfilment time
  downloads_used      INTEGER NOT NULL DEFAULT 0, -- incremented only at actual file-download (download_tokens redemption), not at token issuance — see docs/digital-fulfilment.md
  last_download_at    TEXT,
  status              TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'delivered', 'revoked')),
  delivered_at        TEXT, -- set once the fulfilment email is successfully sent
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- UNIQUE, not just indexed: makes fulfilment idempotent by construction
-- (INSERT OR IGNORE, same pattern as payment_transactions.paystack_reference)
-- — re-running fulfilment for a purchase that was already fulfilled
-- (e.g. after a transient failure) can never create a duplicate
-- entitlement, only recognize the existing one.
CREATE UNIQUE INDEX idx_deliveries_session_asset ON deliveries(purchase_session_id, asset_id);
CREATE INDEX idx_deliveries_status ON deliveries(status);

-- ============================================================
-- DOWNLOAD_TOKENS
-- One short-lived, single-use token per actual download attempt —
-- distinct from the longer-lived `deliveries` entitlement above. See
-- docs/storage-strategy.md for the signed-URL flow this supports, and
-- docs/digital-fulfilment.md for how Sprint 2.5 wires it up.
--
-- Updated Version 1.2 Sprint 2.5: `download_id` (referencing an
-- earlier-planned `downloads` table that was never populated under
-- the live architecture, and was dropped entirely in migration 0008,
-- Version 2.0 Phase 2) is replaced by `delivery_id`, referencing
-- `deliveries`.
-- ============================================================
CREATE TABLE download_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL UNIQUE,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  expires_at  TEXT NOT NULL, -- short TTL (minutes), independent of deliveries.access_expires_at
  used_at     TEXT, -- set once redeemed; a used token is never valid again
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_download_tokens_delivery ON download_tokens(delivery_id);

-- ============================================================
-- PURCHASE_SESSIONS
-- Added in Version 1.2 Sprint 2.3 (Commerce Foundation) — see
-- docs/commerce-foundation.md. This is the record created the moment
-- a visitor clicks Buy, before any payment provider is contacted. It
-- IS this project's order-equivalent record — see the deprecation note
-- above `products`/`customers`/`orders` for how Sprint 2.4 resolved
-- Sprint 2.3's flagged open question.
--
-- Updated Version 1.2 Sprint 2.4 (Payment Verification) — see
-- docs/payment-verification.md:
--   - `status` enum revised: `paid` renamed to `verified` (this
--     project's Worker *verifies* a payment; "paid" undersold what
--     Sprint 2.4 actually confirms), `abandoned` removed (it was never
--     reachable by any Sprint 2.3 code path — a webhook-driven design
--     has no natural trigger for it; Paystack's own "abandoned"
--     transaction status, when it occurs, is treated as this table's
--     `failed`, not a distinct state — see docs/payment-verification.md's
--     "Purchase state machine"), `cancelled` and `refunded` added
--     (schema-provisioned for a future admin action / refunds sprint;
--     not reachable by any code this sprint either, documented
--     explicitly rather than left implicit, same pattern as the
--     now-removed `abandoned`).
--   - `product_id`/`product_version` added: locked at checkout time
--     (alongside `product_slug`) from content/products/{slug}.json,
--     and sent as Paystack metadata — verification cross-checks the
--     provider's echoed-back metadata against these LOCKED values,
--     not a fresh re-fetch, so a legitimate content edit mid-checkout
--     (e.g. a version bump) is caught as a genuine inconsistency
--     rather than silently ignored. See docs/payment-verification.md's
--     "Metadata verification."
--   - `verified_at`/`provider_status` added: set only once
--     verification succeeds; `provider_status` records Paystack's own
--     raw status string for audit, distinct from this table's own
--     `status` (this project's business-state vocabulary).
-- ============================================================
CREATE TABLE purchase_sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_reference  TEXT UNIQUE, -- e.g. "RWL-2026-000001" — see backend/utils/purchaseReference.ts. Nullable only for the brief instant between insert and the follow-up UPDATE that sets it from the row's own new id; NULL (never a duplicate under SQLite's UNIQUE) avoids a collision window a placeholder string would create under concurrent inserts.
  product_slug        TEXT NOT NULL, -- content/products/{slug}.json — the Product Platform is the source of truth, not a D1 products table (see deprecation note above)
  product_id          TEXT NOT NULL, -- content/products/{slug}.json's own `id` field (e.g. "prod-starting-to-invest-with-gh100") — locked at checkout time, cross-checked at verification, see note above
  product_version     TEXT, -- e.g. "1.0" — nullable (some products haven't set one); locked at checkout time, cross-checked at verification
  product_title       TEXT NOT NULL, -- snapshotted at session-creation time so a later product-content edit never rewrites purchase history
  amount_pesewas      INTEGER NOT NULL CHECK (amount_pesewas >= 0),
  currency             TEXT NOT NULL DEFAULT 'GHS',
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'expired', 'cancelled', 'refunded')),
  provider             TEXT NOT NULL DEFAULT 'paystack', -- the payment-provider abstraction key, see backend/services/payments/
  provider_reference   TEXT, -- the provider's own transaction reference, once it returns one — never the primary identifier, see docs/commerce-foundation.md
  provider_status      TEXT, -- the provider's own raw status string at verification time (e.g. "success") — audit only, see note above
  checkout_url         TEXT, -- the URL the visitor was redirected to; kept for support/debugging
  customer_email       TEXT, -- unknown at session-creation time (the frontend sends only the product identifier); filled in at verification from the provider's own confirmed payer email, never trusted from the client
  verified_at          TEXT, -- set only once verification succeeds (status transitions to 'verified') — the moment Sprint 2.5 delivery is allowed to trust
  expires_at           TEXT NOT NULL, -- short TTL (see backend/services/commerceService.ts) — a session that never resolves should not stay "pending" forever
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
  -- No deleted_at: like payment_transactions, a purchase session is a factual record of a purchase attempt, never hidden.
);

CREATE INDEX idx_purchase_sessions_status ON purchase_sessions(status);
CREATE INDEX idx_purchase_sessions_product ON purchase_sessions(product_slug);
CREATE INDEX idx_purchase_sessions_reference ON purchase_sessions(purchase_reference);

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
-- `name`/`totp_secret` added in migration 0006 (Version 2.0 Phase 0.1,
-- Authentication Foundation) — see docs/v2-authentication-design.md.
-- `password_hash` stores PBKDF2-SHA256 output as `salt:iterations:hash`,
-- decided in docs/v2-authentication-design.md's "Password hashing".
-- ============================================================
CREATE TABLE admin_users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL, -- PBKDF2-SHA256, stored as "salt:iterations:hash"; never plain text
  role           TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('super_admin', 'editor', 'support')),
  is_active      INTEGER NOT NULL DEFAULT 1,
  last_login_at  TEXT,
  name           TEXT, -- display name for audit-log readability; nullable
  totp_secret    TEXT, -- nullable; populated only if/when 2FA is turned on for that user (not built in Phase 0.1)
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT
);

-- ============================================================
-- ADMIN_SESSIONS
-- Added in migration 0006 (Version 2.0 Phase 0.1, Authentication
-- Foundation) — see docs/v2-authentication-design.md. One row per
-- active login. Mirrors download_tokens'/unsubscribe_tokens' proven
-- shape (random unique token, expires_at, a nullable "consumed"
-- marker — here `revoked_at`) with the two additions a browser session
-- needs: `csrf_secret` (double-submit CSRF pattern) and `last_seen_at`
-- (sliding-expiry window, capped at 12h absolute lifetime).
-- ============================================================
CREATE TABLE admin_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT NOT NULL UNIQUE,        -- 256-bit, same generation pattern as download/unsubscribe tokens
  admin_id     INTEGER NOT NULL REFERENCES admin_users(id),
  csrf_secret  TEXT NOT NULL,               -- per-session, backs the double-submit CSRF pattern
  ip_created   TEXT,                        -- CF-Connecting-IP at login, audit/anomaly context only, never an access decision
  user_agent   TEXT,
  expires_at   TEXT NOT NULL,               -- absolute 12h lifetime, refreshed (slid) on activity up to that cap
  revoked_at   TEXT,                        -- set on logout; a revoked session is never valid again regardless of expires_at
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id);
CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);

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

-- ============================================================
-- UNSUBSCRIBE_TOKENS
-- Added for newsletter compliance (docs/newsletter-unsubscribe-design.md).
-- Mirrors download_tokens' proven shape/pattern exactly: single-use,
-- expiring, atomically-consumed. One outstanding unused token per
-- subscriber is generated lazily (on first need, e.g. the next email
-- sent to them) rather than backfilled for every existing row.
-- ============================================================
CREATE TABLE unsubscribe_tokens (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token          TEXT NOT NULL UNIQUE,
  subscriber_id  INTEGER NOT NULL REFERENCES newsletter_subscribers(id),
  expires_at     TEXT NOT NULL,
  used_at        TEXT, -- set once redeemed; a used token is never valid again
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- MEDIA_ASSETS
-- Added in migration 0007 (Version 2.0 Phase 1, Media Library) — see
-- docs/v2-media-library-spec.md. The Media Library's own index over R2
-- (real bucket `robayer-wealthlab-storage`, binding `STORAGE`) — R2 has
-- no native browse/search/folder UI of its own. Every object lives
-- under a `media/` R2 prefix, deliberately distinct from the
-- `ebooks/`/`covers/`/etc. prefixes the separate, pre-existing paid
-- digital-fulfilment system (deliveries/download_tokens) uses — two
-- different domains sharing one bucket, not one system.
-- ============================================================
CREATE TABLE media_assets (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  filename               TEXT NOT NULL,   -- the safe, generated filename actually used
  original_filename      TEXT NOT NULL,   -- as uploaded, sanitized for display only — never used to build storage_key
  mime_type              TEXT NOT NULL,
  size_bytes             INTEGER NOT NULL,
  width                  INTEGER,         -- images only; extracted server-side from real file bytes, never trusted from the client
  height                 INTEGER,         -- images only
  content_hash           TEXT NOT NULL,   -- SHA-256 hex of the file bytes — the real duplicate-detection key
  storage_key            TEXT NOT NULL UNIQUE,
  public_url             TEXT NOT NULL,   -- denormalized on purpose — derived once at upload time so list/search never recomputes it
  thumbnail_storage_key  TEXT,            -- images only; a genuinely separate R2 object (client-generated), not resize-on-read
  thumbnail_public_url   TEXT,
  media_type             TEXT NOT NULL CHECK (media_type IN ('image', 'document')),
  folder                 TEXT NOT NULL DEFAULT 'uncategorized' CHECK (folder IN ('books', 'blog', 'resources', 'branding', 'uncategorized')),
  alt_text               TEXT,
  title                  TEXT,
  description            TEXT,
  tags                   TEXT,            -- comma-separated; no separate tags table at this scale
  status                 TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'processing', 'failed')),
  uploaded_by            INTEGER REFERENCES admin_users(id),
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at             TEXT
);

CREATE INDEX idx_media_assets_folder ON media_assets(folder);
CREATE INDEX idx_media_assets_media_type ON media_assets(media_type);
CREATE INDEX idx_media_assets_content_hash ON media_assets(content_hash);
CREATE INDEX idx_media_assets_deleted_at ON media_assets(deleted_at);
CREATE INDEX idx_media_assets_created_at ON media_assets(created_at);

CREATE INDEX idx_unsubscribe_tokens_subscriber ON unsubscribe_tokens(subscriber_id);

-- ============================================================
-- PRODUCTS
-- Added in migration 0008 (Version 2.0 Phase 2, Products Module) — see
-- docs/v2-products-module-spec.md. The real, live product catalog,
-- replacing content/products/*.json as the source of truth. Also in
-- this migration: the never-populated `products`/`customers`/`orders`/
-- `downloads` cluster from Version 1.2 Sprint 1 planning (formerly
-- documented just above `payment_transactions` in this file) was
-- dropped entirely — 0 rows in production, verified with no live code
-- or foreign key depending on any of the four before removal.
--
-- `product_id` (not `id`) is the stable string identifier locked into
-- Paystack checkout metadata and cross-checked at payment verification
-- (see backend/services/commerceService.ts) — kept separate from the
-- surrogate `id` because real purchase_sessions.product_id values
-- already reference the legacy JSON catalog's "prod-{slug}" strings
-- and must resolve identically after migration. `slug` can change
-- later without orphaning purchase history tied to `product_id`.
--
-- `status` is a single field covering both the publish lifecycle
-- (draft -> active -> archived) and the "Inventory"/visibility states
-- the Phase 2 brief asks for (hidden, unavailable) — extending the
-- same single-status-field convention the legacy JSON model already
-- used, rather than a second, overlapping state machine.
-- ============================================================
CREATE TABLE products (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id                  TEXT NOT NULL UNIQUE,
  slug                        TEXT NOT NULL UNIQUE,
  title                       TEXT NOT NULL,
  subtitle                    TEXT,
  short_description           TEXT,
  description                 TEXT,

  topic                       TEXT NOT NULL CHECK (topic IN ('investing', 'personal-finance', 'budgeting', 'business', 'mindset')),
  product_type                TEXT NOT NULL CHECK (product_type IN ('ebook', 'guide', 'template', 'spreadsheet', 'report', 'checklist', 'course')),

  status                      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'coming-soon', 'archived', 'hidden', 'unavailable')),

  price_pesewas                INTEGER CHECK (price_pesewas IS NULL OR price_pesewas >= 0),
  compare_at_price_pesewas     INTEGER CHECK (compare_at_price_pesewas IS NULL OR compare_at_price_pesewas >= 0),
  currency                     TEXT NOT NULL DEFAULT 'GHS',
  pricing_model                TEXT NOT NULL DEFAULT 'one-time' CHECK (pricing_model IN ('one-time')),
  tax_behavior                 TEXT NOT NULL DEFAULT 'inclusive' CHECK (tax_behavior IN ('inclusive', 'exclusive', 'exempt')),

  sku                          TEXT UNIQUE,
  version                      TEXT,
  language                     TEXT NOT NULL DEFAULT 'en',
  estimated_reading_time       INTEGER,
  author                       TEXT,

  cover_media_id               INTEGER REFERENCES media_assets(id),
  thumbnail_media_id           INTEGER REFERENCES media_assets(id),
  preview_media_id             INTEGER REFERENCES media_assets(id),
  og_media_id                  INTEGER REFERENCES media_assets(id),

  featured                     INTEGER NOT NULL DEFAULT 0,
  bestseller                   INTEGER NOT NULL DEFAULT 0,
  new_release                  INTEGER NOT NULL DEFAULT 0,
  tags                         TEXT,

  max_downloads                INTEGER,
  download_expires_days        INTEGER,

  seo_title                    TEXT,
  seo_description              TEXT,
  seo_canonical_url            TEXT,

  published_at                 TEXT,
  created_by                   INTEGER REFERENCES admin_users(id),
  updated_by                   INTEGER REFERENCES admin_users(id),
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at                   TEXT
);

CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_topic ON products(topic);
CREATE INDEX idx_products_product_type ON products(product_type);
CREATE INDEX idx_products_featured ON products(featured);
CREATE INDEX idx_products_deleted_at ON products(deleted_at);
CREATE INDEX idx_products_created_at ON products(created_at);

-- ============================================================
-- PRODUCT_FILES
-- One row per downloadable digital asset, replacing content JSON's
-- `downloadFiles[]` array. `asset_id` is the stable identifier
-- `deliveries.asset_id` rows reference — preserved exactly for
-- existing products during data migration so existing deliveries keep
-- resolving. `media_id` references media_assets(id) directly — the
-- file's real bytes live in Media Library, never duplicated.
--
-- Security: unlike cover/gallery images (meant to be public), a paid
-- product's downloadable file must never be reachable through Media
-- Library's public, unauthenticated GET /api/media/file/:key route —
-- see routes/media.ts, which denies (identical 404) any storage key
-- that resolves to a product_files row on a product with
-- price_pesewas > 0, forcing paid files through the existing
-- entitlement -> download-token flow instead.
-- ============================================================
CREATE TABLE product_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  asset_id      TEXT NOT NULL UNIQUE,
  media_id      INTEGER NOT NULL REFERENCES media_assets(id),
  display_name  TEXT NOT NULL,
  file_type     TEXT NOT NULL,
  version       TEXT,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_product_files_product ON product_files(product_id);
CREATE INDEX idx_product_files_media ON product_files(media_id);

-- ============================================================
-- PRODUCT_GALLERY
-- Many-to-many: a product's gallery images, each a media_assets
-- reference with an explicit sort order.
-- ============================================================
CREATE TABLE product_gallery (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  media_id    INTEGER NOT NULL REFERENCES media_assets(id),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_product_gallery_unique ON product_gallery(product_id, media_id);

-- ============================================================
-- PRODUCT_RELATIONS
-- Related products / cross-sells / recommended — one row per directed
-- edge (product A can relate to B without B relating back to A).
-- ============================================================
CREATE TABLE product_relations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id          INTEGER NOT NULL REFERENCES products(id),
  related_product_id  INTEGER NOT NULL REFERENCES products(id),
  relation_type       TEXT NOT NULL CHECK (relation_type IN ('related', 'cross_sell', 'recommended')),
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_product_relations_unique ON product_relations(product_id, related_product_id, relation_type);
CREATE INDEX idx_product_relations_product ON product_relations(product_id);
