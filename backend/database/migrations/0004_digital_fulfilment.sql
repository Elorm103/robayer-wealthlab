-- Robayer WealthLab — D1 Migration 0004 (Version 1.2 Sprint 2.5, Digital Fulfilment Platform)
--
-- See backend/database/schema.sql for full column-by-column rationale
-- and docs/digital-fulfilment.md for the architecture this supports.
--
-- Two changes:
--   1. New `deliveries` table — the real entitlement record, replacing
--      the deprecated `downloads` table (left untouched, not migrated
--      into this one — it never had a real target under the live
--      architecture, same as `orders`/`customers`/`products`, so there
--      is no real data to carry forward).
--   2. `download_tokens.download_id` (referencing the now-deprecated
--      `downloads`) replaced by `delivery_id` (referencing the new
--      `deliveries`) — requires a table recreate, since SQLite cannot
--      ALTER a foreign key's target table in place. No real data
--      exists in `download_tokens` either (never implemented before
--      this sprint), so this is a structural recreate, not a data
--      migration.

PRAGMA foreign_keys = OFF;

-- ============================================================
-- 1. deliveries
-- ============================================================
CREATE TABLE deliveries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_session_id INTEGER NOT NULL REFERENCES purchase_sessions(id),
  asset_id            TEXT NOT NULL,
  product_slug        TEXT NOT NULL,
  max_downloads       INTEGER,
  access_expires_at   TEXT,
  downloads_used      INTEGER NOT NULL DEFAULT 0,
  last_download_at    TEXT,
  status              TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'delivered', 'revoked')),
  delivered_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_deliveries_session_asset ON deliveries(purchase_session_id, asset_id);
CREATE INDEX idx_deliveries_status ON deliveries(status);

-- ============================================================
-- 2. download_tokens (recreate with the new FK target)
-- ============================================================
CREATE TABLE download_tokens_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL UNIQUE,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

DROP TABLE download_tokens;
ALTER TABLE download_tokens_new RENAME TO download_tokens;

CREATE INDEX idx_download_tokens_delivery ON download_tokens(delivery_id);

PRAGMA foreign_keys = ON;
