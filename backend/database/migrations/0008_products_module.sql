-- Robayer WealthLab — D1 Migration 0008 (Version 2.0 Phase 2: Products Module)
--
-- See docs/v2-products-module-spec.md for the full design.
--
-- Part 1: retire the deprecated, never-populated products/customers/
-- orders/downloads cluster (backend/database/schema.sql's own header
-- comment above `products` already documented these as "designed
-- before Sprint 2.1 pivoted the real catalog to content JSON... do not
-- build new code against these"). Verified before this migration was
-- written: 0 rows in all four tables in production, no live code path
-- references any of them (the JSON-catalog services always read
-- content/products/*.json instead), and no table this project still
-- uses (purchase_sessions, payment_transactions, deliveries,
-- download_tokens) has ever had a foreign key into this group — see
-- the migration safety report produced alongside this file. Dropped in
-- FK-dependency order: downloads (-> orders, products) first, then
-- orders (-> customers, products), then products, then customers.
DROP TABLE IF EXISTS downloads;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS customers;

-- ============================================================
-- PRODUCTS
-- The real, live product catalog — replaces content/products/*.json as
-- the source of truth. `product_id` (not `id`) is the stable string
-- identifier locked into Paystack checkout metadata and cross-checked
-- at payment verification (see backend/services/commerceService.ts) —
-- kept as its own column, separate from the surrogate `id`, because
-- the legacy JSON catalog's `id` field ("prod-{slug}") is already
-- referenced by real purchase_sessions.product_id values and must
-- resolve identically after migration. `slug` can change later (a
-- rename/SEO fix) without orphaning purchase history tied to
-- `product_id`, matching content/SCHEMA.md's original reasoning for
-- keeping the two separate.
--
-- `status` is a single field covering both the publish lifecycle
-- (draft -> active -> archived) and the "Inventory"/visibility states
-- the Phase 2 brief asks for (hidden, unavailable) — extending the
-- same single-status-field convention the legacy JSON model already
-- used (draft/active/archived/coming-soon) rather than introducing a
-- second, overlapping state machine that could produce contradictory
-- combinations (e.g. "draft" + "active inventory").
--
-- `cover_media_id`/`thumbnail_media_id`/`preview_media_id`/
-- `og_media_id` reference `media_assets(id)` directly — per the Phase 2
-- brief's "select from Media Library, use Media Library IDs, never
-- duplicate uploads" requirement. See product_files below for why
-- downloadable files are handled with one extra security check instead
-- of a plain reference.
-- ============================================================
CREATE TABLE products (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id                  TEXT NOT NULL UNIQUE, -- e.g. "prod-starting-to-invest-with-gh100" — locked into Paystack metadata, see commerceService.ts
  slug                        TEXT NOT NULL UNIQUE,
  title                       TEXT NOT NULL,
  subtitle                    TEXT,
  short_description           TEXT,
  description                 TEXT, -- rich HTML from the admin's lightweight editor

  topic                       TEXT NOT NULL CHECK (topic IN ('investing', 'personal-finance', 'budgeting', 'business', 'mindset')), -- matches content/topics/index.json's existing taxonomy
  product_type                TEXT NOT NULL CHECK (product_type IN ('ebook', 'guide', 'template', 'spreadsheet', 'report', 'checklist', 'course')), -- matches content/product-types/index.json's existing taxonomy

  status                      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'coming-soon', 'archived', 'hidden', 'unavailable')),

  price_pesewas                INTEGER CHECK (price_pesewas IS NULL OR price_pesewas >= 0), -- NULL only for draft/coming-soon products with no announced price yet
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
  tags                         TEXT, -- comma-separated, matching media_assets' convention

  max_downloads                INTEGER, -- download policy snapshot source for fulfilmentService.ts — NULL = unlimited
  download_expires_days        INTEGER, -- NULL = lifetime access

  seo_title                    TEXT,
  seo_description              TEXT,
  seo_canonical_url            TEXT,

  published_at                 TEXT,
  created_by                   INTEGER REFERENCES admin_users(id),
  updated_by                   INTEGER REFERENCES admin_users(id),
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at                   TEXT -- soft delete/restore, matching media_assets' convention
);

CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_topic ON products(topic);
CREATE INDEX idx_products_product_type ON products(product_type);
CREATE INDEX idx_products_featured ON products(featured);
CREATE INDEX idx_products_deleted_at ON products(deleted_at);
CREATE INDEX idx_products_created_at ON products(created_at);

-- ============================================================
-- PRODUCT_FILES
-- One row per downloadable digital asset — replaces content
-- JSON's `downloadFiles[]` array. `asset_id` is the stable identifier
-- backend/services/entitlementService.ts's `deliveries.asset_id` rows
-- already reference; migration 0009 (the data migration, run
-- separately) preserves the exact legacy asset_id strings so existing
-- deliveries keep resolving.
--
-- `media_id` references media_assets(id) directly — the file's real
-- bytes live in Media Library, never duplicated. Security note: unlike
-- cover/gallery images (meant to be public), a paid product's
-- downloadable file must never be reachable through Media Library's
-- public, unauthenticated GET /api/media/file/:key route — see
-- routes/media.ts's updated handler, which denies (identical 404) any
-- storage key that resolves to a product_files row on a product whose
-- price_pesewas > 0, forcing paid files through the existing
-- entitlement -> download-token flow instead. Free products' files
-- remain publicly fetchable through Media Library as normal.
-- ============================================================
CREATE TABLE product_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  asset_id      TEXT NOT NULL UNIQUE, -- e.g. "asset-starting-to-invest-with-gh100-pdf-v1" — never regenerated once created, see deliveries.asset_id
  media_id      INTEGER NOT NULL REFERENCES media_assets(id),
  display_name  TEXT NOT NULL,
  file_type     TEXT NOT NULL, -- PDF/ZIP/XLSX/etc, mirrors productCatalogService.ts's DigitalAsset.fileType
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
-- reference (never a duplicated upload) with an explicit sort order.
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
-- edge. Deliberately directed, not symmetric (product A can relate to
-- B without B necessarily relating back to A), matching how an admin
-- actually curates these by hand.
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
