-- Robayer WealthLab — D1 Migration 0005 (Newsletter Compliance: Unsubscribe)
--
-- See backend/database/schema.sql for full column-by-column rationale
-- and docs/newsletter-unsubscribe-design.md for the architecture this
-- supports. Adds the one new table needed for a real, working
-- unsubscribe flow — every current email template has promised this
-- since launch, but nothing implemented it until now.
--
-- Mirrors download_tokens' proven shape/pattern exactly (single-use,
-- expiring, atomically-consumed token) — a new, but not novel, piece
-- of infrastructure.

CREATE TABLE unsubscribe_tokens (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token          TEXT NOT NULL UNIQUE,
  subscriber_id  INTEGER NOT NULL REFERENCES newsletter_subscribers(id),
  expires_at     TEXT NOT NULL,
  used_at        TEXT, -- set once redeemed; a used token is never valid again
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_unsubscribe_tokens_subscriber ON unsubscribe_tokens(subscriber_id);
