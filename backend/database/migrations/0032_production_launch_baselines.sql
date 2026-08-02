-- ============================================================
-- 0032_production_launch_baselines.sql — Version 4.9 Phase 9
-- (Production Launch Baseline)
--
-- One row per captured baseline snapshot — the official, point-in-
-- time record of "true launch metrics" the founder's brief requires:
-- lifetime/customer/internal/development revenue, customers, orders,
-- products, bundles, resources, downloads, subscribers, reviews,
-- conversion rate, average order value, traffic, and top products
-- (JSON array). Every number is computed fresh from the live tables
-- at capture time by services/admin/productionBaselineService.ts —
-- this table only ever stores the result, never recomputes anything
-- itself.
--
-- Genuinely immutable, not just "please don't update this by
-- convention": the BEFORE UPDATE / BEFORE DELETE triggers below make
-- any UPDATE or DELETE against this table fail at the database layer,
-- regardless of what application code attempts. The only way data
-- ever enters this table is a fresh INSERT (a new baseline), matching
-- audit_logs' own "append-only by design" precedent elsewhere in this
-- schema, taken one step further since even a soft "we just don't
-- call UPDATE" convention isn't what "this becomes immutable" asks
-- for.
--
-- Rollback: `DROP TRIGGER trg_production_launch_baselines_no_update;
-- DROP TRIGGER trg_production_launch_baselines_no_delete;
-- DROP TABLE production_launch_baselines;` — safe, since nothing else
-- references this table by foreign key.
-- ============================================================

CREATE TABLE production_launch_baselines (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_version                TEXT NOT NULL,
  launch_date                     TEXT NOT NULL,
  notes                           TEXT,

  lifetime_revenue_pesewas        INTEGER NOT NULL,
  customer_revenue_pesewas        INTEGER NOT NULL,
  internal_revenue_pesewas        INTEGER NOT NULL,
  development_revenue_pesewas     INTEGER NOT NULL,

  customers_count                 INTEGER NOT NULL,
  orders_count                    INTEGER NOT NULL,
  products_count                  INTEGER NOT NULL,
  bundles_count                   INTEGER NOT NULL,
  resources_count                 INTEGER NOT NULL,
  downloads_count                 INTEGER NOT NULL,
  subscribers_count               INTEGER NOT NULL,
  reviews_count                   INTEGER NOT NULL,

  conversion_rate_percent         REAL,
  average_order_value_pesewas     INTEGER,
  traffic_page_views              INTEGER,

  top_products                    TEXT NOT NULL DEFAULT '[]', -- JSON array of {slug, title, orderCount, revenuePesewas}

  created_by                      INTEGER REFERENCES admin_users(id),
  created_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_production_launch_baselines_created_at ON production_launch_baselines(created_at);

CREATE TRIGGER trg_production_launch_baselines_no_update
BEFORE UPDATE ON production_launch_baselines
BEGIN
  SELECT RAISE(ABORT, 'production_launch_baselines is append-only and immutable — no row may ever be updated');
END;

CREATE TRIGGER trg_production_launch_baselines_no_delete
BEFORE DELETE ON production_launch_baselines
BEGIN
  SELECT RAISE(ABORT, 'production_launch_baselines is append-only and immutable — no row may ever be deleted');
END;
