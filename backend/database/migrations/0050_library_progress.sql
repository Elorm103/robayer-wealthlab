-- ============================================================
-- 0050_library_progress.sql — Digital Library Phase 7B (Personal
-- Reading Experience). Real, persisted reading position — the
-- capability the Phase 1-4 report explicitly deferred until an actual
-- in-browser reader existed to report a genuine signal (Phase 7A) and
-- the Phase 7 gap analysis named as P0.
--
-- Keyed 1:1 on deliveries.id, not a fresh (customer_id, product_id)
-- composite: `deliveries` is already this system's canonical
-- entitlement unit — one row per (purchase, asset) — and reusing it
-- directly means progress inherits the exact same ownership boundary
-- entitlementService.ts already enforces everywhere else, rather than
-- a second, parallel notion of "which resource does this belong to."
-- customer_id is denormalized onto this row anyway (not just reachable
-- via deliveries -> purchase_sessions) so the customer-scoped bulk
-- read the Library page needs ("all of this customer's in-progress
-- reads") never requires a join through purchase_sessions at all.
--
-- format/current_page/total_pages are the real PDF signal Phase 7A's
-- reader can report today. cfi is reserved, NOT written by anything
-- in Phase 7B — EPUB reading itself isn't built yet (still an honest
-- "not yet supported" in the reader), so writing to this column now
-- would be exactly the fabricated-progress outcome the original brief
-- prohibited. It exists so EPUB support, whenever it ships, is a new
-- reader capability, not a second migration.
--
-- percent_complete and status are SERVER-derived from current_page/
-- total_pages, never accepted as raw client input — the same "trust
-- the computation, not the client" posture as downloadsRemaining.
--
-- Rollback: `DROP TABLE library_progress;` — safe, nothing else in
-- the schema references this table.
-- ============================================================

CREATE TABLE library_progress (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id       INTEGER NOT NULL UNIQUE REFERENCES deliveries(id),
  customer_id       INTEGER NOT NULL REFERENCES customers(id),
  format            TEXT NOT NULL CHECK (format IN ('PDF', 'EPUB')),
  current_page      INTEGER, -- PDF only; NULL for EPUB
  total_pages       INTEGER, -- PDF only; NULL for EPUB
  cfi               TEXT,    -- EPUB only; reserved, unused until an EPUB reader ships
  percent_complete  INTEGER NOT NULL DEFAULT 0 CHECK (percent_complete BETWEEN 0 AND 100),
  status            TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed')),
  last_read_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The Library page's own query: every in-progress/completed resource
-- for one customer, across all their purchases, in one indexed scan.
CREATE INDEX idx_library_progress_customer ON library_progress(customer_id);
