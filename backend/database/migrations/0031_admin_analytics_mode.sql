-- ============================================================
-- 0031_admin_analytics_mode.sql — Version 4.9 Phase 6 (Analytics
-- Settings)
--
-- Persists each admin's own Analytics Mode preference (Production
-- Only / Production + Internal / All Records) directly on their
-- admin_users row, per the founder's explicit architecture decision:
-- "implement per-admin Analytics Mode instead of a global setting...
-- so every administrator can have their own default view without
-- affecting anyone else." This is purely a reporting/display
-- preference — it is read by the Executive Dashboard to choose which
-- data_classification values to include in KPI queries, and is never
-- written to or read by anything that mutates data_classification or
-- any underlying business record.
--
-- Defaults to 'production' for every existing and future admin, same
-- reasoning as migration 0028's classification default: an admin who
-- has never touched this setting sees the safe, customer-facing-only
-- view, never an accidentally-widened one.
--
-- Rollback: `ALTER TABLE admin_users DROP COLUMN analytics_mode;` —
-- safe at any time; the dashboard falls back to the 'production'
-- default (see executiveDashboardService.ts's parseAnalyticsMode())
-- if this column or value is ever missing.
-- ============================================================

ALTER TABLE admin_users ADD COLUMN analytics_mode TEXT NOT NULL DEFAULT 'production'
  CHECK (analytics_mode IN ('production', 'production_internal', 'all'));
