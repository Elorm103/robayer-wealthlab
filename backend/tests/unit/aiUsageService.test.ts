/**
 * Unit tests: AI Usage Log service — Version 5.0 Milestone 1.1.
 * Seeds ai_usage_log rows directly (this service only reads that
 * table; services/ai/aiGateway.ts's own tests already cover writing
 * it) and exercises listAiUsage's filters/pagination, the
 * prompt/response exclusion contract between list and detail, CSV
 * export shape, and getAiUsageAnalytics' grouping math.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { listAiUsage, getAiUsageDetail, exportAiUsageCsv, getAiUsageAnalytics, getAiGovernanceSummary } from '../../services/admin/aiUsageService';
import { encryptText } from '../../services/ai/promptEncryption';

let adminId: number;

async function seedRow(overrides: Partial<{
  feature: string;
  provider: string;
  model: string;
  succeeded: number;
  costUsdMicros: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  errorMessage: string | null;
  createdAt: string;
  promptText: string | null;
  responseText: string | null;
  classification: string;
  maskingApplied: number;
  providerDecision: string | null;
  budgetDecision: string | null;
  cleanupEligibleDate: string | null;
  purgedAt: string | null;
}> = {}): Promise<number> {
  const row = {
    feature: 'internal.gateway-diagnostic',
    provider: 'openai',
    model: 'gpt-4o-mini',
    succeeded: 1,
    costUsdMicros: 100,
    tokensIn: 10,
    tokensOut: 2,
    latencyMs: 250,
    errorMessage: null as string | null,
    createdAt: null as string | null,
    promptText: 'system prompt text',
    responseText: 'OK',
    classification: 'INTERNAL',
    maskingApplied: 0,
    providerDecision: null as string | null,
    budgetDecision: null as string | null,
    cleanupEligibleDate: null as string | null,
    purgedAt: null as string | null,
    ...overrides,
  };

  const insert = await env.DB.prepare(
    `INSERT INTO ai_usage_log (
       feature, provider, model, actor_type, actor_id, session_id, sensitivity_classification, prompt_key, prompt_version,
       prompt_text, response_text, tokens_in, tokens_out, cost_usd_micros, latency_ms, fallback_used, succeeded, error_message,
       created_at, masking_applied, provider_decision, budget_decision, cleanup_eligible_date, purged_at
     ) VALUES (?, ?, ?, 'admin', ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?)`
  )
    .bind(
      row.feature,
      row.provider,
      row.model,
      adminId,
      row.classification,
      row.promptText,
      row.responseText,
      row.tokensIn,
      row.tokensOut,
      row.costUsdMicros,
      row.latencyMs,
      row.succeeded,
      row.errorMessage,
      row.createdAt,
      row.maskingApplied,
      row.providerDecision,
      row.budgetDecision,
      row.cleanupEligibleDate,
      row.purgedAt
    )
    .run();
  return Number(insert.meta.last_row_id);
}

describe('aiUsageService', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM ai_usage_log');
    await env.DB.exec('DELETE FROM admin_users');
    const adminInsert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES ('ai-usage-test-admin@example.com', 'x:1:x', 'super_admin', 1)`).run();
    adminId = Number(adminInsert.meta.last_row_id);
  });

  it('lists rows newest-first, without prompt/response text', async () => {
    await seedRow({ feature: 'a' });
    await seedRow({ feature: 'b' });

    const result = await listAiUsage(env as any, {}, 1, 25);
    expect(result.total).toBe(2);
    expect(result.items[0].feature).toBe('b');
    expect(result.items[1].feature).toBe('a');
    expect((result.items[0] as any).promptText).toBeUndefined();
    expect((result.items[0] as any).responseText).toBeUndefined();
    expect(result.items[0].actorLabel).toBe('ai-usage-test-admin@example.com');
    expect(result.items[0].totalTokens).toBe(12);
  });

  it('paginates correctly', async () => {
    for (let i = 0; i < 5; i++) await seedRow({ feature: `feature-${i}` });

    const page1 = await listAiUsage(env as any, {}, 1, 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = await listAiUsage(env as any, {}, 2, 2);
    expect(page2.items).toHaveLength(2);
    expect(page1.items[0].id).not.toBe(page2.items[0].id);
  });

  it('filters by status, feature, provider, and search', async () => {
    await seedRow({ feature: 'feature-a', provider: 'openai', succeeded: 1 });
    await seedRow({ feature: 'feature-b', provider: 'openai', succeeded: 0, errorMessage: 'rate limit exceeded' });

    const failedOnly = await listAiUsage(env as any, { status: 'failed' }, 1, 25);
    expect(failedOnly.total).toBe(1);
    expect(failedOnly.items[0].feature).toBe('feature-b');

    const byFeature = await listAiUsage(env as any, { feature: 'feature-a' }, 1, 25);
    expect(byFeature.total).toBe(1);

    const bySearch = await listAiUsage(env as any, { search: 'rate limit' }, 1, 25);
    expect(bySearch.total).toBe(1);
    expect(bySearch.items[0].feature).toBe('feature-b');
  });

  it('filters by date range (inclusive of dateTo)', async () => {
    await seedRow({ createdAt: '2026-01-01 10:00:00' });
    await seedRow({ createdAt: '2026-01-15 10:00:00' });
    await seedRow({ createdAt: '2026-02-01 10:00:00' });

    const result = await listAiUsage(env as any, { dateFrom: '2026-01-01', dateTo: '2026-01-31' }, 1, 25);
    expect(result.total).toBe(2);
  });

  it('getAiUsageDetail returns prompt/response text; returns null for a missing id', async () => {
    const id = await seedRow({ promptText: 'the real prompt', responseText: 'the real response' });

    const detail = await getAiUsageDetail(env as any, id);
    expect(detail).toBeTruthy();
    expect(detail!.promptText).toBe('the real prompt');
    expect(detail!.responseText).toBe('the real response');

    const missing = await getAiUsageDetail(env as any, 999999);
    expect(missing).toBeNull();
  });

  it('exportAiUsageCsv produces a header row and one data row per match, excluding prompt/response text', async () => {
    await seedRow({ feature: 'csv-test', promptText: 'secret prompt', responseText: 'secret response' });

    const csv = await exportAiUsageCsv(env as any, { feature: 'csv-test' });
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('feature');
    expect(lines[1]).toContain('csv-test');
    expect(csv).not.toContain('secret prompt');
    expect(csv).not.toContain('secret response');
  });

  it('getAiUsageAnalytics groups calls/cost/tokens/latency/success-rate by day and by feature/provider', async () => {
    await seedRow({ feature: 'f1', provider: 'openai', succeeded: 1, costUsdMicros: 100, tokensIn: 10, tokensOut: 5, latencyMs: 200 });
    await seedRow({ feature: 'f1', provider: 'openai', succeeded: 0, costUsdMicros: 0, tokensIn: 8, tokensOut: 0, latencyMs: 400 });
    await seedRow({ feature: 'f2', provider: 'openai', succeeded: 1, costUsdMicros: 50, tokensIn: 5, tokensOut: 2, latencyMs: 100 });

    const analytics = await getAiUsageAnalytics(env as any, 30);
    expect(analytics.callsPerDay).toHaveLength(1);
    expect(analytics.callsPerDay[0].count).toBe(3);
    expect(analytics.costPerDayUsdMicros[0].count).toBe(150);
    expect(analytics.tokensPerDay[0].count).toBe(30);
    expect(analytics.successRatePerDayPercent[0].count).toBeCloseTo(66.7, 0);

    const f1 = analytics.callsPerFeature.find((f) => f.label === 'f1');
    const f2 = analytics.callsPerFeature.find((f) => f.label === 'f2');
    expect(f1?.value).toBe(2);
    expect(f2?.value).toBe(1);

    const openai = analytics.callsPerProvider.find((p) => p.label === 'openai');
    expect(openai?.value).toBe(3);
  });

  it('filters by sensitivity classification', async () => {
    await seedRow({ feature: 'a', classification: 'PUBLIC' });
    await seedRow({ feature: 'b', classification: 'HIGHLY_SENSITIVE' });

    const result = await listAiUsage(env as any, { classification: 'HIGHLY_SENSITIVE' }, 1, 25);
    expect(result.total).toBe(1);
    expect(result.items[0].feature).toBe('b');
    expect(result.items[0].sensitivityClassification).toBe('HIGHLY_SENSITIVE');
  });

  it('getAiUsageDetail transparently decrypts a value stored by promptEncryption.ts, and passes legacy plaintext through unchanged', async () => {
    const rawKey = new Uint8Array(32);
    crypto.getRandomValues(rawKey);
    let binary = '';
    for (const b of rawKey) binary += String.fromCharCode(b);
    const base64Key = btoa(binary);
    const envWithKey = { ...(env as any), AI_PROMPT_ENCRYPTION_KEY: base64Key };

    const encryptedPrompt = await encryptText(envWithKey, 'the real, encrypted prompt');
    const id = await seedRow({ promptText: encryptedPrompt, responseText: 'plain legacy response' });

    const detail = await getAiUsageDetail(envWithKey, id);
    expect(detail!.promptText).toBe('the real, encrypted prompt');
    expect(detail!.responseText).toBe('plain legacy response'); // never encrypted — passed through as-is
  });

  it('getAiGovernanceSummary aggregates classification/provider distribution, sensitive/masked counts, budget blocks, policy violations, and stored-prompt range', async () => {
    await seedRow({ classification: 'FINANCIAL', provider: 'openai', maskingApplied: 1, promptText: 'masked-and-stored', budgetDecision: 'approved: within budget' });
    await seedRow({ classification: 'PUBLIC', provider: 'openai', maskingApplied: 1, promptText: null, responseText: null, budgetDecision: 'approved: within budget' });
    await seedRow({ classification: 'PUBLIC', provider: 'openai', budgetDecision: 'rejected: daily budget would be exceeded', providerDecision: 'approved' });
    await seedRow({ classification: 'PUBLIC', provider: 'openai', budgetDecision: 'not evaluated', providerDecision: 'rejected: provider not approved for classification' });

    const summary = await getAiGovernanceSummary(env as any);
    const financial = summary.classificationDistribution30d.find((c) => c.label === 'FINANCIAL');
    const publicCount = summary.classificationDistribution30d.find((c) => c.label === 'PUBLIC');
    expect(financial?.value).toBe(1);
    expect(publicCount?.value).toBe(3);

    const openaiDist = summary.providerDistribution30d.find((p) => p.label === 'openai');
    expect(openaiDist?.value).toBe(4);

    expect(summary.sensitivePromptCount30d).toBe(2); // two rows with maskingApplied=1
    expect(summary.maskedPromptCount30d).toBe(1); // only one of those two actually had text stored
    expect(summary.budgetBlocks30d).toBe(1);
    expect(summary.policyViolations30d).toBe(1);
    expect(summary.oldestStoredPromptAt).not.toBeNull();
    expect(summary.newestStoredPromptAt).not.toBeNull();
  });

  it('getAiGovernanceSummary reports retention cleanup status from purged_at', async () => {
    await seedRow({ purgedAt: '2026-01-01 00:00:00' });
    await seedRow({ purgedAt: '2026-01-15 00:00:00' });
    await seedRow({ purgedAt: null });

    const summary = await getAiGovernanceSummary(env as any);
    expect(summary.retentionCleanupTotalPurged).toBe(2);
    expect(summary.retentionCleanupLastRunAt).toBe('2026-01-15 00:00:00');
  });
});
