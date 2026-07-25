-- ============================================================
-- 0019_ownership_layer.sql — Version 3.0.2 Milestone M2
-- (Orders, Receipts & Customer Library)
--
-- Implements exactly the schema planned in
-- docs/v3.0.2-m2-database-planning-report.md, itself derived from the
-- ratified docs/v3.0.2-commerce-architecture-blueprint.md's
-- Deliverable 3 ("order_items", "licenses", "receipts") plus one
-- additional table not named in the original Blueprint text
-- (receipt_download_tokens — see that table's own header comment
-- below for why it is a new sibling table rather than a reuse of the
-- existing download_tokens table).
--
-- Scoped strictly to M2, per the M2A readiness review's Architecture
-- Compliance Report. Deliberately NOT added here (belongs to a later
-- milestone or was explicitly excluded from M2's scope):
--   - refund_requests, coupon_redemptions, notification_queue (later
--     milestones)
--   - license_type values beyond 'personal' (Licensing Enhancements —
--     explicitly excluded from M2)
--   - platform_users rename / customer_id bridge (M7)
--
-- All changes are additive: four new tables, zero ALTER TABLE
-- statements. No existing column, table, or row is altered or
-- dropped. See docs/v3.0.2-m2-database-planning-report.md's own
-- rollback strategy section for how to reverse this migration if ever
-- needed.
-- ============================================================

-- ============================================================
-- ORDER_ITEMS
-- Line items per purchase — enables bundles and multi-seat orders
-- (ADR-009), even though every product in this catalog is single-item
-- today. product_title/unit_price_pesewas are snapshotted at creation
-- time, the same discipline purchase_sessions.product_title /
-- amount_pesewas already established — a later product-content edit
-- never rewrites purchase history.
--
-- quantity semantics (ADR-009, ratified): quantity = N means
-- fulfilment generates N distinct licenses rows and N independent
-- deliveries entitlements for this line item — each seat is an
-- independently revocable grant, never one shared license with a
-- seat count.
-- ============================================================
CREATE TABLE order_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_session_id INTEGER NOT NULL REFERENCES purchase_sessions(id),
  product_id          TEXT NOT NULL,              -- matches purchase_sessions.product_id's own convention (content/products/{slug}.json's own id field, not a D1 products.id — see schema.sql's deprecation note on why purchase_sessions doesn't FK to products today)
  product_title       TEXT NOT NULL,               -- snapshotted at creation
  unit_price_pesewas  INTEGER NOT NULL CHECK (unit_price_pesewas >= 0),
  quantity             INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  asset_id             TEXT                          -- nullable — matches deliveries.asset_id's convention
);

CREATE INDEX idx_order_items_session ON order_items(purchase_session_id);
CREATE INDEX idx_order_items_product ON order_items(product_id);

-- ============================================================
-- LICENSES
-- Customer-facing, printable proof of ownership — deliberately
-- separate from deliveries (access-control). The license key is
-- explicitly never a bearer credential for access (ADR-003) — access
-- stays gated by deliveries/download tokens.
--
-- Revocation synchronization (ADR-003, binding): any process setting
-- revoked_at here must, in the same operation, set the corresponding
-- deliveries.status = 'revoked' — see
-- services/orders/revocationService.ts (Milestone M2) for the one
-- function that does this, and only this function ever sets
-- revoked_at.
--
-- customer_id is nullable, mirroring purchase_sessions.customer_id's
-- own nullability reasoning exactly: a purchase can in principle
-- verify with no confirmed email (the existing, rare
-- "provisioning_skipped_no_email" path in commerceService.ts) — a
-- license must still be creatable in that case, just unlinked to a
-- customer, the same way deliveries already never depends on
-- customer_id existing.
--
-- license_type is deliberately constrained to 'personal' only in this
-- migration — commercial/educational license types are an explicit
-- M2A scope exclusion ("Licensing Enhancements"); widen this CHECK
-- constraint in a later migration when those types actually ship, not
-- pre-declared now.
-- ============================================================
CREATE TABLE licenses (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_session_id INTEGER NOT NULL REFERENCES purchase_sessions(id),
  product_id          TEXT NOT NULL,
  customer_id         INTEGER REFERENCES customers(id),
  license_key         TEXT NOT NULL UNIQUE,
  license_type        TEXT NOT NULL DEFAULT 'personal' CHECK (license_type IN ('personal')),
  terms_version       TEXT,                          -- copied from purchase_sessions.license_version at issuance — no new consent capture
  issued_at           TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at          TEXT                           -- set only by services/orders/revocationService.ts, always alongside the matching deliveries.status = 'revoked' update
);

