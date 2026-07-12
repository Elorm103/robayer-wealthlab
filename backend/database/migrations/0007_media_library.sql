-- Robayer WealthLab — D1 Migration 0007 (Version 2.0 Phase 1: Media Library)
--
-- See docs/v2-media-library-spec.md for the full design and
-- docs/v2-database-expansion.md's earlier `media_assets` sketch, which
-- this extends to cover every field the current phase actually needs
-- (original_filename, mime_type, width/height, public_url, title,
-- description, tags, status, media_type, content_hash, thumbnail
-- storage — none of that was in the earlier sketch).
--
-- One change: a genuinely new table. R2 (`STORAGE` binding, real
-- bucket `robayer-wealthlab-storage`) already exists and already holds
-- exactly one real object (`ebooks/starting-to-invest-with-gh100.pdf`,
-- confirmed via the Cloudflare API before writing this migration) —
-- this is the first migration to ever write an UPLOAD pipeline against
-- it. Every Media Library object is stored under a `media/` prefix,
-- deliberately distinct from the `ebooks/`/`covers/`/`receipts/`/etc.
-- prefixes storage/README.md already plans for the separate,
-- pre-existing entitlement/digital-fulfilment system — these are two
-- different domains (public CMS assets vs. paid, purchase-gated files)
-- that happen to share one R2 bucket, not one system.

CREATE TABLE media_assets (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Identity / file facts
  filename              TEXT NOT NULL,   -- the safe, generated filename actually used (see utils/mediaValidation.ts's sanitizeFilename())
  original_filename     TEXT NOT NULL,   -- as uploaded, sanitized for display only — never used to build the storage_key (prevents path traversal by construction)
  mime_type             TEXT NOT NULL,
  size_bytes            INTEGER NOT NULL,
  width                 INTEGER,         -- images only; extracted server-side from the real file bytes, never trusted from the client
  height                INTEGER,         -- images only
  content_hash          TEXT NOT NULL,   -- SHA-256 hex of the file bytes — the actual duplicate-detection key, not the filename

  -- Storage
  storage_key           TEXT NOT NULL UNIQUE,   -- real R2 object key, media/{images|documents}/{folder}/{uuid}.{ext} — always server-generated
  public_url             TEXT NOT NULL,          -- denormalized on purpose: derived once from storage_key at upload time so list/search queries never need to recompute it; see mediaService.ts's buildPublicUrl()
  thumbnail_storage_key TEXT,                    -- images only; a genuinely separate R2 object (client-generated downscaled copy), not a resize-on-read
  thumbnail_public_url  TEXT,

  -- Classification
  media_type            TEXT NOT NULL CHECK (media_type IN ('image', 'document')),
  folder                TEXT NOT NULL DEFAULT 'uncategorized' CHECK (folder IN ('books', 'blog', 'resources', 'branding', 'uncategorized')),

  -- Editorial metadata
  alt_text              TEXT,   -- accessibility — surfaced as required-before-public-use in the UI, not enforced at the DB level (a draft upload may not have it yet)
  title                 TEXT,
  description           TEXT,
  tags                  TEXT,   -- comma-separated; no separate tags table at this realistic scale, matching media-library-spec.md's "Search" reasoning

  -- Lifecycle
  status                TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'processing', 'failed')),  -- always 'ready' today (upload is fully synchronous); 'processing'/'failed' exist for a future async pipeline (e.g. virus scanning — see utils/mediaValidation.ts's scanForThreats() hook) that does not run yet
  uploaded_by           INTEGER REFERENCES admin_users(id),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at             TEXT   -- soft delete only, matching every other table's convention in this schema (admin_users, consultation_requests, etc.) — the real R2 object is not removed when this is set
);

CREATE INDEX idx_media_assets_folder ON media_assets(folder);
CREATE INDEX idx_media_assets_media_type ON media_assets(media_type);
CREATE INDEX idx_media_assets_content_hash ON media_assets(content_hash);
CREATE INDEX idx_media_assets_deleted_at ON media_assets(deleted_at);
CREATE INDEX idx_media_assets_created_at ON media_assets(created_at);
