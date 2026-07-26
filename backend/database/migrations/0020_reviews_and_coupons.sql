-- ============================================================
-- 0020_reviews_and_coupons.sql — Version 3.2 Milestone M4
-- (Commerce & Trust Foundations: Product Reviews + Coupon Engine)
--
-- Implements the scope ratified in docs/v3.2-m4-scope-recommendation.md
-- and docs/v3.2-roadmap.md, corrected per the M4B Independent
-- Architecture & Scope Approval Review's Required Amendment 1
-- (docs/v3.2-m4b-architecture-readiness-assessment.md).
--
-- AMENDMENT 1 RESOLUTION — coupon schema correction:
-- The coupon schema originally referenced by M4A planning
-- (docs/v3-database-design.md) was written for the V3.1/V3.2
-- multi-creator marketplace vision: `coupons.creator_id` and
-- `coupons.created_by` both referenced `platform_users(id)`, a table
-- that does not exist in this schema and is gated behind ADR-011's
-- still-unplanned `platform_users` rename (Milestone M7 entry
-- condition). That schema also modeled a `scope IN ('platform',
-- 'creator')` distinction meaningless for the current single-seller
-- catalog.
--
-- The `coupons` table below is a deliberately simplified,
-- platform-scope-only design: no `scope` column, no `creator_id`,
-- `created_by` references the current `admin_users` table (the real,
-- live admin-identity table today). It preserves every other field
-- from the original design (code, discount_type/value, redemption
-- limits, expiry, status) exactly, since those parts of the original
-- design were sound and did not depend on the unresolved
-- platform_users question. If/when Milestone M7 activates the
-- marketplace schema and platform_users exists for real, a later
-- migration can extend this table with `creator_id`/`scope` columns —
-- the same "extend later, don't build it now" discipline this
-- project's history already applied to `products.creator_id` in
-- migration 0017.
--
-- All changes are additive: three new tables, two new columns on the
-- existing purchase_sessions table (both nullable/defaulted, no
-- existing row's meaning changes). Zero DROP, zero column removal.
--
-- See docs/v3.2-m4c-rollback-strategy.md (written at M4E closeout,
-- matching migration 0019's own precedent of pointing here rather than
-- inlining the full plan) for how to reverse this migration if ever
-- needed.
-- ============================================================

-- ============================================================
-- PRODUCT_REVIEWS
-- Customer reviews + star ratings, purchase-gated by construction
-- (purchase_session_id is NOT NULL and must belong to the reviewing
-- customer — enforced at the application layer in reviewService.ts,
-- the same ownership-check pattern services/customer/purchaseHistoryService.ts
-- already established). Structurally similar to, though not identical
-- to, the existing consultation_requests/contact_messages precedent
-- (an id/status/moderation shape this codebase already has two
-- working examples of) — extended here with product/rating fields
-- neither precedent needed.
--
-- One review per (customer, product) — a customer who repurchases the
-- same product edits their existing review rather than creating a
-- second one (see reviewService.ts). This is enforced by the UNIQUE
-- constraint below, not merely convention.
-- ============================================================
CREATE TABLE product_reviews (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id          INTEGER NOT NULL REFERENCES products(id),
  customer_id         INTEGER NOT NULL REFERENCES customers(id),
  purchase_session_id INTEGER NOT NULL REFERENCES purchase_sessions(id), -- the verified purchase this review is gated on; never a review with no corresponding purchase
  rating              INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  moderated_by        INTEGER REFERENCES admin_users(id),
  moderated_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(product_id, customer_id) -- one review per customer per product; a repurchase edits the existing row, never creates a second
);

CREATE INDEX idx_product_reviews_product ON product_reviews(product_id);
CREATE INDEX idx_product_reviews_customer ON product_reviews(customer_id);
CREATE INDEX idx_product_reviews_status ON product_reviews(status);

-- ============================================================
-- COUPONS
-- Platform-wide only (see Amendment 1 resolution note above — no
-- creator/marketplace scope in this schema). A coupon may optionally
-- be restricted to one product (product_id NOT NULL) or apply
-- platform-wide (product_id NULL).
--
-- redemptions_count is incremented transactionally alongside the
-- coupon_redemptions insert (same pattern receipt_number/
-- purchase_reference generation already uses for their own
-- collision-free counters), gated by a conditional UPDATE
-- (`WHERE redemptions_count < max_redemptions`) at the moment a
-- payment is actually verified — never at checkout-session creation,
-- where a customer could abandon the checkout and never pay. See
-- docs/v3.2-m4c-coupon-security-review.md's "Redemption-limit race"
-- section for the full reasoning and the accepted edge case this
-- design deliberately does not attempt to close (a payment that
-- already succeeded is never reversed to enforce a limit).
-- ============================================================
CREATE TABLE coupons (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  code                TEXT NOT NULL UNIQUE,
  product_id          INTEGER REFERENCES products(id), -- NULL = applies to every product
  discount_type       TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value      INTEGER NOT NULL CHECK (discount_value > 0), -- percentage points (1-100) or pesewas, per discount_type — validated further at the application layer (a percentage > 100 is rejected there, since SQLite CHECK cannot reference discount_type conditionally)
  max_redemptions     INTEGER, -- NULL = unlimited
  redemptions_count   INTEGER NOT NULL DEFAULT 0,
  first_purchase_only INTEGER NOT NULL DEFAULT 0, -- best-effort only — see the security review's "first_purchase_only enforcement" section for why this cannot be strictly enforced pre-payment in a guest-checkout system
  starts_at           TEXT,
  expires_at          TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'expired')),
  created_by          INTEGER NOT NULL REFERENCES admin_users(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_coupons_code ON coupons(code);
CREATE INDEX idx_coupons_product ON coupons(product_id);
CREATE INDEX idx_coupons_status ON coupons(status);

-- ============================================================
-- COUPON_REDEMPTIONS
-- One row per successful redemption, written only at payment
-- verification (never at checkout-session creation). UNIQUE on
-- purchase_session_id: one coupon per purchase — coupon stacking is
-- an explicit non-goal, matching the "no separate design work"
-- portions of the original v3-database-design.md that this migration
-- otherwise preserves.
-- ============================================================
CREATE TABLE coupon_redemptions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id            INTEGER NOT NULL REFERENCES coupons(id),
  purchase_session_id  INTEGER NOT NULL REFERENCES purchase_sessions(id),
  customer_email       TEXT NOT NULL,
  discount_pesewas     INTEGER NOT NULL CHECK (discount_pesewas >= 0), -- the actual discount amount applied — snapshotted, never recomputed later, same discipline as purchase_sessions.amount_pesewas
  redeemed_at          TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(purchase_session_id)
);

