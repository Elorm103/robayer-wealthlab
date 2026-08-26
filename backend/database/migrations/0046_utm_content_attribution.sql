-- ============================================================
-- 0046_utm_content_attribution.sql — Reliable Sales Funnel
-- Measurement pass. Two additive, nullable columns closing the one
-- real gap in existing UTM capture: utm_content (e.g. "50_percent_offer")
-- was never captured anywhere, only utm_source/medium/campaign
-- (migrations 0025, 0044). Mirrors those two migrations' own column
-- shape and placement exactly — same pattern, same nullability, same
-- "not a fabricated default" discipline.
--
-- analytics_events.utm_content: captured client-side by
-- js/components/analytics.js's getUtm(), same session-persisted
-- mechanism already used for utm_source/medium/campaign.
--
-- purchase_sessions.utm_content: forwarded by js/components/buy-button.js
-- at checkout time from the same sessionStorage value, mirroring
-- migration 0044's utm_source/medium/campaign columns exactly. Does
-- NOT feed attribution_confidence (unchanged) — content is a
-- sub-dimension of an already-attributed campaign, not itself
-- evidence of attribution.
--
-- Rollback: `ALTER TABLE analytics_events DROP COLUMN utm_content;`
-- and the same for purchase_sessions — safe, additive-only, nothing
-- else in the schema depends on these columns.
-- ============================================================

ALTER TABLE analytics_events ADD COLUMN utm_content TEXT;
ALTER TABLE purchase_sessions ADD COLUMN utm_content TEXT;

-- newsletter_campaigns.utm_campaign: a campaign has never known its own
-- attribution tag, only whatever UTM string the admin happened to type
-- into the email body's link — meaning no query could join "campaign
-- id 3" to "utm_campaign=checked_not_copied_launch" without hardcoding
-- that one mapping. Nullable/optional, same as everything above; a
-- campaign created before this migration (or one whose admin never set
-- it) simply can't be funnel-measured by campaign, same honest
-- degradation the rest of this pass follows. Campaign #3 (CHECKED, NOT
-- COPIED launch, already sent) is backfilled with the value its own
-- email body's link already carries — a data correction reflecting
-- what's already true, not new campaign content; the campaign's
-- subject/body are untouched by this migration.
ALTER TABLE newsletter_campaigns ADD COLUMN utm_campaign TEXT;
UPDATE newsletter_campaigns SET utm_campaign = 'checked_not_copied_launch' WHERE id = 3;
