-- ============================================================
-- 0040_analytics_conversions.sql — Version 5.0 (Customer
-- Acquisition Phase 1): Analytics Abstraction Layer server-side
-- conversion dispatch log.
--
-- One row per (provider, event) server-side dispatch attempt —
-- mirrors email_log's own shape exactly (services/emailService.ts):
-- status/attempt_count/last_error/provider_id, logged whether the
-- dispatch succeeded, failed, or was skipped (provider not
-- configured). This is the single source of truth for the admin
-- observability dashboard (Pixel health, CAPI status, failed events,
-- retry queue, recent Purchases/Leads/Downloads sent) and for the
-- scheduled retry sweep (worker/index.ts's scheduled(), reusing the
-- existing daily Cron Trigger rather than a new one).
--
-- provider: 'meta' today; additive for a future Google/TikTok/etc.
-- adapter (services/analytics/'s provider-abstraction), never a
-- schema change to add one.
--
-- event_id: the SAME id sent to the browser pixel for the
-- corresponding client-side fire (when one exists) — Meta's own
-- documented event-deduplication mechanism (same event_name +
-- event_id from both Pixel and CAPI within the dedup window collapses
-- to one). Not unique alone (a retry reuses the same event_id
-- deliberately, so a retried dispatch still dedupes against its own
-- earlier browser-side fire) — uniqueness against a genuine double
-- SEND is enforced by the service layer's own idempotency check
-- (one 'sent' row per event_id+provider is authoritative), not a
-- DB constraint, matching purchase_sessions' own "status-gated
-- conditional UPDATE" idempotency discipline rather than a UNIQUE
-- index that would reject a legitimate retry row.
--
-- entity_type/entity_id: the generic pattern already established by
-- audit_logs/email_log — ties this dispatch back to the purchase_session,
-- newsletter_subscriber, consultation_request, etc. that triggered it.
--
-- Rollback: `DROP TABLE analytics_conversion_log;` — safe, nothing
-- outside this phase's own code reads this table.
-- ============================================================

CREATE TABLE analytics_conversion_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT NOT NULL,                 -- 'meta' today; additive for future providers
  event_name      TEXT NOT NULL,                 -- 'Purchase', 'Lead', etc. — Meta's own vocabulary
  event_id        TEXT NOT NULL,                 -- shared with the browser pixel fire, for dedup
  entity_type     TEXT NOT NULL,                 -- 'purchase_session', 'newsletter_subscriber', 'consultation_request'
  entity_id       INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'permanently_failed', 'skipped')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  provider_trace_id TEXT,                        -- Meta's fbtrace_id, when present — the same "provider_id" concept email_log already records
  request_payload TEXT,                          -- the exact JSON sent, minus hashed PII fields — for admin troubleshooting only, never raw email/phone
  sent_at         TEXT,                          -- set only on status = 'sent', matching email_log's own convention
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_analytics_conversion_log_status ON analytics_conversion_log(status);
CREATE INDEX idx_analytics_conversion_log_created ON analytics_conversion_log(created_at);
CREATE INDEX idx_analytics_conversion_log_entity ON analytics_conversion_log(entity_type, entity_id);
CREATE INDEX idx_analytics_conversion_log_event ON analytics_conversion_log(event_name);
