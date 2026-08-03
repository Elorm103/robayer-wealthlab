-- ============================================================
-- 0034_ai_gateway_hardening.sql — Version 5.0 Milestone 1.1
-- (Operational Hardening), see docs/v5.0-milestone-1.1-engineering-report.md.
--
-- Three additive columns on ai_usage_log:
--
--   session_id: ties a call to the real admin_sessions row that made
--   it (requireAuth's AdminAuthContext.sessionId), so the AI Usage Log
--   can show a genuine "Session ID" column rather than a fabricated
--   one. Nullable — 'system'-actor calls (future scheduled/background
--   AI work) have no admin session at all.
--
--   prompt_text / response_text: the actual rendered prompt sent to
--   the provider and the raw content it returned. Exists ONLY to back
--   the explicit "a Super Admin may optionally expand a row to
--   inspect: Prompt, Response, Metadata" requirement — never returned
--   by the default list endpoint or the CSV export, only by the
--   single-row detail endpoint (routes/admin/aiUsage.ts), which is
--   super_admin-only. This does widen this table's sensitive-data
--   surface (arbitrary user/business text now lives in D1
--   indefinitely) — see the Security Review section of the Milestone
--   1.1 engineering report for the honest tradeoff discussion; no
--   retention/purge policy exists yet.
--
-- Also seeds the first-ever real ai_prompts row: until this
-- migration, every callAi() invocation (the diagnostic test button)
-- passed a raw systemPrompt/userPrompt string directly, never
-- exercising prompt_key/version resolution at all — meaning
-- "Prompt Version" was not a real, measurable fact about this system.
-- Registering the diagnostic prompt as promptKey
-- 'internal.gateway-diagnostic' version 1 (and switching
-- routes/admin/settings.ts's handleAiGatewayTest to pass promptKey
-- instead of raw text) makes prompt versioning genuinely real for the
-- first time, rather than a dashboard field with nothing behind it.
--
-- Rollback:
--   DELETE FROM ai_prompts WHERE prompt_key = 'internal.gateway-diagnostic' AND version = 1;
--   DROP INDEX idx_ai_usage_log_actor;
--   DROP INDEX idx_ai_usage_log_provider;
--   -- SQLite has no DROP COLUMN prior to a recreate-copy-swap; the three
--   -- added columns are additive/nullable and safe to leave in place if
--   -- this migration is never rolled back, but a true rollback would
--   -- recreate ai_usage_log without them, same pattern already used
--   -- elsewhere in this project's migration history for column removal.
-- ============================================================

ALTER TABLE ai_usage_log ADD COLUMN session_id INTEGER REFERENCES admin_sessions(id);
ALTER TABLE ai_usage_log ADD COLUMN prompt_text TEXT;
ALTER TABLE ai_usage_log ADD COLUMN response_text TEXT;

CREATE INDEX idx_ai_usage_log_actor ON ai_usage_log(actor_type, actor_id);
CREATE INDEX idx_ai_usage_log_provider ON ai_usage_log(provider);

INSERT INTO ai_prompts (prompt_key, version, template, created_by)
VALUES ('internal.gateway-diagnostic', 1, 'You are a diagnostic health check. Reply with exactly one word: OK.', NULL);
