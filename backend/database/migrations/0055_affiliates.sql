-- ============================================================
-- 0055_affiliates.sql: Affiliate Programme, Stage A (Database +
-- Core Service Foundation).
--
-- Robayer WealthLab is a single-vendor platform: every product is
-- sold by Robayer itself (products.creator_id is always the founder's
-- admin_users row, see products' own migration-0017 header comment).
-- There is no creator/vendor revenue split to compute against. An
-- earlier, unbuilt Version 3.0 planning pass (docs/v3-affiliate-
-- architecture.md, docs/v3-database-design.md) designed a full
-- affiliate system for a DIFFERENT, never-realized multi-vendor
-- marketplace shape (platform_users, per-creator-approved
-- affiliate_product_links, commission computed on a creator's 85%
-- share). That design is reference material only and is deliberately
-- NOT reintroduced here; confirmed live that platform_users/
-- affiliate_product_links/affiliate_clicks/user_roles were never
-- created (SELECT name FROM sqlite_master WHERE name LIKE
-- '%affiliate%' returns zero rows today). This migration designs
-- affiliate tracking fresh, for the platform's actual current shape:
-- one seller, commission is a straight percentage of the amount a
-- customer actually paid, and admin (not a creator) approves
-- affiliates and sets rates.
--
-- Identity: an affiliate IS an existing `customers` row, extended,
-- not a second identity/auth system. `affiliates.customer_id` is
-- UNIQUE (one affiliate profile per customer), reusing
-- customer_sessions/customer auth entirely as-is. This mirrors how
-- `customer_profiles` already extends `customers` 1:1.
--
-- Money: integer pesewas throughout, matching every other financial
-- table in this schema, never a float. Every commission percentage
-- and pesewas amount actually used for a transaction is snapshotted
-- at the moment it's computed (mirrors purchase_sessions.
-- product_title/amount_pesewas's own "never let a later edit
-- retroactively rewrite history" discipline), a later change to
-- affiliates.default_commission_percent, an affiliate_product_rates
-- row, or even an affiliate's status never alters an
-- affiliate_commissions row already written.
--
-- Click ledger: `affiliate_clicks` is deliberately its own durable
-- table, not a reuse of the existing generic `analytics_events` table.
-- analytics_events has a `purged_at` column (a real, live retention/
-- purge policy for that table), which makes it unsuitable as the
-- durable, financial-adjacent record a commission dispute might later
-- need to reference. affiliate_clicks is never purged. (A calling
-- service MAY additionally mirror a click into analytics_events as
-- event_type='affiliate_click' purely so it shows up in the existing
-- traffic-source admin dashboards for free; that is an application-
-- layer choice, not a schema one, and does not change which table is
-- authoritative.)
--
-- Commission idempotency: affiliate_commissions.purchase_session_id is
-- UNIQUE: exactly coupon_redemptions' own proven double-write guard
-- (UNIQUE(purchase_session_id)) for the identical reason: this table
-- is written from the payment-verification path, which can in
-- principle be re-entered (a redelivered webhook, an admin re-running
-- purchase processing) and must never create a second commission for
-- the same sale.
--
-- purchase_sessions gets the same three-column "locked at checkout,
-- cross-checked/finalized at verification" treatment coupon_id/
-- discount_pesewas already have: affiliate_id (who gets credit, set
-- once at checkout-session creation from the rwl_ref cookie),
-- affiliate_commission_percent and affiliate_commission_pesewas (the
-- actual snapshotted numbers, written once at verification, alongside
-- affiliate_commissions, kept redundantly on purchase_sessions too
-- purely for cheap, join-free display on the customer/admin order
-- views the same way discount_pesewas already is).
--
-- Table creation order matters here specifically because D1 does not
-- honor `PRAGMA foreign_keys=OFF` (confirmed directly against this
-- same database in migration 0054's own investigation): every
-- REFERENCES target must already exist. Order: affiliates ->
-- affiliate_product_rates -> affiliate_clicks -> affiliate_payouts ->
-- affiliate_commissions (the only table referencing affiliate_payouts)
-- -> the purchase_sessions ALTERs (referencing affiliates).
--
-- data_classification: migration 0028 added this column to every
-- customer-facing/business-relevant table (PRODUCTION / INTERNAL /
-- DEVELOPMENT / UNKNOWN, see that migration's own header comment for
-- the full reasoning) so Executive Dashboard/KPI queries can exclude
-- internal-team and test activity without ever deleting or moving a
-- row. All five new tables here are exactly that kind of table
-- (clicks/commissions/payouts feed real business KPIs) and get the
-- same column, same CHECK, same DEFAULT 'UNKNOWN' pattern; application
-- code (affiliateService.ts) always writes an explicit value at INSERT
-- time (mirroring couponService.ts's createCoupon(), which always
-- writes 'PRODUCTION' since every insert happens through one real,
-- authenticated code path with no legacy backfill ambiguity). Excluded
-- from nothing here since none of these five tables are the kind of
-- pure session/token/audit-history table 0028 deliberately excluded.
--
-- Rollback (reverse order, respecting the same FK dependency chain;
-- DROP TABLE removes that table's own indexes automatically, no
-- separate DROP INDEX needed):
--   ALTER TABLE purchase_sessions DROP COLUMN affiliate_commission_pesewas;
--   ALTER TABLE purchase_sessions DROP COLUMN affiliate_commission_percent;
--   ALTER TABLE purchase_sessions DROP COLUMN affiliate_id;
--   DROP TABLE affiliate_commissions;
--   DROP TABLE affiliate_payouts;
--   DROP TABLE affiliate_clicks;
--   DROP TABLE affiliate_product_rates;
--   DROP TABLE affiliates;
-- ============================================================

-- AFFILIATES: one row per person applying to / approved for the
-- programme. affiliate_code is the short, human-shareable identifier
-- used in referral URLs (?ref=CODE) and is intentionally NOT the
-- surrogate `id`, never leak a raw autoincrement integer into a
-- public URL. default_commission_percent is admin-set at approval
-- time (see affiliateService.ts for the actual default value used
-- when approving) and is itself only ever a fallback, see
-- affiliate_product_rates below and affiliateService.ts's documented
-- precedence order.
CREATE TABLE affiliates (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id                 INTEGER NOT NULL UNIQUE REFERENCES customers(id),
  affiliate_code               TEXT NOT NULL UNIQUE,
  status                       TEXT NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  default_commission_percent   INTEGER NOT NULL DEFAULT 20
                                  CHECK (default_commission_percent BETWEEN 0 AND 100),
  payout_method                TEXT CHECK (payout_method IS NULL OR payout_method IN ('mobile_money', 'bank_transfer')),
  payout_details                TEXT, -- provider + last-4/reference only, never a full account number, matches media_assets' own "no secrets at rest" posture
  terms_accepted_at             TEXT,
  terms_version                 TEXT,
  applied_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at                    TEXT,
  decided_by                    INTEGER REFERENCES admin_users(id),
  rejection_reason              TEXT,
  suspended_at                  TEXT,
  suspended_reason              TEXT,
  reactivated_at                TEXT,
  created_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  data_classification           TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'))
);

CREATE INDEX idx_affiliates_status ON affiliates(status);
CREATE INDEX idx_affiliates_code ON affiliates(affiliate_code);

-- AFFILIATE_PRODUCT_RATES: optional per-(affiliate, product)
-- commission override. Absence of a row for a given (affiliate,
-- product) pair means affiliates.default_commission_percent applies;
-- see affiliateService.ts's resolveCommissionPercent() precedence.
-- Admin-set only (there is no creator role in this platform to
-- delegate this to, unlike the abandoned V3.0 marketplace design).
CREATE TABLE affiliate_product_rates (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id        INTEGER NOT NULL REFERENCES affiliates(id),
  product_id          INTEGER NOT NULL REFERENCES products(id),
  commission_percent   INTEGER NOT NULL CHECK (commission_percent BETWEEN 0 AND 100),
  set_by               INTEGER NOT NULL REFERENCES admin_users(id),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  data_classification  TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN')),

  UNIQUE(affiliate_id, product_id)
);

CREATE INDEX idx_affiliate_product_rates_affiliate ON affiliate_product_rates(affiliate_id);

-- AFFILIATE_CLICKS: durable, never-purged click ledger. See this
-- file's own header comment for why this is a dedicated table rather
-- than a reuse of analytics_events. ip_hash is SHA-256 of the raw
-- request IP, matching this project's existing hash-not-store privacy
-- posture (docs/v2-security-review.md); the raw IP itself is never
-- persisted anywhere.
CREATE TABLE affiliate_clicks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id   INTEGER NOT NULL REFERENCES affiliates(id),
  product_slug   TEXT,           -- NULL = a general (e.g. homepage) referral link, not product-specific
  landing_path   TEXT NOT NULL,
  referrer       TEXT,
  ip_hash        TEXT NOT NULL,
  clicked_at     TEXT NOT NULL DEFAULT (datetime('now')),
  data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'))
);

CREATE INDEX idx_affiliate_clicks_affiliate ON affiliate_clicks(affiliate_id);
CREATE INDEX idx_affiliate_clicks_clicked_at ON affiliate_clicks(clicked_at);
CREATE INDEX idx_affiliate_clicks_classification ON affiliate_clicks(data_classification);

-- AFFILIATE_PAYOUTS: the internal payout ledger. Deliberately no
-- payment-provider integration in this phase (per explicit product
-- instruction): `processed_at`/`reference` record that an admin has
-- ALREADY sent the money externally (mobile money / bank transfer)
-- and is now just recording that fact; this table never itself moves
-- money. Created before affiliate_commissions below because
-- affiliate_commissions.payout_id references it (D1 enforces FK
-- targets must already exist).
CREATE TABLE affiliate_payouts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id    INTEGER NOT NULL REFERENCES affiliates(id),
  amount_pesewas  INTEGER NOT NULL CHECK (amount_pesewas > 0),
  status          TEXT NOT NULL DEFAULT 'requested'
                     CHECK (status IN ('requested', 'approved', 'processing', 'paid', 'failed', 'cancelled')),
  method          TEXT NOT NULL CHECK (method IN ('mobile_money', 'bank_transfer')),
  reference        TEXT,          -- the real external MoMo/bank transaction reference, once actually paid, never fabricated
  requested_at      TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at       TEXT,
  approved_by       INTEGER REFERENCES admin_users(id),
  processed_at      TEXT,
  processed_by      INTEGER REFERENCES admin_users(id),
  failure_reason    TEXT,
  cancelled_reason  TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'))
);

