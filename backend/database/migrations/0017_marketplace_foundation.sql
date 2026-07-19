-- ============================================================
-- 0017_marketplace_foundation.sql — Version 3.0 "Founder Edition"
-- (Feature 7: Marketplace Foundation)
--
-- Scope deliberately narrowed from the original Version 3 planning set
-- (docs/v3-database-design.md's full identity-model rewrite) after a
-- risk review: renaming admin_users -> platform_users and building a
-- user_roles table touches 23 files including the live admin
-- login/session code, for zero near-term functional benefit while the
-- founder remains the platform's only creator. That rename is deferred
-- to Version 3.1, scoped against the real requirements of onboarding
-- actual external creator accounts, rather than done speculatively now.
--
-- What Founder Edition actually needs today: every product attributable
-- to a creator, and a place for a future approval workflow to attach to,
-- without inventing a second identity system for a platform with exactly
-- one person in it. `creator_id` references the existing admin_users
-- table unchanged — the founder's own admin account IS creator #1.
-- `approval_status` defaults to 'approved' for all products created
-- through the admin (today's only path), so this migration changes no
-- visible behavior — it exists so Version 3.1's creator-submission flow
-- has a real, already-proven column to set to 'pending_review' instead
-- of introducing a schema change at the same time real creators first
-- touch the system.
-- ============================================================

ALTER TABLE products ADD COLUMN creator_id INTEGER REFERENCES admin_users(id);

ALTER TABLE products ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'
  CHECK (approval_status IN ('pending_review', 'approved', 'rejected'));

ALTER TABLE products ADD COLUMN rejection_reason TEXT;

-- Backfill: every existing product is attributed to the founder's own
-- admin account. Not hardcoded to a specific id — resolves whichever
-- admin_users row is oldest (the founder's original account in every
-- real environment this migration will ever run against), so this
-- migration is correct in local, staging, and production alike without
-- needing a known id baked in.
UPDATE products
SET creator_id = (SELECT id FROM admin_users ORDER BY id ASC LIMIT 1)
WHERE creator_id IS NULL;

CREATE INDEX idx_products_creator_id ON products(creator_id);
CREATE INDEX idx_products_approval_status ON products(approval_status);
