-- ============================================================
-- 0013_identity_security.sql — Version 2.1 Phase 3 (Identity & Security)
--
-- Scoped to exactly the user's own Phase 3 requirement list:
-- Authentication (change/forgot/reset password, password strength),
-- Sessions (view/revoke, last login, login history), Security
-- (account lockout, failed-login tracking, session timeout, password
-- policy, forced logout after reset). Profile/avatar/notification
-- preferences from the original architecture-plan draft were never in
-- the user's own list and are not built here — see
-- docs/v2.1-phase3-implementation.md's "Scope delivered."
-- ============================================================

ALTER TABLE admin_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN locked_until TEXT;
ALTER TABLE admin_users ADD COLUMN password_updated_at TEXT;

-- Single-use, short-lived (30 min — tighter than a 12h session, since
-- this is a bearer-style credential to an account, not a file
-- download) — same generation pattern as download_tokens/
-- unsubscribe_tokens/admin_sessions.
CREATE TABLE password_reset_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT NOT NULL UNIQUE,
  admin_id     INTEGER NOT NULL REFERENCES admin_users(id),
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_password_reset_tokens_admin ON password_reset_tokens(admin_id);

-- Written alongside (not instead of) audit_logs' existing
-- admin.login/admin.login_failed events — a dedicated table because a
-- "Login History" UI reading the shared, general-purpose audit_logs
-- stream would need to filter out every unrelated admin action on
-- every page load. Same reasoning as consultation_notes/contact_notes
-- being dedicated tables instead of a polymorphic one.
CREATE TABLE login_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id     INTEGER NOT NULL REFERENCES admin_users(id),
  outcome      TEXT NOT NULL CHECK (outcome IN ('success', 'failed_password', 'failed_locked', 'failed_inactive')),
  ip_address   TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_login_history_admin ON login_history(admin_id);
