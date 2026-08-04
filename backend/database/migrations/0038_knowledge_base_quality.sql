-- ============================================================
-- 0038_knowledge_base_quality.sql — Version 5.0 Milestone 2.2
-- (Retrieval Quality Calibration & Search Optimization). See
-- docs/v5.0-milestone-2.2-engineering-report.md.
--
-- Three additive changes, one migration, each backing a distinct
-- Milestone 2.2 task:
--
-- knowledge_documents.embedding_model/embedding_version/embedded_at/
-- embedding_refreshed_at (Task 5): document-level embedding
-- provenance, so an admin can identify which documents need
-- re-embedding after a future OpenAI model change without joining
-- through knowledge_chunks (which already has embedding_model per
-- chunk, but not a document-level "when was this first/last
-- embedded" summary). embedding_version is an app-level string
-- (bumped only when this project deliberately changes its own
-- chunking/embedding STRATEGY, e.g. a new chunk-sizing rule) —
-- distinct from embedding_model (the raw provider model name, e.g.
-- "text-embedding-3-small"), since a strategy change and a provider
-- model change are different reasons a document might need
-- re-embedding.
--
-- knowledge_search_log.top_document_id (Task 4): backs "most
-- frequently retrieved documents" analytics — which document was the
-- #1 result for a given search. Nullable (a zero-result search has no
-- top document). References knowledge_documents so a deleted/
-- re-indexed document's history stays attributable.
--
-- knowledge_indexing_dead_letters (Task 7): tracks queue messages that
-- exhausted wrangler.jsonc's max_retries on the (single, existing)
-- indexing queue — no second Cloudflare Queue was provisioned for
-- this, per the brief's "use the existing Queue, do not create
-- unnecessary infrastructure." The Worker's queue() handler catches an
-- infrastructure-level failure, checks each message's own `attempts`
-- field against the configured max_retries, and — only once truly
-- exhausted — records here for admin visibility and manual retry,
-- rather than being silently dropped (Milestone 2.1's own documented
-- known limitation).
--
-- Rollback: `DROP TABLE knowledge_indexing_dead_letters; ALTER TABLE
-- knowledge_search_log DROP COLUMN top_document_id; ALTER TABLE
-- knowledge_documents DROP COLUMN embedding_refreshed_at; ALTER TABLE
-- knowledge_documents DROP COLUMN embedded_at; ALTER TABLE
-- knowledge_documents DROP COLUMN embedding_version; ALTER TABLE
-- knowledge_documents DROP COLUMN embedding_model;` — safe, all
-- additive with safe defaults, nothing outside Milestone 2.2's own
-- code reads them.
-- ============================================================

ALTER TABLE knowledge_documents ADD COLUMN embedding_model TEXT;
ALTER TABLE knowledge_documents ADD COLUMN embedding_version TEXT;
ALTER TABLE knowledge_documents ADD COLUMN embedded_at TEXT;
ALTER TABLE knowledge_documents ADD COLUMN embedding_refreshed_at TEXT;

ALTER TABLE knowledge_search_log ADD COLUMN top_document_id INTEGER REFERENCES knowledge_documents(id);

CREATE TABLE knowledge_indexing_dead_letters (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER REFERENCES knowledge_indexing_runs(id),
  document_id     INTEGER REFERENCES knowledge_documents(id),
  document_key    TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  payload         TEXT NOT NULL, -- JSON-serialized KnowledgeIndexQueueMessage, so a retry can be re-enqueued verbatim
  reason          TEXT NOT NULL,
  attempts        INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retried', 'abandoned')),
  failed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  retried_at      TEXT,
  retried_by      INTEGER REFERENCES admin_users(id)
);

CREATE INDEX idx_knowledge_dead_letters_status ON knowledge_indexing_dead_letters(status);