CREATE INDEX idx_licenses_customer ON licenses(customer_id);
CREATE INDEX idx_licenses_purchase_session ON licenses(purchase_session_id);

-- ============================================================
-- RECEIPTS
-- Persisted, regenerable proof of payment. One receipt per verified
-- purchase_sessions row (not per order_items row) — a multi-item
-- order gets one receipt with multiple line_items entries, matching
-- how a real invoice works.
--
-- tax_breakdown (ADR-008, ratified): JSON array of
-- {label, rate_percent, amount_pesewas} entries. Per the M2A Product
-- Owner decision, this business is assumed NOT VAT-registered unless
-- site configuration explicitly indicates otherwise — see
-- services/orders/taxService.ts's own header comment. The default,
-- honest answer is an empty array, never a guessed rate. tax_pesewas
-- is the derived sum of that array, computed and stored at issuance,
-- never entered independently.
--
-- total_pesewas must equal the corresponding purchase_sessions.
-- amount_pesewas — enforced at the application layer (SQLite cannot
-- cross-reference another table in a CHECK constraint), not here.
-- ============================================================
CREATE TABLE receipts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number      TEXT UNIQUE, -- nullable only for the brief instant between insert and the follow-up UPDATE that sets it from the row's own new id — NULL (never a duplicate under SQLite's UNIQUE) avoids the collision window a placeholder string would create under concurrent inserts, exactly mirroring purchase_sessions.purchase_reference's own proven pattern
  purchase_session_id INTEGER NOT NULL REFERENCES purchase_sessions(id),
  customer_id         INTEGER REFERENCES customers(id),
  issued_at           TEXT NOT NULL DEFAULT (datetime('now')),
  line_items          TEXT NOT NULL,                 -- JSON array, one entry per order_items row for this session — denormalized snapshot, not a live join
  subtotal_pesewas    INTEGER NOT NULL CHECK (subtotal_pesewas >= 0),
  discount_pesewas    INTEGER NOT NULL DEFAULT 0 CHECK (discount_pesewas >= 0), -- always 0 in M2 — no coupon system exists yet
  tax_breakdown       TEXT NOT NULL DEFAULT '[]',     -- JSON array of {label, rate_percent, amount_pesewas} — empty array is the valid, honest default for a non-VAT-registered business
  tax_pesewas         INTEGER NOT NULL DEFAULT 0 CHECK (tax_pesewas >= 0),
  total_pesewas       INTEGER NOT NULL CHECK (total_pesewas >= 0),
  tax_behavior        TEXT NOT NULL,                  -- copied from products.tax_behavior at issuance ('inclusive' | 'exclusive' | 'exempt', already a live field)
  currency             TEXT NOT NULL DEFAULT 'GHS',   -- future multi-currency readiness (ADR-008-adjacent reasoning) — no multi-currency logic ships in M2
  pdf_storage_key      TEXT                            -- R2 object key for the generated PDF (receipts/{receiptNumber}.pdf), NULL until generation completes
);

CREATE INDEX idx_receipts_customer ON receipts(customer_id);
CREATE INDEX idx_receipts_purchase_session ON receipts(purchase_session_id);

-- ============================================================
-- RECEIPT_DOWNLOAD_TOKENS
-- Single-use, short-lived token for the guest, reference-scoped
-- receipt-download action (ADR-013 tier 2: viewing a confirmation
-- page by reference alone is fine; downloading a file is an action
-- and needs its own single-use token). A SEPARATE table from the
-- existing download_tokens, deliberately: download_tokens.delivery_id
-- is NOT NULL REFERENCES deliveries(id) — widening it to also
-- (optionally) point at a receipt would mean either weakening that
-- live, security-critical constraint, or adding a second nullable
-- receipt_id column with an "exactly one of these two must be set"
-- rule SQLite cannot enforce declaratively. A small sibling table
-- costs nothing and touches nothing already live — the same reasoning
-- migration 0018 already applied when it built
-- customer_password_tokens as a sibling of password_reset_tokens
-- rather than generalizing one table to serve both purposes.
-- ============================================================
CREATE TABLE receipt_download_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL UNIQUE,
  receipt_id  INTEGER NOT NULL REFERENCES receipts(id),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_receipt_download_tokens_receipt ON receipt_download_tokens(receipt_id);
