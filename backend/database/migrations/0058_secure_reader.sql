-- ============================================================
-- 0058_secure_reader.sql: Secure Digital Library, Phase 2 (Database).
--
-- Fully additive: one new nullable column on the existing `deliveries`
-- table, plus two new tables. No existing row is modified by this
-- migration, and no existing table's semantics change. The existing
-- `download_tokens` / `deliveries` entitlement model (0004/schema.sql)
-- is untouched - this migration only adds what the new protected
-- reader session/page/chapter pathway needs on top of it.
--
-- owner_watermark_id is nullable and NOT backfilled here: it is
-- generated lazily, once, the first time a given delivery ever opens
-- a secure reader session (see readerSessionService.ts), so an
-- existing purchase that never uses the new reader never needs a
-- write it doesn't benefit from.
-- ============================================================

ALTER TABLE deliveries ADD COLUMN owner_watermark_id TEXT;

-- ============================================================
-- CONTENT_ACCESS_LOG
-- Append-only audit trail for the protected reader. Deliberately
-- separate from `audit_logs` (admin/affiliate actions, generic
-- entity_type/entity_id shape): this is customer-facing content
-- access, a different volume profile and a different, narrower query
-- shape ("show every access for this delivery/customer"), so a
-- purpose-built table is clearer than overloading the generic one.
--
-- customer_id is nullable: a reference-scoped download (an existing,
-- unchanged, pre-secure-reader path - see routes/downloads.ts) can be
-- redeemed by a guest who never logged in, exactly as it always could;
-- logging that access must not require an identity that genuinely
-- doesn't exist for that request. Every secure-reader row (session
-- start, page/chapter render) always has one, since Phase 3 requires
-- authenticated customer for reader-session creation.
--
-- No ebook content is ever logged here - metadata is a small JSON
-- object (page number, chapter reference, purpose), never a rendered
-- page's own text/bytes.
-- ============================================================
CREATE TABLE content_access_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id  INTEGER NOT NULL REFERENCES deliveries(id),
  customer_id  INTEGER REFERENCES customers(id),
  action       TEXT NOT NULL CHECK (action IN ('view_session_started', 'page_rendered', 'chapter_rendered', 'download')),
  ip           TEXT,
  user_agent   TEXT,
  metadata     TEXT, -- small JSON object, e.g. {"pageNumber":12} or {"chapterRef":"OEBPS/ch3.xhtml"} - never rendered content
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  data_classification TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'))
);

CREATE INDEX idx_content_access_log_delivery ON content_access_log(delivery_id);
CREATE INDEX idx_content_access_log_customer ON content_access_log(customer_id);
CREATE INDEX idx_content_access_log_created_at ON content_access_log(created_at);

-- ============================================================
-- READER_SESSIONS
-- Short-lived, revocable, per-delivery session that scopes every
-- page/chapter request in the protected reader. Only the SHA-256 hash
-- of the real session token is ever stored (session_token_hash,
-- UNIQUE) - the same "never store the raw single-use secret" discipline
-- download_tokens.token already gets by being freshly generated with
-- Web Crypto and matched by exact string; here the extra hashing step
-- means even a full read of this table (a backup, a misconfigured
-- report) never yields a token an attacker could replay, only its
-- one-way digest.
--
-- device_fingerprint_hash is explicitly a deterrence/concurrency-
-- control signal, never a security boundary on its own - see
-- readerSessionService.ts's own header comment. A session is still
-- fully valid on a fingerprint mismatch; that signal is for future
-- "reading from an unusual device" surfacing, not enforcement, in
-- this phase.
-- ============================================================
CREATE TABLE reader_sessions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id              INTEGER NOT NULL REFERENCES deliveries(id),
  customer_id              INTEGER NOT NULL REFERENCES customers(id),
  session_token_hash       TEXT NOT NULL UNIQUE,
  device_fingerprint_hash  TEXT,
  issued_at                TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at               TEXT NOT NULL,
  revoked_at               TEXT,
  last_seen_at             TEXT,
  data_classification      TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'))
);

CREATE INDEX idx_reader_sessions_delivery ON reader_sessions(delivery_id);
CREATE INDEX idx_reader_sessions_customer ON reader_sessions(customer_id);
CREATE INDEX idx_reader_sessions_expires_at ON reader_sessions(expires_at);
