/**
 * AI Usage Log — Version 5.0 Milestone 1.1 (Operational Hardening),
 * extended in Milestone 1.2 (AI Governance & Safety). The only code
 * that reads ai_usage_log for the admin-facing "AI Usage" page
 * (routes/admin/aiUsage.ts) and for the Settings page's AI Governance
 * Dashboard section (services/admin/settingsService.ts's
 * getAiGatewayDiagnostics(), via this file's getAiGovernanceSummary()
 * — kept here, not duplicated in settingsService.ts, since this file
 * already owns every other ai_usage_log aggregate query). Every AI
 * call the Gateway ever makes (services/ai/aiGateway.ts's logUsage())
 * already writes a row there; this service only queries it — it
 * writes nothing except, indirectly, via decryption of stored
 * ciphertext for display (never a write back to the row).
 *
 * Prompt/response text is deliberately excluded from every list/export
 * shape below and only ever returned by getAiUsageDetail() — see that
 * function's own comment, and routes/admin/aiUsage.ts's role gating.
 */

import type { Env } from '../../worker/env';
import { decryptText, isEncrypted } from '../ai/promptEncryption';

export interface AiUsageLogItem {
  id: number;
  createdAt: string;
  actorType: 'customer' | 'admin' | 'system';
  actorId: number | null;
  actorLabel: string;
  sessionId: number | null;
  feature: string;
  provider: string;
  model: string;
  /** Version 5.0 Milestone 1.2, Task 3 — PUBLIC/INTERNAL/CONFIDENTIAL/FINANCIAL/PERSONAL/HIGHLY_SENSITIVE. Distinct from `dataClassification` below. */
  sensitivityClassification: string;
  promptKey: string | null;
  promptVersion: number | null;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  costUsdMicros: number;
  latencyMs: number;
  fallbackUsed: boolean;
  succeeded: boolean;
  errorMessage: string | null;
  /** PRODUCTION/INTERNAL/DEVELOPMENT/UNKNOWN — the pre-existing, unrelated Version 4.9 "is this real traffic" convention. See sensitivityClassification above for the Milestone 1.2 data-sensitivity concept. */
  dataClassification: string;
  gatewayVersion: string | null;
  policyVersion: string | null;
  providerDecision: string | null;
  budgetDecision: string | null;
  retentionDecision: string | null;
  maskingApplied: boolean;
  cleanupEligibleDate: string | null;
  purgedAt: string | null;
}

export interface AiUsageLogDetail extends AiUsageLogItem {
  promptText: string | null;
  responseText: string | null;
}

export interface AiUsageFilters {
  search?: string;
  dateFrom?: string; // 'YYYY-MM-DD', inclusive
  dateTo?: string; // 'YYYY-MM-DD', inclusive
  feature?: string;
  provider?: string;
  status?: 'succeeded' | 'failed';
  classification?: string;
}

interface AiUsageRow {
  id: number;
  created_at: string;
  actor_type: 'customer' | 'admin' | 'system';
  actor_id: number | null;
  admin_email: string | null;
  session_id: number | null;
  feature: string;
  provider: string;
  model: string;
  sensitivity_classification: string;
  prompt_key: string | null;
  prompt_version: number | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd_micros: number;
  latency_ms: number;
  fallback_used: number;
  succeeded: number;
  error_message: string | null;
  data_classification: string;
  gateway_version: string | null;
  policy_version: string | null;
  provider_decision: string | null;
  budget_decision: string | null;
  retention_decision: string | null;
  masking_applied: number;
  cleanup_eligible_date: string | null;
  purged_at: string | null;
}

function actorLabel(row: Pick<AiUsageRow, 'actor_type' | 'actor_id' | 'admin_email'>): string {
  if (row.actor_type === 'admin') return row.admin_email ?? `Admin #${row.actor_id ?? '?'} (deleted)`;
  if (row.actor_type === 'customer') return `Customer #${row.actor_id ?? '?'}`;
  return 'System';
}

function mapRow(row: AiUsageRow): AiUsageLogItem {
  return {
    id: row.id,
    createdAt: row.created_at,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorLabel: actorLabel(row),
    sessionId: row.session_id,
    feature: row.feature,
    provider: row.provider,
    model: row.model,
    sensitivityClassification: row.sensitivity_classification,
    promptKey: row.prompt_key,
    promptVersion: row.prompt_version,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    totalTokens: row.tokens_in + row.tokens_out,
    costUsdMicros: row.cost_usd_micros,
    latencyMs: row.latency_ms,
    fallbackUsed: row.fallback_used === 1,
    succeeded: row.succeeded === 1,
    errorMessage: row.error_message,
    dataClassification: row.data_classification,
    gatewayVersion: row.gateway_version,
    policyVersion: row.policy_version,
    providerDecision: row.provider_decision,
    budgetDecision: row.budget_decision,
    retentionDecision: row.retention_decision,
    maskingApplied: row.masking_applied === 1,
    cleanupEligibleDate: row.cleanup_eligible_date,
    purgedAt: row.purged_at,
  };
}

