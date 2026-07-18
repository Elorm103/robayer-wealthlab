-- ============================================================
-- 0015_site_settings.sql — Version 2.1 Phase 5 (Settings)
--
-- One generic key-value table for runtime operational configuration
-- that should change without a code deploy — see
-- docs/v2.1-phase5-design.md. A future setting is a new row with a
-- service-layer default, not a new migration.
--
-- `settings_schema_version` is seeded here and compared at read time
-- against the service layer's own `EXPECTED_SETTINGS_SCHEMA_VERSION`
-- constant — a lightweight way to identify which settings structure a
-- given deployment expects, per the user's explicit request. Not a
-- migration framework: bump both together by hand if a future phase
-- ever needs a genuinely breaking change to this table's key shapes.
-- ============================================================

CREATE TABLE site_settings (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,                  -- JSON-encoded; typed per-key at the service layer, not the DB layer
  updated_by   INTEGER REFERENCES admin_users(id),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO site_settings (key, value) VALUES ('settings_schema_version', '1');

-- ============================================================
-- Widen email_log.status to allow 'skipped' — a genuine, honest state
-- distinct from 'sent'/'failed' for a send this phase's per-template
-- kill switch intentionally never attempted, per
-- docs/v2.1-phase5-design.md's emailService.ts touch-point. SQLite has
-- no ALTER TABLE ... ALTER COLUMN for a CHECK constraint, so this is
-- the standard recreate-copy-swap pattern — real production data is
-- preserved via the INSERT INTO ... SELECT below.
-- ============================================================
CREATE TABLE email_log_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  template       TEXT NOT NULL,
  recipient      TEXT NOT NULL,
  entity_type    TEXT,
  entity_id      INTEGER,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'permanently_failed', 'skipped')),
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  provider_id    TEXT,
  sent_at        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO email_log_new (id, template, recipient, entity_type, entity_id, status, attempt_count, last_error, provider_id, sent_at, created_at, updated_at)
  SELECT id, template, recipient, entity_type, entity_id, status, attempt_count, last_error, provider_id, sent_at, created_at, updated_at FROM email_log;

DROP TABLE email_log;
ALTER TABLE email_log_new RENAME TO email_log;

CREATE INDEX idx_email_log_status ON email_log(status);
CREATE INDEX idx_email_log_entity ON email_log(entity_type, entity_id);
