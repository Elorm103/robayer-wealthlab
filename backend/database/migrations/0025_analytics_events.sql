-- ============================================================
-- 0025_analytics_events.sql — Version 4.0 Milestone A (Measurement
-- Foundation)
--
-- A new, first-party, anonymous event log — the one piece of new
-- schema this milestone genuinely needs, since no existing table can
-- honestly answer "where are visitors dropping off," "which buttons
-- are clicked," or "which traffic source produced this page view."
-- Deliberately does NOT touch purchase_sessions, customers, or any
-- other proven table — this is purely additive, write-only from the
-- public site's own pages, read-only from the admin dashboard.
--
-- Privacy posture: session_id is a random, ephemeral identifier
-- generated client-side and stored in sessionStorage (discarded when
-- the browser tab closes) — never a persistent cookie, never linked
-- to a customer identity or email. No IP address, user agent, or
-- other fingerprinting field is captured. This intentionally limits
-- what can be measured (no cross-session or cross-device attribution)
-- in exchange for not needing a cookie-consent banner this site has
-- never had and does not otherwise need.
--
-- event_type is deliberately a closed, small set - "do not invent
-- metrics" applies to the schema itself, not just the dashboard that
-- reads it. page_view answers "where are visitors dropping off" /
-- "which pages convert" / "which products attract attention" /
-- "which traffic sources convert" (via referrer/utm_*). cta_click
-- answers "which buttons are clicked" and, combined with the
-- already-existing newsletter_subscribers.source column (unchanged,
-- already real), "which lead magnets perform best."
--
-- Rollback: `DROP TABLE analytics_events;` — safe at any time; no
-- other table references this one, and no other table's behavior
-- depends on rows existing here.
-- ============================================================

CREATE TABLE analytics_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL CHECK (event_type IN ('page_view', 'cta_click')),
  page_path    TEXT NOT NULL,
  cta_id       TEXT,
  referrer     TEXT,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  session_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_analytics_events_type_created ON analytics_events(event_type, created_at);
CREATE INDEX idx_analytics_events_page_path ON analytics_events(page_path);
CREATE INDEX idx_analytics_events_cta_id ON analytics_events(cta_id);