const LIST_COLUMNS = `
  l.id, l.created_at, l.actor_type, l.actor_id, au.email AS admin_email, l.session_id,
  l.feature, l.provider, l.model, l.sensitivity_classification, l.prompt_key, l.prompt_version,
  l.tokens_in, l.tokens_out, l.cost_usd_micros, l.latency_ms, l.fallback_used, l.succeeded,
  l.error_message, l.data_classification, l.gateway_version, l.policy_version,
  l.provider_decision, l.budget_decision, l.retention_decision, l.masking_applied,
  l.cleanup_eligible_date, l.purged_at
`;

/** Builds a shared WHERE clause + bind params for list/export/analytics — one place filter semantics are defined, so the three never drift apart. */
function buildFilterClause(filters: AiUsageFilters): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.search && filters.search.trim().length > 0) {
    const term = `%${filters.search.trim()}%`;
    clauses.push(`(l.feature LIKE ? OR l.provider LIKE ? OR l.model LIKE ? OR l.error_message LIKE ? OR l.provider_decision LIKE ? OR l.budget_decision LIKE ? OR l.retention_decision LIKE ?)`);
    params.push(term, term, term, term, term, term, term);
  }
  if (filters.dateFrom) {
    clauses.push(`l.created_at >= datetime(?)`);
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    clauses.push(`l.created_at < datetime(?, '+1 day')`);
    params.push(filters.dateTo);
  }
  if (filters.feature) {
    clauses.push(`l.feature = ?`);
    params.push(filters.feature);
  }
  if (filters.provider) {
    clauses.push(`l.provider = ?`);
    params.push(filters.provider);
  }
  if (filters.status === 'succeeded') clauses.push(`l.succeeded = 1`);
  if (filters.status === 'failed') clauses.push(`l.succeeded = 0`);
  if (filters.classification) {
    clauses.push(`l.sensitivity_classification = ?`);
    params.push(filters.classification);
  }

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export async function listAiUsage(
  env: Env,
  filters: AiUsageFilters,
  page: number,
  pageSize: number
): Promise<{ items: AiUsageLogItem[]; total: number; page: number; pageSize: number }> {
  const { where, params } = buildFilterClause(filters);
  const offset = (page - 1) * pageSize;

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(
      `SELECT ${LIST_COLUMNS} FROM ai_usage_log l LEFT JOIN admin_users au ON au.id = l.actor_id AND l.actor_type = 'admin' ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`
    )
      .bind(...params, pageSize, offset)
      .all<AiUsageRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM ai_usage_log l ${where}`)
      .bind(...params)
      .first<{ total: number }>(),
  ]);

  return { items: rows.results.map(mapRow), total: countRow?.total ?? 0, page, pageSize };
}

/**
 * Single-row detail — the ONLY function in this file that returns
 * prompt_text/response_text, and now transparently DECRYPTS them if
 * the stored value carries promptEncryption.ts's `enc:v1:` marker
 * (Version 5.0 Milestone 1.2). A legacy plaintext row (written before
 * Milestone 1.2, or written under a 'never'/'metadata_only' retention
 * policy) passes through unchanged. Decryption failure (key missing,
 * ciphertext corrupted) is NOT swallowed — it propagates to the route
 * handler, which surfaces it as a real error rather than silently
 * showing nothing.
 *
 * routes/admin/aiUsage.ts gates this behind the same super_admin
 * requirement as the rest of the AI Usage page (matching Settings'
 * existing "Payments"/"AI Gateway" diagnostics posture), per the
 * explicit "do not expose prompt contents by default" requirement.
 */
export async function getAiUsageDetail(env: Env, id: number): Promise<AiUsageLogDetail | null> {
  const row = await env.DB.prepare(
    `SELECT ${LIST_COLUMNS}, l.prompt_text, l.response_text FROM ai_usage_log l LEFT JOIN admin_users au ON au.id = l.actor_id AND l.actor_type = 'admin' WHERE l.id = ?`
  )
    .bind(id)
    .first<AiUsageRow & { prompt_text: string | null; response_text: string | null }>();
  if (!row) return null;

  const promptText = row.prompt_text !== null && isEncrypted(row.prompt_text) ? await decryptText(env, row.prompt_text) : row.prompt_text;
  const responseText = row.response_text !== null && isEncrypted(row.response_text) ? await decryptText(env, row.response_text) : row.response_text;

  return { ...mapRow(row), promptText, responseText };
}

function csvEscape(value: string | number | boolean | null): string {
  const str = value === null ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const CSV_HEADER = [
  'id',
  'createdAt',
  'actorType',
  'actorId',
  'actorLabel',
  'sessionId',
  'feature',
  'provider',
  'model',
  'sensitivityClassification',
  'promptKey',
  'promptVersion',
  'tokensIn',
  'tokensOut',
  'totalTokens',
  'costUsdMicros',
  'latencyMs',
  'fallbackUsed',
  'succeeded',
  'errorMessage',
  'dataClassification',
  'gatewayVersion',
  'policyVersion',
  'providerDecision',
  'budgetDecision',
  'retentionDecision',
  'maskingApplied',
  'cleanupEligibleDate',
  'purgedAt',
];

/**
 * Every row matching `filters` (no pagination — the whole filtered
 * set), as CSV text. Deliberately the same columns as the list
 * endpoint and NOT prompt_text/response_text — a bulk export is, if
 * anything, a wider exposure surface than a single expanded row, so it
 * gets the same "no prompt contents by default" treatment, with no
 * "export with prompts" option at all in this milestone.
 */
export async function exportAiUsageCsv(env: Env, filters: AiUsageFilters): Promise<string> {
  const { where, params } = buildFilterClause(filters);
  const rows = await env.DB.prepare(
    `SELECT ${LIST_COLUMNS} FROM ai_usage_log l LEFT JOIN admin_users au ON au.id = l.actor_id AND l.actor_type = 'admin' ${where} ORDER BY l.id DESC`
  )
    .bind(...params)
    .all<AiUsageRow>();

  const lines = [CSV_HEADER.join(',')];
  for (const row of rows.results.map(mapRow)) {
    lines.push(
      CSV_HEADER.map((key) => csvEscape(row[key as keyof AiUsageLogItem] as string | number | boolean | null)).join(',')
    );
  }
  return lines.join('\r\n');
}

export interface AiUsageAnalytics {
  callsPerDay: { date: string; count: number }[];
  costPerDayUsdMicros: { date: string; count: number }[];
  tokensPerDay: { date: string; count: number }[];
  avgLatencyPerDayMs: { date: string; count: number }[];
  successRatePerDayPercent: { date: string; count: number }[];
  callsPerFeature: { label: string; value: number }[];
  callsPerProvider: { label: string; value: number }[];
}

/**
 * Chart-ready aggregates over a rolling window (default 30 days) —
 * shaped to drop straight into window.AdminCharts.renderTimeseries()
 * ({date, count}) and .renderBarChart() ({label, value}), the same
 * dependency-free chart component every other admin analytics view
 * already uses. No new charting mechanism, per the engineering rules'
 * "reuse existing services wherever possible."
 */
export async function getAiUsageAnalytics(env: Env, days = 30): Promise<AiUsageAnalytics> {
  const window = `-${Math.max(1, Math.min(365, Math.trunc(days)))} days`;

  const [perDay, perFeature, perProvider] = await Promise.all([
    env.DB.prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS calls, COALESCE(SUM(cost_usd_micros), 0) AS cost,
              COALESCE(SUM(tokens_in), 0) + COALESCE(SUM(tokens_out), 0) AS tokens,
              AVG(latency_ms) AS avgLatency, COALESCE(SUM(succeeded), 0) AS successes
       FROM ai_usage_log WHERE created_at > datetime('now', ?) GROUP BY day ORDER BY day ASC`
    )
      .bind(window)
      .all<{ day: string; calls: number; cost: number; tokens: number; avgLatency: number | null; successes: number }>(),
    env.DB.prepare(`SELECT feature, COUNT(*) AS calls FROM ai_usage_log WHERE created_at > datetime('now', ?) GROUP BY feature ORDER BY calls DESC`)
      .bind(window)
      .all<{ feature: string; calls: number }>(),
    env.DB.prepare(`SELECT provider, COUNT(*) AS calls FROM ai_usage_log WHERE created_at > datetime('now', ?) GROUP BY provider ORDER BY calls DESC`)
      .bind(window)
      .all<{ provider: string; calls: number }>(),
  ]);

  return {
    callsPerDay: perDay.results.map((r) => ({ date: r.day, count: r.calls })),
    costPerDayUsdMicros: perDay.results.map((r) => ({ date: r.day, count: r.cost })),
    tokensPerDay: perDay.results.map((r) => ({ date: r.day, count: r.tokens })),
    avgLatencyPerDayMs: perDay.results.map((r) => ({ date: r.day, count: r.avgLatency != null ? Math.round(r.avgLatency) : 0 })),
    successRatePerDayPercent: perDay.results.map((r) => ({ date: r.day, count: r.calls > 0 ? Math.round((r.successes / r.calls) * 1000) / 10 : 0 })),
    callsPerFeature: perFeature.results.map((r) => ({ label: r.feature, value: r.calls })),
    callsPerProvider: perProvider.results.map((r) => ({ label: r.provider, value: r.calls })),
  };
}

