-- ============================================================
-- 0045_analytics_visitor_tracking.sql — Analytics & User-Activity
-- Baseline (registered users, unique visitors, online now, per-book
-- funnel, device/country). Extends analytics_events (migration 0025)
-- rather than duplicating it — see backend/services/admin/
-- analyticsService.ts and backend/routes/analytics.ts for the code
-- this schema backs.
--
-- Every new column is additive/nullable. The one non-additive change
-- is widening event_type's CHECK constraint to allow 'product_view'
-- in addition to the existing 'page_view'/'cta_click' — SQLite has no
-- ALTER TABLE for a CHECK constraint, so this requires the standard
-- create-new/copy/drop-old/rename recreate. No prior migration in
-- this codebase has needed to do this before (checked all 44 prior
-- migrations), so there is no established local precedent to mirror;
-- this follows SQLite's own documented recreate pattern.
--
-- Privacy posture, unchanged and extended consistently: session_id
-- remains client-generated, sessionStorage-only, never a cookie.
-- country is a 2-letter code computed by Cloudflare's edge
-- (`request.cf.country`) — not an IP address, and a different
-- Cloudflare feature than the still-unused "Web Analytics" product.
-- device_type is a coarse bucket computed server-side from the
-- User-Agent header — the raw header is never stored. customer_id is
-- populated only when a request already carries a valid, existing
-- customer_session cookie — no new identity is ever created for
-- analytics purposes, and anonymous traffic leaves this NULL exactly
-- as before.
--
-- Analytics tracking start date for all first-party visitor/session/
-- traffic figures is 2026-08-25 (see
-- backend/utils/analyticsConfig.ts's ANALYTICS_TRACKING_START_DATE) —
-- rows before that date simply don't exist; no historical backfill is
-- attempted or implied by this migration.
--
-- Rollback: restore analytics_events to its 0025 shape by reversing
-- this same recreate (new table with the original 3-value CHECK and
-- without the 5 new columns, copy, drop, rename) — safe, since every
-- new column is nullable and no other table references this one.
-- ============================================================

CREATE TABLE analytics_events_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT NOT NULL CHECK (event_type IN ('page_view', 'cta_click', 'product_view')),
  page_path    TEXT NOT NULL,
  cta_id       TEXT,
  referrer     TEXT,
  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  session_id   TEXT NOT NULL,
  product_slug TEXT,
  country      TEXT,
  device_type  TEXT CHECK (device_type IN ('mobile', 'tablet', 'desktop', 'bot', 'unknown')),
  customer_id  INTEGER REFERENCES customers(id),
  purged_at    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO analytics_events_new (id, event_type, page_path, cta_id, referrer, utm_source, utm_medium, utm_campaign, session_id, created_at)
  SELECT id, event_type, page_path, cta_id, referrer, utm_source, utm_medium, utm_campaign, session_id, created_at
  FROM analytics_events;

DROP TABLE analytics_events;
ALTER TABLE analytics_events_new RENAME TO analytics_events;

CREATE INDEX idx_analytics_events_type_created ON analytics_events(event_type, created_at);
CREATE INDEX idx_analytics_events_page_path ON analytics_events(page_path);
CREATE INDEX idx_analytics_events_cta_id ON analytics_events(cta_id);
CREATE INDEX idx_analytics_events_product_slug ON analytics_events(product_slug);
CREATE INDEX idx_analytics_events_customer_id ON analytics_events(customer_id);
