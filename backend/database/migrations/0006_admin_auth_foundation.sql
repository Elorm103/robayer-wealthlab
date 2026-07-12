-- Robayer WealthLab — D1 Migration 0006 (Version 2.0 Phase 0.1: Authentication Foundation)
--
-- See docs/v2-authentication-design.md and docs/v2-database-expansion.md
-- for the full design this implements. Scoped deliberately narrow: this
-- migration adds only what admin login/session/audit needs. The other
-- new tables named in v2-database-expansion.md (blog_posts, resources,
-- media_assets, newsletter_campaigns, consultation_notes, contact_notes,
-- product_versions, blog_post_versions, site_settings, and the
-- consultation_requests/contact_messages `assigned_to` columns) belong
-- to later phases (0.2+) that build the modules which actually use
-- them — adding their schema now, unused, would contradict this
-- phase's own "do not implement any dashboard modules" scope.
--
-- Two changes, both additive (no DROP, no recreate, cannot conflict
-- with or lose any existing data):
--   1. `admin_users` gains two nullable columns.
--   2. New `admin_sessions` table.
--
-- `admin_users` and `audit_logs` themselves are untouched — both
-- already exist, live, with exactly the shape this phase needs.

ALTER TABLE admin_users ADD COLUMN name TEXT; -- display name for audit-log readability; nullable, no default needed
ALTER TABLE admin_users ADD COLUMN totp_secret TEXT; -- nullable; populated only if/when 2FA is turned on for that user (not built this phase — see docs/v2-authentication-design.md's "2FA readiness")

-- ============================================================
-- ADMIN_SESSIONS
-- One row per active login. Mirrors download_tokens'/unsubscribe_tokens'
-- proven shape (random unique token, expires_at, a nullable "consumed"
-- marker) with the two additions a browser session actually needs:
-- csrf_secret (backs the double-submit CSRF pattern) and last_seen_at
-- (backs the sliding-expiry window) — see docs/v2-authentication-design.md.
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
