-- ============================================================
-- 0053_library_learning_items.sql — Digital Library 2.0, Phase H
-- (Interactive Learning Experience). Two tables, mirroring
-- 0051_library_ai.sql's and 0052_library_bookmarks.sql's own
-- established conventions deliberately:
--
-- library_learning_items — admin-authored content, shared by every
-- customer who owns the (product_slug, asset_id) it targets, the same
-- "indexed/authored once, read by many" shape library_knowledge_documents
-- already uses. asset_id is the same free-text identifier
-- product_files.asset_id / library_knowledge_documents.asset_id already
-- use (no real FK target exists for it — product_files has no unique
-- constraint on asset_id alone). format is denormalized (derivable via
-- product_files, but every sibling table here already stores it
-- directly rather than joining for it). anchor_page_number/anchor_cfi
-- follow library_bookmarks' own exact pattern: format-specific
-- position, the other left NULL, application-enforced (not a DB
-- CHECK) — same as every sibling table.
--
-- The CHECK on item_type's required columns is the one new piece:
-- a 'quick_check' item genuinely needs its grading data present, an
-- 'action' item genuinely has none of it — enforced at the DB level
-- so a malformed row can never be inserted in the first place, not
-- just rejected by application code that could drift from the schema
-- over time.
--
-- status ('draft'/'published') mirrors products.status's own
-- draft-then-live pattern; customer-facing reads are always scoped to
-- 'published' only (see libraryLearningService.ts).
--
-- library_learning_responses — the customer's real, server-graded
-- answer/completion, keyed on deliveries.id exactly like
-- library_progress/library_bookmarks (the system's one canonical
-- entitlement unit), customer_id denormalized for the same no-join
-- bulk-read reason. UNIQUE(learning_item_id, customer_id): one row per
-- customer per item — re-answering UPDATEs the existing row (a real
-- "try again," not a duplicate history), matching library_progress's
-- own single-current-value philosophy rather than library_bookmarks'
-- multi-row one.
--
-- Rollback: `DROP TABLE library_learning_responses; DROP TABLE
-- library_learning_items;` — safe, nothing else in the schema
-- references either table.
-- ============================================================

CREATE TABLE library_learning_items (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  product_slug           TEXT NOT NULL REFERENCES products(slug),
  asset_id               TEXT NOT NULL,
  format                 TEXT NOT NULL CHECK (format IN ('PDF', 'EPUB')),
  item_type              TEXT NOT NULL CHECK (item_type IN ('quick_check', 'action')),
  anchor_page_number     INTEGER, -- PDF only; NULL for EPUB
  anchor_cfi             TEXT,    -- EPUB only; the chapter file's own href, same real-not-byte-precise convention as library_bookmarks.cfi
  prompt                 TEXT NOT NULL,
  choices                TEXT,    -- quick_check only; JSON array of option strings, admin-authored
  correct_choice_index   INTEGER, -- quick_check only; 0-based index into choices
  explanation            TEXT,    -- quick_check only; shown after answering — must be grounded in the actual book, the admin author's responsibility, never AI-fabricated at serve time
  action_label           TEXT,    -- action only; the concrete next step text
  status                 TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  sort_order             INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (item_type = 'quick_check' AND choices IS NOT NULL AND correct_choice_index IS NOT NULL AND explanation IS NOT NULL AND action_label IS NULL)
    OR
    (item_type = 'action' AND action_label IS NOT NULL AND choices IS NULL AND correct_choice_index IS NULL AND explanation IS NULL)
  )
);

-- The reader's own "what learning items exist for this open book,
-- published only" lookup.
CREATE INDEX idx_library_learning_items_asset ON library_learning_items(product_slug, asset_id, status);

-- The admin authoring list ("everything for this product," draft and published both).
CREATE INDEX idx_library_learning_items_product ON library_learning_items(product_slug);

CREATE TABLE library_learning_responses (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  learning_item_id       INTEGER NOT NULL REFERENCES library_learning_items(id),
  delivery_id            INTEGER NOT NULL REFERENCES deliveries(id),
  customer_id            INTEGER NOT NULL REFERENCES customers(id),
  selected_choice_index  INTEGER, -- quick_check only
  is_correct             INTEGER, -- quick_check only; server-computed against the item's own correct_choice_index at submit time — never accepted as raw client input
  action_done            INTEGER, -- action only; 0 or 1
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(learning_item_id, customer_id)
);

CREATE INDEX idx_library_learning_responses_customer ON library_learning_responses(customer_id);
CREATE INDEX idx_library_learning_responses_delivery ON library_learning_responses(delivery_id);
