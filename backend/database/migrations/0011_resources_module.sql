-- ============================================================
-- 0011_resources_module.sql — Version 2.1 Phase 1 (Resources CMS)
--
-- Replaces the hand-authored static .resource-card markup in
-- resources/index.html (whose "Download" buttons are currently
-- data-placeholder-action stubs — no real resource has ever been
-- downloadable through that page) with a real D1-backed CMS, mirroring
-- the Products Module's proven "D1 is the sole source of truth,
-- server-rendered public page" pattern (see docs/v2.1-architecture-plan.md
-- Section 3). Purely additive — one new table, no ALTER, no data
-- migration, no DROP.
-- ============================================================

CREATE TABLE resources (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id         TEXT NOT NULL UNIQUE,
  slug                TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  short_description   TEXT,
  description         TEXT, -- rich text, sanitizeRichTextHtml() at write time, same as products.description

  category            TEXT NOT NULL CHECK (category IN ('budgeting', 'saving', 'debt', 'investing', 'planning')),
  format               TEXT NOT NULL CHECK (format IN ('template', 'checklist', 'tracker', 'worksheet', 'guide')),

  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  tags                TEXT,

  file_media_id       INTEGER REFERENCES media_assets(id),
  cover_media_id      INTEGER REFERENCES media_assets(id),
  thumbnail_media_id  INTEGER REFERENCES media_assets(id),

  seo_title           TEXT,
  seo_description     TEXT,
  seo_canonical_url   TEXT,

  featured            INTEGER NOT NULL DEFAULT 0,
  download_count      INTEGER NOT NULL DEFAULT 0, -- incremented server-side on a real download hit, never client-trusted

  published_at        TEXT,
  created_by           INTEGER REFERENCES admin_users(id),
  updated_by           INTEGER REFERENCES admin_users(id),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at           TEXT
);

CREATE INDEX idx_resources_status ON resources(status);
CREATE INDEX idx_resources_category ON resources(category);
CREATE INDEX idx_resources_deleted_at ON resources(deleted_at);
CREATE INDEX idx_resources_created_at ON resources(created_at);
