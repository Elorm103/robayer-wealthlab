-- ============================================================
-- 0016_newsletter_campaigns.sql — Version 2.1 Phase 6 (Newsletter
-- Campaigns)
--
-- Two new tables only — see docs/v2.1-phase6-design.md for the full
-- rationale. `newsletter_campaigns` is the campaign itself (content +
-- lifecycle state); `newsletter_campaign_recipients` is a durable,
-- per-recipient roster snapshotted once at the Draft→Sending
-- transition and never re-derived, which is what makes duplicate-send
-- prevention and mid-send recovery possible without any queue/cron
-- infrastructure (none exists in this project — see the design doc's
-- architecture review).
--
-- `test_sent_at` exists to enforce the approved "require a test email
-- before Send becomes available" safeguard server-side, not just in
-- the UI — cleared whenever subject/body is edited after a test, so a
-- stale test can never authorize sending since-changed content.
-- ============================================================

CREATE TABLE newsletter_campaigns (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  subject                   TEXT NOT NULL,
  body                      TEXT NOT NULL, -- rich text, sanitizeRichTextHtml() at write time, same as blog_posts.body / products.description
  status                    TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'failed')),

  intended_recipient_count  INTEGER, -- snapshotted at Draft→Sending; NULL while still Draft
  test_sent_at              TEXT, -- set on a successful test send; cleared on any subject/body edit — Send is blocked server-side while NULL

  created_by                INTEGER NOT NULL REFERENCES admin_users(id),
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),

  sent_by                   INTEGER REFERENCES admin_users(id), -- the admin who triggered the send, not necessarily who drafted it
  sending_started_at        TEXT,
  sent_at                   TEXT, -- set once every recipient row reaches a terminal state

  deleted_at                TEXT -- soft delete, matching every other CMS module's convention; a Sent campaign's history is never hard-deleted
);

CREATE INDEX idx_newsletter_campaigns_status ON newsletter_campaigns(status);

-- One row per (campaign, subscriber-at-send-time). The recipient
-- roster is frozen the moment a campaign leaves Draft (per the user's
-- explicit "treat the roster as immutable once sending begins"
-- recommendation) — a subscriber who joins after a campaign has
-- started sending is never added to it, and one who unsubscribes
-- mid-send is still attempted (best-effort, matching the recipient
-- count shown before confirmation).
CREATE TABLE newsletter_campaign_recipients (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id    INTEGER NOT NULL REFERENCES newsletter_campaigns(id),
  subscriber_id  INTEGER NOT NULL REFERENCES newsletter_subscribers(id),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  email_log_id   INTEGER REFERENCES email_log(id), -- set once a real send attempt is recorded; the audit-grade detail (provider id, error, attempt count) lives there, not duplicated here
  attempted_at   TEXT,

  UNIQUE(campaign_id, subscriber_id) -- database-enforced duplicate-send guarantee, not merely an application-level check
);

CREATE INDEX idx_campaign_recipients_campaign_status ON newsletter_campaign_recipients(campaign_id, status);
