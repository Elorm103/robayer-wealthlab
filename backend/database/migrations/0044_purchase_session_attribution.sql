-- ============================================================
-- 0044_purchase_session_attribution.sql — P0-C (Attribution
-- Continuity, Business Intelligence backbone).
--
-- Adds 4 nullable columns to purchase_sessions, captured at the same
-- point and by the same discipline as migration 0041's fbc/fbp/
-- client_ip_address/client_user_agent columns: read from the one real
-- customer request in the whole purchase flow (routes/checkout.ts,
-- at checkout-session creation), never guessed or backfilled.
--
-- utm_source / utm_medium / utm_campaign: forwarded from the
-- sessionStorage values js/components/analytics.js already captures
-- from the landing page's URL — this migration does not introduce a
-- new capture mechanism, only a new destination for an existing one.
-- Campaign-level only, matching this project's honest ceiling for
-- attribution: no ad-set/ad-level/click-level fields exist or are
-- planned here.
--
-- attribution_confidence: a small, conservative label
-- ('utm' | 'meta_click' | 'direct' | 'unknown'), computed server-side
-- in commerceService.ts from whatever combination of UTM/fbc is
-- actually present at checkout — never trusted from client input, and
-- never used to claim more attribution precision than the underlying
-- evidence supports.
--
-- All 4 are optional — NULL means "not available," never a fabricated
-- default. Existing purchase_sessions rows receive NULL for all four,
-- same backward-compatible pattern as 0041/0042/0043.
--
-- Rollback: `ALTER TABLE purchase_sessions DROP COLUMN utm_source;`
-- (and the other 3) — safe, additive-only, nothing else in the schema
-- depends on these columns.
-- ============================================================

ALTER TABLE purchase_sessions ADD COLUMN utm_source TEXT;
ALTER TABLE purchase_sessions ADD COLUMN utm_medium TEXT;
ALTER TABLE purchase_sessions ADD COLUMN utm_campaign TEXT;
ALTER TABLE purchase_sessions ADD COLUMN attribution_confidence TEXT;