CREATE INDEX idx_affiliate_payouts_affiliate ON affiliate_payouts(affiliate_id);
CREATE INDEX idx_affiliate_payouts_status ON affiliate_payouts(status);

-- AFFILIATE_COMMISSIONS: one row per (purchase_session), written
-- exactly once, only from the payment-verification path
-- (commerceService.completeVerifiedPurchase(), mirroring exactly where
-- coupon_redemptions is written from). UNIQUE(purchase_session_id) is
-- the idempotency guard, see this file's own header comment.
-- gross_pesewas is the actual amount the customer paid (already
-- net of any coupon discount, since that's what purchase_sessions.
-- amount_pesewas already means): commission is never computed
-- against a pre-discount list price.
CREATE TABLE affiliate_commissions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id          INTEGER NOT NULL REFERENCES affiliates(id),
  purchase_session_id   INTEGER NOT NULL UNIQUE REFERENCES purchase_sessions(id),
  product_id            INTEGER NOT NULL REFERENCES products(id),
  gross_pesewas         INTEGER NOT NULL CHECK (gross_pesewas >= 0),
  commission_percent    INTEGER NOT NULL CHECK (commission_percent BETWEEN 0 AND 100),
  commission_pesewas    INTEGER NOT NULL CHECK (commission_pesewas >= 0),
  status                TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'payable', 'paid', 'reversed')),
  reversed_at            TEXT,
  reversed_reason        TEXT,   -- e.g. "order refunded", "order cancelled", "chargeback"; always set whenever status='reversed'
  approved_at            TEXT,
  payable_at             TEXT,
  paid_at                TEXT,
  payout_id              INTEGER REFERENCES affiliate_payouts(id),
  adjustment_note        TEXT,   -- set only by an audited manual admin adjustment (see affiliateService.ts's adjustCommission()), never set by any automatic path
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  data_classification    TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'))
);

CREATE INDEX idx_affiliate_commissions_affiliate_status ON affiliate_commissions(affiliate_id, status);
CREATE INDEX idx_affiliate_commissions_status ON affiliate_commissions(status);
CREATE INDEX idx_affiliate_commissions_payout ON affiliate_commissions(payout_id);
CREATE INDEX idx_affiliate_commissions_classification ON affiliate_commissions(data_classification);

-- purchase_sessions: locked-at-checkout attribution + finalized-at-
-- verification commission snapshot, matching coupon_id/discount_pesewas's
-- own existing pattern on this exact table.
ALTER TABLE purchase_sessions ADD COLUMN affiliate_id INTEGER REFERENCES affiliates(id);
ALTER TABLE purchase_sessions ADD COLUMN affiliate_commission_percent INTEGER;
ALTER TABLE purchase_sessions ADD COLUMN affiliate_commission_pesewas INTEGER;

CREATE INDEX idx_purchase_sessions_affiliate ON purchase_sessions(affiliate_id);
