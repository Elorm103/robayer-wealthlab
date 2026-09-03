-- ============================================================
-- 0056_affiliate_resources.sql: Affiliate Programme, Stage G
-- (Marketing/Resource Centre).
--
-- Admin-curated promotional copy/assets approved affiliates can use to
-- promote Robayer WealthLab: captions, scripts, short selling points,
-- approved claims. Deliberately CMS-simple, mirroring the `resources`/
-- `blog_posts` modules' own established "D1-direct, admin-authored,
-- no join-table generality" shape rather than something more elaborate;
-- this is a small, admin-maintained library, not a second Media
-- Library. Images/cover assets are NOT duplicated here: media_id
-- references the existing media_assets table directly, reusing
-- whatever folder ('branding'/'uncategorized'/etc.) the admin already
-- uploaded the asset under, deliberately NOT adding a new 'affiliate'
-- value to media_assets.folder's CHECK constraint, since SQLite can't
-- alter a CHECK constraint without a full table rebuild, and that
-- table is shared by every other content module in this schema; not
-- worth that risk for a purely cosmetic categorization value.
--
-- Rollback: DROP TABLE affiliate_resources;
-- ============================================================

CREATE TABLE affiliate_resources (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  category       TEXT NOT NULL CHECK (category IN ('social_caption', 'script', 'message_template', 'product_copy', 'image', 'guidance')),
  body           TEXT,                 -- the actual copy/caption/script text; NULL for an image-only resource
  media_id       INTEGER REFERENCES media_assets(id),
  product_slug   TEXT,                 -- NULL = general/brand resource, not tied to one product
  sort_order     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  created_by     INTEGER REFERENCES admin_users(id),
  updated_by     INTEGER REFERENCES admin_users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'))
);

CREATE INDEX idx_affiliate_resources_status ON affiliate_resources(status);
CREATE INDEX idx_affiliate_resources_category ON affiliate_resources(category);
