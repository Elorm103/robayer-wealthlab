-- ============================================================
-- 0027_product_bundles.sql — Version 4.0 Milestone D (Second Product
-- Ecosystem & Bundles)
--
-- A bundle is deliberately just another `products` row — same table,
-- same price/sale/currency columns, same checkout path
-- (commerceService.ts resolves it via productCatalogService.ts's
-- fetchCatalogProduct() exactly like any single product). This is
-- what lets Milestone D satisfy "do not redesign checkout, do not
-- duplicate pricing logic" literally: nothing about checkout, Paystack
-- metadata, webhook verification, or sale pricing needs to know a
-- bundle exists at all.
--
-- Two additions only:
--
-- 1. `products.is_bundle` — a plain additive column with its own new
--    CHECK, not a new `product_type` enum value. Widening the existing
--    `product_type` CHECK constraint would require SQLite's only
--    mechanism for altering a CHECK — rebuilding the whole table (copy
--    to a new table, drop, rename) — a real risk to a table every
--    other commerce/catalog table foreign-keys into, for no actual
--    benefit: `product_type` already exists to describe a product's
--    *format* (ebook/guide/template/etc.), which a bundle still
--    meaningfully has (an admin picks whichever type best describes
--    its contents). `is_bundle` is an orthogonal fact — *how many
--    things you get*, not *what kind of thing* — and a plain
--    `ALTER TABLE ADD COLUMN ... CHECK (...)` is fully additive and
--    zero-risk to every existing row and every existing query.
--
-- 2. `bundle_items` — a new junction table mapping a bundle product to
--    the real products it contains, mirroring `product_relations`'s
--    exact shape (a `(product_id, related_product_id)`-style pair with
--    `sort_order`) but kept as its own table rather than a new
--    `relation_type` value on `product_relations` itself. Reusing
--    `product_relations` would conflate two different concepts:
--    "related/cross-sell/recommended" are purely presentational
--    suggestions (shown in a "you might also like" section), while
--    bundle membership is structural — it determines what a customer
--    is actually entitled to download and review after paying. Any
--    existing or future code that queries `product_relations` for
--    display purposes would need to remember to filter out bundle
--    membership rows, a real, easy-to-miss correctness risk for no
--    benefit over a dedicated table. This mirrors this project's own
--    established precedent (reviewReminderService.ts's
--    review_reminder_attempts deliberately NOT layered onto the
--    generic, multi-purpose email_log table for the same class of
--    reason — see migration 0022's header comment).
--
-- `UNIQUE(bundle_product_id, item_product_id)` makes "add the same
-- item to a bundle twice" impossible at the database layer, not just
-- an application-level check.
--
-- Rollback: `ALTER TABLE products DROP COLUMN is_bundle; DROP TABLE
-- bundle_items;` — safe at any time. No other table references
-- `is_bundle`; `bundle_items` is only ever read by
-- productCatalogService.ts's fetchCatalogProduct() (falls back to
-- treating every product as a non-bundle if the column is absent,
-- which is exactly this migration's own "before" state) and
-- reviewService.ts's review-eligibility check (falls back to the
-- existing exact-slug-match behavior).
-- ============================================================

ALTER TABLE products ADD COLUMN is_bundle INTEGER NOT NULL DEFAULT 0 CHECK (is_bundle IN (0, 1));

CREATE TABLE bundle_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_product_id  INTEGER NOT NULL REFERENCES products(id),
  item_product_id    INTEGER NOT NULL REFERENCES products(id),
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(bundle_product_id, item_product_id)
);

CREATE INDEX idx_bundle_items_bundle ON bundle_items(bundle_product_id);
CREATE INDEX idx_bundle_items_item ON bundle_items(item_product_id);
