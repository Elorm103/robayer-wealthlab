-- ============================================================
-- 0014_user_management.sql — Version 2.1 Phase 4 (User Management)
--
-- Purely additive: one nullable column on admin_users, one new table.
-- No change to admin_sessions/password_reset_tokens/login_history/
-- audit_logs — all reused unchanged. See docs/v2.1-phase4-design.md.
-- ============================================================

ALTER TABLE admin_users ADD COLUMN created_by INTEGER REFERENCES admin_users(id);

-- Every new admin sets their own first password via this single-use,
-- emailed link — never a system-generated temporary password (see
-- docs/v2.1-phase4-design.md's "Create and Invite collapse into one
-- mechanism"). Same proven shape as password_reset_tokens, with a
-- longer TTL (7 days, not 30 minutes) — a genuinely different threat
-- model: an invitation isn't a bearer credential to an already-real
-- account.
CREATE TABLE admin_invites (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL,
  name         TEXT,
  role         TEXT NOT NULL CHECK (role IN ('super_admin', 'editor', 'support')),
  invited_by   INTEGER NOT NULL REFERENCES admin_users(id),
  expires_at   TEXT NOT NULL,
  accepted_at  TEXT,
  admin_id     INTEGER REFERENCES admin_users(id),
  revoked_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_admin_invites_email ON admin_invites(email);
CREATE INDEX idx_admin_invites_token ON admin_invites(token);
