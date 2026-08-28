-- ============================================================
-- 0051_library_ai.sql — Digital Library Phase 7C (AI Reading
-- Assistant). Mirrors migration 0036 (knowledge_base) and 0039
-- (customer_ai)'s own table shapes and versioning discipline closely
-- on purpose — this is the SAME kind of system (extract -> chunk ->
-- embed -> retrieve -> ground an answer), applied to a structurally
-- SEPARATE content pool. Nothing here is joined to knowledge_documents/
-- knowledge_chunks, and nothing in those tables is joined to this
-- migration — the two knowledge bases never touch.
--
-- library_knowledge_documents: one row per (product_slug, asset_id) —
-- a PURCHASED RESOURCE, not a customer. Content is identical for every
-- customer who owns the same asset, so it is indexed once, shared, and
-- authorization is checked at QUERY time (checkEntitlement, unchanged
-- from Phase 7A/7B), never by duplicating chunks per customer.
-- content_hash/version/status mirror knowledge_documents.ts's own
-- staleness-detection discipline exactly.
--
-- library_knowledge_chunks: the retrievable text. page_number is real
-- and substantiated (extracted per-page via pdf-parse's getText({partial:[n]}),
-- never inferred) for PDF; chapter_title is populated only when a real
-- PDF outline entry covers that page (NULL otherwise — never guessed).
-- cfi is reserved for a future EPUB reader/extractor and is NOT written
-- by anything in Phase 7C.
--
-- library_ai_messages / library_ai_message_citations: mirror
-- customer_ai_messages/customer_ai_message_citations's shape, with one
-- deliberate difference — customer_id IS present here (unlike the
-- public assistant's explicitly stateless, no-identity design). A
-- purchased-resource conversation is inherently tied to a specific
-- customer's entitlement, and Phase 7B already established that this
-- assistant's authorization chain requires a real, bound identity.
-- purchase_reference/asset_id are stored for the same reason: an audit
-- trail proving which resource an answer was actually grounded in.
--
-- Rollback: `DROP TABLE library_ai_message_citations; DROP TABLE
-- library_ai_messages; DROP TABLE library_knowledge_chunks; DROP TABLE
-- library_knowledge_documents;` — safe, nothing outside Phase 7C's own
-- code reads these tables.
-- ============================================================

CREATE TABLE library_knowledge_documents (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  product_slug     TEXT NOT NULL,
  asset_id         TEXT NOT NULL,
  source_type      TEXT NOT NULL CHECK (source_type IN ('PDF', 'EPUB')),
  total_pages      INTEGER, -- PDF only; NULL for EPUB
  content_hash     TEXT NOT NULL, -- SHA-256 of the extracted raw text — staleness/change detection, same discipline as knowledge_documents.content_hash
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'indexed', 'failed', 'unsupported_format')),
  error_message    TEXT,
  chunk_count      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1, -- increments on every successful re-index
  indexed_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_library_knowledge_documents_asset ON library_knowledge_documents(product_slug, asset_id);
CREATE INDEX idx_library_knowledge_documents_status ON library_knowledge_documents(status);

CREATE TABLE library_knowledge_chunks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id      INTEGER NOT NULL REFERENCES library_knowledge_documents(id),
  chunk_index      INTEGER NOT NULL,
  chunk_text       TEXT NOT NULL,
  chunk_tokens     INTEGER NOT NULL,
  page_number      INTEGER, -- PDF only; real, extracted per-page — never inferred
  chapter_title    TEXT,    -- populated only from a real PDF outline entry covering this page; NULL when none exists
  cfi              TEXT,    -- EPUB only; reserved, unused until an EPUB extractor ships
  vector_id        TEXT NOT NULL UNIQUE, -- the LIBRARY_KNOWLEDGE_INDEX vector's id
  embedding_model  TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_library_knowledge_chunks_document ON library_knowledge_chunks(document_id);

CREATE TABLE library_ai_messages (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id           INTEGER NOT NULL REFERENCES customers(id),
  purchase_reference    TEXT NOT NULL,
  asset_id              TEXT NOT NULL,
  mode                  TEXT NOT NULL CHECK (mode IN ('explain', 'summarize', 'teach', 'example', 'quiz', 'key_takeaways', 'ask')),
  question_text         TEXT NOT NULL,
  current_page          INTEGER, -- the page the reader was on when asked — informational/retrieval-biasing context only, never an authorization signal
  answer_text           TEXT,    -- NULL when status = 'declined' (very-low confidence) or 'error'
  status                TEXT NOT NULL CHECK (status IN ('answered', 'declined', 'error')),
  confidence_tier       TEXT NOT NULL CHECK (confidence_tier IN ('high', 'medium', 'low', 'very_low')),
  top_score             REAL,
  retrieval_latency_ms  INTEGER,
  llm_latency_ms        INTEGER,
  total_latency_ms      INTEGER NOT NULL,
  error_message         TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_library_ai_messages_customer ON library_ai_messages(customer_id);
CREATE INDEX idx_library_ai_messages_created ON library_ai_messages(created_at);

CREATE TABLE library_ai_message_citations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id     INTEGER NOT NULL REFERENCES library_ai_messages(id),
  document_id    INTEGER NOT NULL REFERENCES library_knowledge_documents(id),
  chunk_id       INTEGER REFERENCES library_knowledge_chunks(id),
  score          REAL NOT NULL,
  rank           INTEGER NOT NULL
);

CREATE INDEX idx_library_ai_citations_message ON library_ai_message_citations(message_id);
