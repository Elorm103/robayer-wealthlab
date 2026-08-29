-- ============================================================
-- 0052_library_bookmarks.sql — Digital Library 2.0, Feature 5
-- (Bookmarks). Mirrors 0050_library_progress.sql's own architecture
-- deliberately: keyed on deliveries.id (the system's one canonical
-- entitlement unit), customer_id denormalized for the same no-join
-- bulk-read reason, format-specific position column (page_number for
-- PDF, cfi for EPUB — never both).
--
-- The one real difference from library_progress: this is a MULTI-row
-- relationship (a customer can bookmark several positions in one
-- book), so there is no UNIQUE(delivery_id) — that constraint is what
-- made library_progress correctly "one current position," and would
-- be wrong here.
--
-- label is a short, customer-facing description of what was
-- bookmarked (the reader supplies real context it already has —
-- chapter/section title, or a short excerpt — never fabricated;
-- NULL is a completely valid, honest value when no such context was
-- available at save time).
--
-- Rollback: `DROP TABLE library_bookmarks;` — safe, nothing else in
-- the schema references this table.
-- ============================================================

CREATE TABLE library_bookmarks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id   INTEGER NOT NULL REFERENCES deliveries(id),
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  format        TEXT NOT NULL CHECK (format IN ('PDF', 'EPUB')),
  page_number   INTEGER, -- PDF only; NULL for EPUB
  cfi           TEXT,    -- EPUB only; NULL for PDF
  label         TEXT,    -- optional real context (chapter/section title or excerpt) — never fabricated
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The Library-wide "My Bookmarks" view: every bookmark across this
-- customer's whole purchase history, in one indexed scan.
CREATE INDEX idx_library_bookmarks_customer ON library_bookmarks(customer_id);
-- The in-reader "Bookmarks for this book" panel.
CREATE INDEX idx_library_bookmarks_delivery ON library_bookmarks(delivery_id);
