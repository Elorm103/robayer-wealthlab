-- ============================================================
-- 0036_knowledge_base.sql — Version 5.0 Milestone 2 (Knowledge Base).
-- See docs/v5.0-milestone-2-engineering-report.md.
--
-- Five tables, each with one clear job — no duplicate-purpose tables:
--
-- knowledge_documents: the source-of-truth registry of everything the
-- Knowledge Base knows about, one row per indexable document
-- (a blog post, a resource, a product, or a crawled static page).
-- ALSO functions as the indexing queue itself (status='pending' is
-- picked up by a run; no separate queue table) — the same "the table
-- IS the queue" pattern this project already uses for ai_usage_log's
-- rejected-candidate rows, per the engineering rules' "reuse, don't
-- duplicate."
--
-- knowledge_chunks: the actual retrievable text, one row per chunk
-- of a document, with vector_id pointing to the corresponding
-- Cloudflare Vectorize vector (the embedding itself lives in
-- Vectorize, not D1 — same "D1 holds the structured record, a
-- binding holds the large payload" pattern R2/media_assets already
-- established).
--
-- knowledge_faqs: Q&A pairs extracted from a document's JSON-LD
-- FAQPage schema (where present) — a distinct, directly-citable shape
-- from generic chunk text, since "does this book/page answer X" is a
-- different retrieval need than "find text similar to X."
--
-- knowledge_indexing_runs: one row per incremental/full-rebuild run —
-- backs the admin dashboard's "Last indexing run" / health / queue
-- monitoring requirements.
--
-- knowledge_search_log: one row per search query — backs "Search
-- diagnostics" / "Search latency" / "Retrieval quality" requirements,
-- the same "the log IS the dashboard's data source" pattern
-- ai_usage_log already established for the AI Gateway.
--
-- version/content_hash versioning discipline matches the AI Gateway's
-- own prompt-versioning precedent: a re-indexed document's OLD chunks
-- are only deleted after the NEW chunks are successfully written and
-- embedded — never a window where a mid-reindex document has zero
-- searchable content.
--
-- Rollback: `DROP TABLE knowledge_search_log; DROP TABLE
-- knowledge_indexing_runs; DROP TABLE knowledge_faqs; DROP TABLE
-- knowledge_chunks; DROP TABLE knowledge_documents;` — safe, nothing
-- outside the Knowledge Base itself references these tables, and this
-- milestone ships with zero customer-facing features depending on
-- them yet (Customer AI is explicitly out of scope this milestone).
-- ============================================================

CREATE TABLE knowledge_documents (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  document_key          TEXT NOT NULL UNIQUE, -- stable identifier, e.g. 'blog_post:42', 'product:starting-to-invest-with-gh100', 'static_page:/investment-centre/treasury-bills/'
  source_type           TEXT NOT NULL CHECK (source_type IN ('blog_post', 'resource', 'product', 'static_page', 'cms_setting')),
  source_id             INTEGER,               -- blog_posts.id / resources.id; NULL for product (keyed by slug in document_key)/static_page/cms_setting
  source_url            TEXT,                  -- public citation URL
  title                 TEXT NOT NULL,
  -- Task: "Separate public knowledge from admin-only knowledge." Every
  -- source_type indexed by this milestone is public content; the
  -- column exists now so a future internal-SOPs/engineering-docs
  -- source_type (explicitly out of scope to EXPOSE this milestone,
  -- per the brief) can be added later without a schema change.
  visibility             TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'admin_only')),
  data_classification    TEXT NOT NULL DEFAULT 'PRODUCTION' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN')),
  content_hash           TEXT NOT NULL,         -- SHA-256 of the extracted raw text — staleness/change detection, same discipline as media_assets.content_hash
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'indexed', 'failed')),
  error_message          TEXT,
  chunk_count            INTEGER NOT NULL DEFAULT 0,
  version                INTEGER NOT NULL DEFAULT 1, -- increments on every successful re-index
  indexed_at             TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_knowledge_documents_source ON knowledge_documents(source_type, source_id);
CREATE INDEX idx_knowledge_documents_status ON knowledge_documents(status);

CREATE TABLE knowledge_chunks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id      INTEGER NOT NULL REFERENCES knowledge_documents(id),
  chunk_index      INTEGER NOT NULL,
  chunk_text       TEXT NOT NULL,
  chunk_tokens     INTEGER NOT NULL,
  vector_id        TEXT NOT NULL UNIQUE,   -- the Vectorize vector's id
  embedding_model  TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_knowledge_chunks_document ON knowledge_chunks(document_id);

CREATE TABLE knowledge_faqs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id   INTEGER NOT NULL REFERENCES knowledge_documents(id),
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_knowledge_faqs_document ON knowledge_faqs(document_id);

CREATE TABLE knowledge_indexing_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_type              TEXT NOT NULL CHECK (run_type IN ('incremental', 'full_rebuild')),
  trigger_type          TEXT NOT NULL CHECK (trigger_type IN ('admin_manual', 'content_change')),
  triggered_by          INTEGER REFERENCES admin_users(id),
  status                TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  documents_seen        INTEGER NOT NULL DEFAULT 0,
  documents_indexed     INTEGER NOT NULL DEFAULT 0,
  documents_unchanged   INTEGER NOT NULL DEFAULT 0,
  documents_failed      INTEGER NOT NULL DEFAULT 0,
  chunks_created        INTEGER NOT NULL DEFAULT 0,
  started_at            TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at          TEXT,
  error_message         TEXT
);

CREATE INDEX idx_knowledge_indexing_runs_started ON knowledge_indexing_runs(started_at);

CREATE TABLE knowledge_search_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  query_text          TEXT NOT NULL,
  actor_type          TEXT NOT NULL CHECK (actor_type IN ('customer', 'admin', 'system')),
  actor_id            INTEGER,
  visibility_scope    TEXT NOT NULL CHECK (visibility_scope IN ('public', 'admin_only')),
  result_count        INTEGER NOT NULL,
  top_score           REAL,
  latency_ms          INTEGER NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_knowledge_search_log_created ON knowledge_search_log(created_at);
