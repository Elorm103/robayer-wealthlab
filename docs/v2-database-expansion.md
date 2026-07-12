# Version 2.0 — Database Expansion Plan

**Grounding:** every existing table referenced below is verified real and live per `docs/v2-platform-audit.md`. This document proposes exactly one new migration file (`0006_admin_dashboard.sql`), following the same conventions as `0001`-`0005` (surrogate integer PK, TEXT ISO-8601 timestamps, `deleted_at` only where soft-delete genuinely applies, indexes on every foreign key and every column used in a `WHERE`/`ORDER BY` an admin screen will actually issue).

---

## Tables that already exist and will be reused unchanged (structurally)

| Table | Reused for |
|---|---|
| `admin_users` | Login, user management. Shape is already correct — see "Extending admin_users" below for the one genuinely new need. |
| `audit_logs` | Every admin mutation, written by the one new `auditService.ts`. |
| `purchase_sessions`, `payment_transactions`, `deliveries`, `download_tokens` | Orders module reads these — **read-only**, no schema change. |
| `newsletter_subscribers`, `unsubscribe_tokens` | Newsletter module reads/manages these — no schema change needed for subscriber list/search/export. |
| `consultation_requests`, `contact_messages` | Consultation/Contact managers — already have `status`, already have the right fields. No schema change for basic list/detail/status-update. |
| `email_log` | Order detail's "email history" tab, Newsletter campaign history — read-only. |

