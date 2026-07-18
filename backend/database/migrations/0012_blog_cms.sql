-- ============================================================
-- 0012_blog_cms.sql — Version 2.1 Phase 2 (Blog CMS)
--
-- Mirrors the Resources Module's proven "D1 is the sole source of
-- truth, server-rendered public page" pattern (migration 0011). Real
-- category vocabulary confirmed against the live static pages
-- (blog/index.html's filter pills, blog/what-are-treasury-bills-in-ghana/'s
-- own category) before choosing the CHECK constraint below — 'saving',
-- 'investing', 'budgeting' are the only three ever actually used.
--
-- Two states only (draft/published), not the 5-state
-- draft/in_review/scheduled/published/archived lifecycle an earlier
-- planning pass considered — the real Phase 2 brief asked for exactly
-- "Draft and Published states," nothing more; soft delete
-- (deleted_at, below) already covers "remove from public view without
-- deleting" the same way draft does, so a third 'archived' status
-- would be redundant, not a missing feature.
-- ============================================================

CREATE TABLE blog_posts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id             TEXT NOT NULL UNIQUE,
  slug                TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  excerpt             TEXT,
  body                TEXT, -- rich text, sanitizeRichTextHtml() at write time, same as products.description / resources.description

  category            TEXT NOT NULL CHECK (category IN ('saving', 'investing', 'budgeting')),
  tags                TEXT,

  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  featured            INTEGER NOT NULL DEFAULT 0,

  cover_media_id      INTEGER REFERENCES media_assets(id),
  author_id           INTEGER REFERENCES admin_users(id), -- real attribution, resolved to admin_users.name at read time — not a free-text field

  seo_title           TEXT,
  seo_description     TEXT,
  seo_canonical_url   TEXT,

  published_at        TEXT,
  created_by           INTEGER REFERENCES admin_users(id),
  updated_by           INTEGER REFERENCES admin_users(id),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at           TEXT
);

CREATE INDEX idx_blog_posts_status ON blog_posts(status);
CREATE INDEX idx_blog_posts_category ON blog_posts(category);
CREATE INDEX idx_blog_posts_deleted_at ON blog_posts(deleted_at);
CREATE INDEX idx_blog_posts_created_at ON blog_posts(created_at);
