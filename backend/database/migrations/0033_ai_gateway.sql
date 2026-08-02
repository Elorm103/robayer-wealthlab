-- ============================================================
-- 0033_ai_gateway.sql — Version 5.0 Milestone 1 (AI Gateway
-- Foundation), see docs/v5.0-ai-gateway.md.
--
-- ai_prompts: versioned prompt templates, additive-only (a new prompt
-- version is a new row, never an UPDATE to an old one) — same
-- discipline as this project's own migration history itself, applied
-- to prompts so a regression can always be traced to exactly which
-- version was live when it happened. `prompt_key` + `version` is
-- unique; the Gateway resolves the current (highest) version for a
-- key unless a caller explicitly pins one.
--
-- ai_usage_log: one row per callAi() invocation. Carries
-- data_classification from day one (PRODUCTION/INTERNAL/DEVELOPMENT/
-- UNKNOWN, defaulting to PRODUCTION) — not retrofitted later, per the
-- explicit lesson of Version 4.9: every AI usage record is
-- immediately classifiable as real customer usage vs. internal/team
-- testing, so a future "AI cost this month" dashboard figure can
-- default to PRODUCTION-only the same way every other KPI on this
-- platform already does.
--
-- cost_usd_micros (1 micro = $0.000001) is deliberately USD, not GHS
-- pesewas like every other financial column in this schema — OpenAI
-- (and every AI provider) bills in USD, and fabricating a GHS
-- conversion rate this project tracks nowhere else would violate the
-- "never guess" discipline this platform has held since its
-- Version 4.9 classification work. See
-- backend/services/ai/types.ts's AiProvider.estimateCostUsdMicros for
-- the full reasoning.
--
-- Rollback: `DROP TABLE ai_usage_log; DROP TABLE ai_prompts;` — safe,
-- nothing else references these tables by foreign key, and no
-- customer- or admin-facing feature depends on them yet (Milestone 1
-- ships with zero live features calling the Gateway — see
-- docs/v5.0-implementation-roadmap.md's Milestone 1 deployment
-- strategy).
-- ============================================================

CREATE TABLE ai_prompts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_key  TEXT NOT NULL,
  version     INTEGER NOT NULL,
  template    TEXT NOT NULL,
  created_by  INTEGER REFERENCES admin_users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(prompt_key, version)
);

CREATE INDEX idx_ai_prompts_key ON ai_prompts(prompt_key);

CREATE TABLE ai_usage_log (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  feature              TEXT NOT NULL,
  provider             TEXT NOT NULL,
  model                TEXT NOT NULL,
  actor_type           TEXT NOT NULL CHECK (actor_type IN ('customer', 'admin', 'system')),
  actor_id             INTEGER,
  prompt_key           TEXT,
  prompt_version       INTEGER,
  tokens_in            INTEGER NOT NULL,
  tokens_out           INTEGER NOT NULL,
  cost_usd_micros      INTEGER NOT NULL,
  latency_ms           INTEGER NOT NULL,
  fallback_used        INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0, 1)),
  succeeded            INTEGER NOT NULL DEFAULT 1 CHECK (succeeded IN (0, 1)),
  error_message        TEXT,
  data_classification  TEXT NOT NULL DEFAULT 'PRODUCTION' CHECK (data_classification IN ('PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ai_usage_log_feature ON ai_usage_log(feature);
CREATE INDEX idx_ai_usage_log_created_at ON ai_usage_log(created_at);
CREATE INDEX idx_ai_usage_log_classification ON ai_usage_log(data_classification);