export interface AiGovernanceSummary {
  classificationDistribution30d: { label: string; value: number }[];
  providerDistribution30d: { label: string; value: number }[];
  /** COUNT of calls where masking detected a recognizable secret pattern in the prompt/response, regardless of whether that text was actually stored. */
  sensitivePromptCount30d: number;
  /** Of those, COUNT where the (masked, redacted) text was actually persisted — i.e. the retention policy was something other than 'never'/'metadata_only'. Always <= sensitivePromptCount30d. */
  maskedPromptCount30d: number;
  /** Calls preventively refused for a budget reason (Task 1) — provider never contacted. */
  budgetBlocks30d: number;
  /** Calls preventively refused for a provider-policy reason (Task 4) — provider never contacted. */
  policyViolations30d: number;
  retentionCleanupLastRunAt: string | null;
  retentionCleanupTotalPurged: number;
  oldestStoredPromptAt: string | null;
  newestStoredPromptAt: string | null;
}

/**
 * Version 5.0 Milestone 1.2 (AI Governance & Safety), Task 7 — backs
 * the Settings page's AI Governance Dashboard section. Lives here
 * rather than in settingsService.ts because this file already owns
 * every other ai_usage_log aggregate query (Milestone 1.1's
 * getAiUsageAnalytics() above) — one place for "how do we summarize
 * this table," not two independent copies.
 */
