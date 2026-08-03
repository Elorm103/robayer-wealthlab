-- ============================================================
-- 0035_ai_gateway_governance.sql — Version 5.0 Milestone 1.2
-- (AI Governance & Safety), see
-- docs/v5.0-milestone-1.2-engineering-report.md.
--
-- sensitivity_classification: a NEW, SEPARATE axis from the
-- pre-existing `data_classification` column (PRODUCTION/INTERNAL/
-- DEVELOPMENT/UNKNOWN — the Version 4.9 platform-wide "is this real
-- traffic" convention, unchanged, still used exactly as before). This
-- new column answers a completely different question: "what KIND of
-- sensitive data does this specific prompt touch" — PUBLIC/INTERNAL/
-- CONFIDENTIAL/FINANCIAL/PERSONAL/HIGHLY_SENSITIVE. Every row from
-- this point forward MUST declare one (services/ai/aiGateway.ts
-- refuses a call with no classification or an unrecognized one).
-- Historical rows (Milestone 1/1.1, before this column existed) are
-- backfilled to 'INTERNAL' — the only feature that has ever run
-- (internal.gateway-diagnostic) is an internal operational check, not
-- customer or business data.
--
-- gateway_version / policy_version: a fixed version string recorded
-- per call (see aiGateway.ts's GATEWAY_VERSION / providerPolicy.ts's
-- POLICY_VERSION constants) — lets a future audit distinguish "this
-- call ran under governance rules vX" without guessing from
-- created_at.
--
-- provider_decision / budget_decision / retention_decision: short
-- human-readable strings recording WHY the Gateway did what it did
-- for this call (e.g. "openai/gpt-4o-mini: policy-approved for
-- CONFIDENTIAL", "rejected: daily budget would be exceeded
-- ($1.0234 + est. $0.0050 > $1.0000 budget)", "encrypted_both, 90
-- days"). Free text by design — Task 8 asks these to be
-- "searchable," which the existing `search` filter
-- (services/admin/aiUsageService.ts) already covers via LIKE against
-- any text column added to its search clause.
--
-- masking_applied: whether services/ai/sensitiveDataMasking.ts
-- detected and redacted a recognizable secret pattern in this call's
-- prompt or response BEFORE it was (or would have been) stored —
-- computed regardless of the configured retention mode, so "Sensitive
-- Prompt Count" is a real signal even when storage itself is
-- disabled.
--
-- cleanup_eligible_date / purged_at: the retention-policy scheduled
-- cleanup (services/ai/retentionCleanupService.ts) never deletes a
-- usage-log row — deleting it would destroy real cost/audit history,
-- the same reason audit_logs itself has no deleted_at (see migration
-- 0001's own header comment). Instead, once cleanup_eligible_date has
-- passed, the cleanup job NULLs out prompt_text/response_text only
-- and stamps purged_at, leaving every numeric/metadata column intact
-- forever. cleanup_eligible_date is computed and stored at WRITE time
-- (created_at + the retention policy's configured days, AT THAT
-- MOMENT) rather than recomputed later, so a subsequent change to the
-- retention setting never silently rewrites the eligibility of
-- already-written rows.
--
-- Rollback: additive/nullable columns are safe to leave in place;
-- a true rollback would recreate ai_usage_log without them via
-- SQLite's standard recreate-copy-swap pattern (no other table
-- references these columns).
-- ============================================================

ALTER TABLE ai_usage_log ADD COLUMN sensitivity_classification TEXT NOT NULL DEFAULT 'INTERNAL'
  CHECK (sensitivity_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'FINANCIAL', 'PERSONAL', 'HIGHLY_SENSITIVE'));

ALTER TABLE ai_usage_log ADD COLUMN gateway_version TEXT;
ALTER TABLE ai_usage_log ADD COLUMN policy_version TEXT;
ALTER TABLE ai_usage_log ADD COLUMN provider_decision TEXT;
ALTER TABLE ai_usage_log ADD COLUMN budget_decision TEXT;
ALTER TABLE ai_usage_log ADD COLUMN retention_decision TEXT;
ALTER TABLE ai_usage_log ADD COLUMN masking_applied INTEGER NOT NULL DEFAULT 0 CHECK (masking_applied IN (0, 1));
ALTER TABLE ai_usage_log ADD COLUMN cleanup_eligible_date TEXT;
ALTER TABLE ai_usage_log ADD COLUMN purged_at TEXT;

CREATE INDEX idx_ai_usage_log_sensitivity ON ai_usage_log(sensitivity_classification);
CREATE INDEX idx_ai_usage_log_cleanup_eligible ON ai_usage_log(cleanup_eligible_date);