**Tables confirmed dead, not to be resurrected:** `products`, `customers`, `orders`, `downloads` (per the audit — content/products/*.json and purchase_sessions/deliveries already do their job).

---

## Extending `admin_users` (2 new columns, no breaking change)

The existing shape (`email`, `password_hash`, `role`, `is_active`, `last_login_at`, `deleted_at`) covers login and RBAC completely. Two genuinely new needs, added via `ALTER TABLE` (additive, safe):

```sql
ALTER TABLE admin_users ADD COLUMN name TEXT; -- display name for "assigned to" / audit log readability — the schema has no human-readable identifier today beyond email
ALTER TABLE admin_users ADD COLUMN totp_secret TEXT; -- nullable; populated only if/when 2FA is turned on for that user — see authentication-design.md's "2FA readiness"
```

No other change to this table. `role`'s existing CHECK constraint (`super_admin`, `editor`, `support`) already matches the roles named in this brief (Administrators/Editors/Support map directly; "Marketing" — see below).

**One open design question, resolved here rather than left implicit:** the brief names 4 roles (Administrators, Editors, Marketing, Support) but the existing schema only has 3. Recommend **not** widening the CHECK constraint to add a 4th role. Reasoning: "Marketing" as described in this brief (newsletter campaigns, subscriber management, blog) is a subset of what "editor" already covers content-wise, plus newsletter-specific permissions — better modeled as a **permission flag**, not a 4th mutually-exclusive role (see `docs/v2-authentication-design.md`'s permissions table for exactly which of the 3 roles can do what, with newsletter-send access granted to both `super_admin` and `editor` rather than inventing a role whose only difference is one capability).

---

## New tables (migration `0006_admin_dashboard.sql`)

### `admin_sessions`
```sql
CREATE TABLE admin_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT NOT NULL UNIQUE,        -- 256-bit, same generation pattern as download/unsubscribe tokens
  admin_id     INTEGER NOT NULL REFERENCES admin_users(id),
  csrf_secret  TEXT NOT NULL,               -- per-session, backs the double-submit CSRF pattern
  ip_created   TEXT,                        -- CF-Connecting-IP at login, audit/anomaly context only, never an access decision
  user_agent   TEXT,
  expires_at   TEXT NOT NULL,               -- short-lived (see authentication-design.md), refreshed on activity
  revoked_at   TEXT,                        -- set on logout or admin-initiated "log out everywhere"
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id);
CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);
```

### `blog_posts`
Content stays file-based for the *public* site's product/service/investment-centre pattern, but blog posts are the one content type genuinely better served by D1 — they need draft/scheduled/published states, author attribution, and frequent small edits, none of which a hand-edited JSON file handles gracefully at any real volume. This is a deliberate, explicit departure from the "content lives in JSON" convention, justified narrowly:

```sql
CREATE TABLE blog_posts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  excerpt           TEXT,
  body_html         TEXT NOT NULL,          -- sanitized server-side on every save, see security-review.md
  category          TEXT,                   -- matches content/topics/index.json's slugs, same convention as products
  tags              TEXT,                   -- JSON array as text, e.g. ["treasury-bills","beginner"]
  featured_image_key TEXT,                  -- R2 object key
  seo_title         TEXT,
  seo_description   TEXT,
  author_id         INTEGER REFERENCES admin_users(id),
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'published', 'archived')),
  published_at      TEXT,                   -- set when status becomes 'published'; also the scheduled-for time while status = 'scheduled'
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at        TEXT
);
CREATE INDEX idx_blog_posts_status ON blog_posts(status);
CREATE INDEX idx_blog_posts_published_at ON blog_posts(published_at);
```
**Migration note:** the one real existing article (`what-are-treasury-bills-in-ghana`) is a static HTML file, not a D1 row — it is *not* migrated into this table automatically (see `docs/v2-migration-strategy.md`); it continues to exist as-is, and new posts go through the CMS from this point forward. A one-time, manually-reviewed import is a reasonable future task, not an automatic side effect of shipping this table.

### `blog_post_versions` (lightweight versioning, not a full revision-history system)
```sql
CREATE TABLE blog_post_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id      INTEGER NOT NULL REFERENCES blog_posts(id),
  body_html    TEXT NOT NULL,
  edited_by    INTEGER REFERENCES admin_users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_blog_post_versions_post ON blog_post_versions(post_id);
```
One row written per save (not per keystroke) — "Versions" in the brief means "see what changed and revert," not live collaborative editing (out of scope, see risk assessment).

### `product_versions` (mirrors `blog_post_versions` for the Product Management "Versions" requirement)
```sql
CREATE TABLE product_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_slug  TEXT NOT NULL,              -- matches content/products/{slug}.json, not a D1 products.id (that table is dead)
  snapshot_json TEXT NOT NULL,              -- the full product JSON at save time
  edited_by     INTEGER REFERENCES admin_users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_product_versions_slug ON product_versions(product_slug);
```

### `resources` (replaces the current hand-coded 6-item list in `resources/index.html`)
```sql
CREATE TABLE resources (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  description    TEXT,
  category       TEXT,
  file_key       TEXT,                      -- R2 object key; NULL until a real file is uploaded (replaces today's dead href="#")
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  download_count INTEGER NOT NULL DEFAULT 0, -- incremented by the same download-serving path pattern as paid assets, giving Resources real usage data for the first time
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT
);
CREATE INDEX idx_resources_status ON resources(status);
```

### `media_assets` (the Media Library's own index over R2 — R2 has no native browse/search/folder UI)

**Built in Version 2.0 Phase 1** — the real, deployed schema
(`database/migrations/0007_media_library.sql`) ended up richer than
this original sketch, once actual upload requirements (duplicate
detection, dimensions, thumbnails, editorial metadata, lifecycle
status) were in scope. Kept here for history; the migration file is
the source of truth.

```sql
CREATE TABLE media_assets (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  filename               TEXT NOT NULL,           -- server-generated safe filename actually used
  original_filename      TEXT NOT NULL,           -- as uploaded, sanitized for display only — never used to build storage_key
  mime_type              TEXT NOT NULL,
  size_bytes             INTEGER NOT NULL,
  width                  INTEGER,                 -- images only; extracted server-side from real file bytes
  height                 INTEGER,                 -- images only
  content_hash           TEXT NOT NULL,           -- SHA-256 of the bytes — the real duplicate-detection key (added; not in the original sketch)
  storage_key            TEXT NOT NULL UNIQUE,    -- the real R2 object key, media/{images|documents}/{folder}/<uuid>.<ext>
  public_url             TEXT NOT NULL,           -- denormalized from storage_key at upload time
  thumbnail_storage_key  TEXT,                    -- images only; a genuinely separate R2 object (added; not in the original sketch)
  thumbnail_public_url   TEXT,
  media_type             TEXT NOT NULL CHECK (media_type IN ('image', 'document')),
  folder                 TEXT NOT NULL DEFAULT 'uncategorized' CHECK (folder IN ('books', 'blog', 'resources', 'branding', 'uncategorized')),
  alt_text               TEXT,                    -- accessibility — surfaced as required-before-public-use in the UI, not DB-enforced
  title                  TEXT,
  description            TEXT,
  tags                   TEXT,                    -- comma-separated; no separate tags table at this scale
  status                 TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'processing', 'failed')), -- always 'ready' today; reserved for a future async pipeline (e.g. virus scanning)
  uploaded_by            INTEGER REFERENCES admin_users(id),
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at             TEXT                     -- soft delete: R2 object is NOT hard-deleted when this is set
);
CREATE INDEX idx_media_assets_folder ON media_assets(folder);
CREATE INDEX idx_media_assets_media_type ON media_assets(media_type);
CREATE INDEX idx_media_assets_content_hash ON media_assets(content_hash);
CREATE INDEX idx_media_assets_deleted_at ON media_assets(deleted_at);
CREATE INDEX idx_media_assets_created_at ON media_assets(created_at);
```

Two changes from the original sketch worth calling out: `content_type`
was renamed `mime_type` (matching the rest of this codebase's naming),
and `folder` remains a logical tag as originally reasoned here — but
Phase 1 *also* uses it as a real R2 key prefix segment
(`media/images/{folder}/...`), not instead of the tag. Both are true
at once: the R2 structure requirement and the "no nested-tree UI"
reasoning below aren't actually in conflict, since the UI still just
filters on the flat `folder` column.

### `newsletter_campaigns` (the recurring-send capability the audit found entirely missing)
```sql
CREATE TABLE newsletter_campaigns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject       TEXT NOT NULL,
  body_html     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  scheduled_for TEXT,
  sent_at       TEXT,
  recipient_count INTEGER,                  -- snapshotted once sending begins, for an honest "sent to N people" record even if the list changes afterward
  created_by    INTEGER REFERENCES admin_users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_newsletter_campaigns_status ON newsletter_campaigns(status);
```
**Deliberately does not duplicate `email_log`** — a campaign send still writes one `email_log` row per recipient (`entity_type = 'newsletter_campaign'`, `entity_id` = this table's id), reusing the exact existing pattern rather than inventing a parallel logging table.

### `consultation_notes` and `contact_notes` (internal notes — genuinely new capability, not in any existing table)
```sql
CREATE TABLE consultation_notes (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_request_id INTEGER NOT NULL REFERENCES consultation_requests(id),
  author_id               INTEGER REFERENCES admin_users(id),
  note                    TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_consultation_notes_request ON consultation_notes(consultation_request_id);

CREATE TABLE contact_notes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_message_id INTEGER NOT NULL REFERENCES contact_messages(id),
  author_id          INTEGER REFERENCES admin_users(id),
  note               TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contact_notes_message ON contact_notes(contact_message_id);
```
Two small tables rather than one generic polymorphic "notes" table — mirrors this codebase's own existing preference for explicit, distinct tables over generic polymorphism where the two use cases are genuinely separate (the same reasoning already documented for why `consultation_requests` and `contact_messages` are two tables, not one).

### `consultation_assignments` (lightweight — a single nullable column, not a join table)
Rather than a new table, add one column: `ALTER TABLE consultation_requests ADD COLUMN assigned_to INTEGER REFERENCES admin_users(id);` — a consultation has at most one assignee at a time in this brief's description ("Assignments" singular per request), so a join table would be unjustified complexity. Same addition to `contact_messages`.

### `site_settings` (key-value, for the Settings module)
```sql
CREATE TABLE site_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,               -- JSON-encoded where the value is structured (e.g. social links)
  updated_by  INTEGER REFERENCES admin_users(id),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```
A single flexible table rather than one column per setting — settings grow over time and a key-value shape avoids a migration for every new field. **Important scope note, carried from the audit:** `assets/config/site.json` already holds business info/social links/branding and is already the real, live, working source of truth for the public site (read client-side via `content-inject.js`). This table does not replace that file — seeit as the admin's *editing* interface, which then writes the updated values back into `assets/config/site.json` (a real file write via a to-be-designed publish step, not a live database read on every public page load) — full reasoning in `docs/v2-migration-strategy.md`, since this is one of the trickier "how do these two systems stay in sync" questions in the whole plan.

---

## Relationship diagram (new tables only, existing tables in parentheses)

```
(admin_users) ─┬─< admin_sessions
               ├─< blog_posts.author_id
               ├─< blog_post_versions.edited_by
               ├─< product_versions.edited_by
               ├─< media_assets.uploaded_by
               ├─< newsletter_campaigns.created_by
               ├─< consultation_notes.author_id
               ├─< contact_notes.author_id
               ├─< site_settings.updated_by
               └─< (consultation_requests).assigned_to, (contact_messages).assigned_to

blog_posts ──< blog_post_versions
(consultation_requests) ──< consultation_notes
(contact_messages) ──< contact_notes
(newsletter_subscribers) ── [existing: unsubscribe_tokens] ── newsletter_campaigns (via email_log, not a direct FK)
```

---

## Migration safety

One new file, `0006_admin_dashboard.sql`, containing: 2 `ALTER TABLE` statements (additive, nullable columns — cannot fail against existing data), 2 more `ALTER TABLE` for `assigned_to` columns, and 8 `CREATE TABLE` statements (net-new, cannot conflict with anything). No `DROP`, no data migration, no table recreate. This is the safest possible shape of migration — every prior migration in this project's history that needed a table recreate (`0003`, `0004`) did so because SQLite can't `ALTER` a column type or foreign-key target in place; nothing here requires that, so `0006` should be the simplest migration this project has shipped.

Full sequencing and rollback plan: `docs/v2-migration-strategy.md`.