export async function getAiGovernanceSummary(env: Env): Promise<AiGovernanceSummary> {
  const window = `-30 days`;

  const [classificationRows, providerRows, sensitiveRow, maskedStoredRow, budgetBlockRow, policyViolationRow, cleanupRow, storedRangeRow] = await Promise.all([
    env.DB.prepare(`SELECT sensitivity_classification AS label, COUNT(*) AS value FROM ai_usage_log WHERE created_at > datetime('now', ?) GROUP BY label ORDER BY value DESC`)
      .bind(window)
      .all<{ label: string; value: number }>(),
    env.DB.prepare(`SELECT provider AS label, COUNT(*) AS value FROM ai_usage_log WHERE created_at > datetime('now', ?) GROUP BY label ORDER BY value DESC`)
      .bind(window)
      .all<{ label: string; value: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM ai_usage_log WHERE created_at > datetime('now', ?) AND masking_applied = 1`).bind(window).first<{ c: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM ai_usage_log WHERE created_at > datetime('now', ?) AND masking_applied = 1 AND (prompt_text IS NOT NULL OR response_text IS NOT NULL)`
    )
      .bind(window)
      .first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM ai_usage_log WHERE created_at > datetime('now', ?) AND budget_decision LIKE 'rejected:%'`).bind(window).first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM ai_usage_log WHERE created_at > datetime('now', ?) AND provider_decision LIKE 'rejected:%'`).bind(window).first<{ c: number }>(),
    env.DB.prepare(`SELECT MAX(purged_at) AS lastRun, COUNT(*) AS total FROM ai_usage_log WHERE purged_at IS NOT NULL`).first<{ lastRun: string | null; total: number }>(),
    env.DB.prepare(`SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM ai_usage_log WHERE prompt_text IS NOT NULL OR response_text IS NOT NULL`).first<{
      oldest: string | null;
      newest: string | null;
    }>(),
  ]);

  return {
    classificationDistribution30d: classificationRows.results,
    providerDistribution30d: providerRows.results,
    sensitivePromptCount30d: sensitiveRow?.c ?? 0,
    maskedPromptCount30d: maskedStoredRow?.c ?? 0,
    budgetBlocks30d: budgetBlockRow?.c ?? 0,
    policyViolations30d: policyViolationRow?.c ?? 0,
    retentionCleanupLastRunAt: cleanupRow?.lastRun ?? null,
    retentionCleanupTotalPurged: cleanupRow?.total ?? 0,
    oldestStoredPromptAt: storedRangeRow?.oldest ?? null,
    newestStoredPromptAt: storedRangeRow?.newest ?? null,
  };
}
