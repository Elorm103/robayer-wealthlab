-- ============================================================
-- 0039_customer_ai.sql — Version 5.0 Milestone 3 (Customer AI).
-- See docs/v5.0-milestone-3-engineering-report.md.
--
-- Three tables, deliberately NOT reusing knowledge_search_log: a
-- customer-AI turn is a genuinely different event than a raw search —
-- it has a generated answer, a customer-facing confidence tier (a
-- 4-band behavior layered on top of the Knowledge Base's own 3-band
-- high/medium/low, never redesigning it — see ranking.ts, unchanged),
-- an LLM cost/latency component the Knowledge Base's own search never
-- had, and feedback. searchKnowledge() is still called under the hood
-- for every turn, so knowledge_search_log keeps recording retrieval-
-- level analytics for free — this is additive, not a replacement.
--
-- No account/customer identity anywhere in this schema, per the
-- brief's explicit "no account memory, each conversation is
-- stateless": session_id is a client-generated UUID that exists only
-- to group a browser session's turns together for observability (e.g.
-- "how many questions does a typical visit ask"), never a foreign key
-- to customers/admin_users, and nothing here is ever joined back to a
-- real identity.
--
-- customer_ai_messages: one row per question-answer turn.
--
-- customer_ai_message_citations: which knowledge_documents/knowledge_chunks
-- backed a given answer, and at what rank/score — lets an admin verify
-- an answer was genuinely grounded, and backs citation-accuracy
-- analytics later.
--
-- customer_ai_feedback: Helpful/Not Helpful, one row per message (a
-- customer can submit feedback once; a second submission for the same
-- message updates rather than duplicates — enforced by the service
-- layer, not a UNIQUE constraint, since a customer might reasonably
-- change their mind and the read pattern only ever wants the latest).
--
-- Rollback: `DROP TABLE customer_ai_feedback; DROP TABLE
-- customer_ai_message_citations; DROP TABLE customer_ai_messages;` —
-- safe, nothing outside Milestone 3's own code reads these tables.
-- ============================================================

CREATE TABLE customer_ai_messages (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT NOT NULL, -- client-generated UUID, groups turns within one browser session only — never a customer identity
  question_text         TEXT NOT NULL,
  answer_text           TEXT, -- NULL when status = 'declined' (very-low confidence) or 'error'
  status                TEXT NOT NULL CHECK (status IN ('answered', 'declined', 'error')),
  confidence_tier       TEXT NOT NULL CHECK (confidence_tier IN ('high', 'medium', 'low', 'very_low')),
  top_score             REAL, -- the top retrieved result's blended score (ranking.ts), NULL if zero results
  retrieval_latency_ms  INTEGER,
  llm_latency_ms        INTEGER,
  total_latency_ms      INTEGER NOT NULL,
  error_message         TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_customer_ai_messages_session ON customer_ai_messages(session_id);
CREATE INDEX idx_customer_ai_messages_created ON customer_ai_messages(created_at);
CREATE INDEX idx_customer_ai_messages_status ON customer_ai_messages(status);

CREATE TABLE customer_ai_message_citations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id     INTEGER NOT NULL REFERENCES customer_ai_messages(id),
  document_id    INTEGER NOT NULL REFERENCES knowledge_documents(id),
  chunk_id       INTEGER REFERENCES knowledge_chunks(id),
  score          REAL NOT NULL,
  rank           INTEGER NOT NULL -- 1-based position among the citations actually shown to the customer
);

CREATE INDEX idx_customer_ai_citations_message ON customer_ai_message_citations(message_id);
CREATE INDEX idx_customer_ai_citations_document ON customer_ai_message_citations(document_id);

CREATE TABLE customer_ai_feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    INTEGER NOT NULL REFERENCES customer_ai_messages(id),
  feedback      TEXT NOT NULL CHECK (feedback IN ('helpful', 'not_helpful')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_customer_ai_feedback_message ON customer_ai_feedback(message_id);
