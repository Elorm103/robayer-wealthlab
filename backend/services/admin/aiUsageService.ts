/**
 * AI Usage Log — Version 5.0 Milestone 1.1 (Operational Hardening).
 * The only code that reads ai_usage_log for the admin-facing "AI
 * Usage" page (routes/admin/aiUsage.ts). Every AI call the Gateway
 * ever makes (services/ai/aiGateway.ts's logUsage()) already writes a
 * row there; this service only queries it — it writes nothing.
 *
 * Prompt/response text is deliberately excluded from every list/export
 * shape below and only ever returned by getAiUsageDetail() — see that
 * function's own comment, and routes/admin/aiUsage.ts's role gating.
 */

import type { Env } from '../../worker/env';

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
  dataClassification: string;
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
  };
}

const LIST_COLUMNS = `
  l.id, l.created_at, l.actor_type, l.actor_id, au.email AS admin_email, l.session_id,
  l.feature, l.provider, l.model, l.prompt_key, l.prompt_version,
  l.tokens_in, l.tokens_out, l.cost_usd_micros, l.latency_ms, l.fallback_used, l.succeeded,
  l.error_message, l.data_classification
`;

/** Builds a shared WHERE clause + bind params for list/export/analytics — one place filter semantics are defined, so the three never drift apart. */
function buildFilterClause(filters: AiUsageFilters): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.search && filters.search.trim().length > 0) {
    const term = `%${filters.search.trim()}%`;
    clauses.push(`(l.feature LIKE ? OR l.provider LIKE ? OR l.model LIKE ? OR l.error_message LIKE ?)`);
    params.push(term, term, term, term);
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
 * prompt_text/response_text. routes/admin/aiUsage.ts gates this behind
 * the same super_admin requirement as the rest of the AI Usage page
 * (matching Settings' existing "Payments"/"AI Gateway" diagnostics
 * posture), per the explicit "do not expose prompt contents by
 * default" requirement.
 */
export async function getAiUsageDetail(env: Env, id: number): Promise<AiUsageLogDetail | null> {
  const row = await env.DB.prepare(
    `SELECT ${LIST_COLUMNS}, l.prompt_text, l.response_text FROM ai_usage_log l LEFT JOIN admin_users au ON au.id = l.actor_id AND l.actor_type = 'admin' WHERE l.id = ?`
  )
    .bind(id)
    .first<AiUsageRow & { prompt_text: string | null; response_text: string | null }>();
  if (!row) return null;
  return { ...mapRow(row), promptText: row.prompt_text, responseText: row.response_text };
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
