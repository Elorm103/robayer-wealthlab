-- ============================================================
-- 0028_data_classification.sql — Version 4.9 (Production Launch
-- Readiness & Data Sanitization)
--
-- Adds a `data_classification` column to every customer-facing/
-- business-relevant table, so Executive Dashboard and KPI queries can
-- distinguish genuine business activity from internal team activity
-- and confirmed development/test data, without ever moving, deleting,
-- or restructuring a single row.
--
-- Deliberately a plain TEXT + CHECK column, not a separate lookup
-- table or a boolean flag — one of exactly four values, always
-- present, never NULL:
--   PRODUCTION   - genuine customer/business record
--   INTERNAL     - real, founder/staff/QA activity; really happened,
--                  must not influence customer-facing KPIs
--   DEVELOPMENT  - confirmed test/seed/fabricated data
--   UNKNOWN      - cannot be classified with confidence yet (the
--                  DEFAULT for every existing and future row - this
--                  migration never auto-assigns PRODUCTION to
--                  anything; that only happens via the explicit,
--                  evidence-based UPDATE statements that follow this
--                  migration in the same release, or by a human
--                  reviewing an UNKNOWN row later)
--
-- Deliberately excluded from this migration (per the Version 4.9
-- classification review's own recommendation): audit_logs,
-- login_history, analytics_events, email_log, admin_sessions,
-- customer_sessions, customer_password_tokens, password_reset_tokens,
-- unsubscribe_tokens, receipt_download_tokens, download_tokens,
-- purchase_followup_attempts, review_reminder_attempts. These are
-- operational/security history, not customer-facing business records
-- - classifying them the same way would conflate two different
-- concerns and risks accidentally hiding real security/delivery
-- history behind a KPI filter it was never meant to gate.
--
-- Rollback: `ALTER TABLE <table> DROP COLUMN data_classification;`
-- for each table below - safe at any time, since no other table or
-- code path requires this column to exist (every dashboard query
-- that reads it is expected to treat a missing column as "show
-- everything," matching this system's existing additive-migration
-- fallback convention).
-- ============================================================

ALTER TABLE customers ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE customer_profiles ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE purchase_sessions ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE payment_transactions ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE order_items ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE licenses ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE receipts ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE deliveries ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE coupons ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE coupon_redemptions ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE admin_users ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE contact_messages ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE consultation_requests ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE consultation_notes ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE product_reviews ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE newsletter_subscribers ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE newsletter_campaigns ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE newsletter_campaign_recipients ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE media_assets ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE blog_posts ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE products ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));
ALTER TABLE resources ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'));

-- Indexes on the two highest-traffic dashboard-query tables, where
-- "WHERE data_classification = 'PRODUCTION'" will run on every
-- Executive Dashboard load.
CREATE INDEX idx_purchase_sessions_classification ON purchase_sessions(data_classification);
CREATE INDEX idx_customers_classification ON customers(data_classification);