CREATE INDEX idx_coupon_redemptions_coupon ON coupon_redemptions(coupon_id);

-- ============================================================
-- PURCHASE_SESSIONS extension
-- Both columns purely additive and nullable/defaulted — no existing
-- row's meaning changes. discount_pesewas is snapshotted at
-- checkout-session creation time (the moment the discount is computed
-- and locked into the already-existing amount_pesewas column — see
-- services/commerceService.ts's createCheckoutSession()); the
-- original, pre-discount price is always recoverable as
-- amount_pesewas + discount_pesewas, never stored redundantly.
-- amount_pesewas itself keeps its exact existing meaning (the actual
-- charged amount, verified against Paystack's own confirmation) —
-- this migration deliberately does not change that column's semantics
-- or the webhook verification logic that depends on it.
-- ============================================================
-- discount_pesewas <= amount_pesewas + discount_pesewas (i.e. the
-- discount can never exceed the original price) is enforced at the
-- application layer in couponService.ts, not here — SQLite ALTER
-- TABLE ADD COLUMN CHECK constraints referencing another existing
-- column are unreliable across SQLite versions, the same reasoning
-- receipts.total_pesewas's own header comment already documents for
-- an equivalent cross-column invariant.
ALTER TABLE purchase_sessions ADD COLUMN coupon_id INTEGER REFERENCES coupons(id);
ALTER TABLE purchase_sessions ADD COLUMN discount_pesewas INTEGER NOT NULL DEFAULT 0 CHECK (discount_pesewas >= 0);
