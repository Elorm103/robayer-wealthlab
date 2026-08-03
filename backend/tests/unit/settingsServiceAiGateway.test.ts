/**
 * Unit tests: the AI Gateway portion of settingsService — Version 5.0
 * Milestone 1.1, extended for Milestone 1.2 (AI Governance & Safety).
 * Scoped only to what these milestones added (cost cap/budget/
 * retention validation, and the derived health-status/warnings/
 * governance-summary logic in getSettingsStatus's `aiGateway` field) —
 * the pre-existing settings fields (hero content, maintenance mode,
 * etc.) have no dedicated test file of their own and are out of scope
 * here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { updateSettings, getSettingsStatus } from '../../services/admin/settingsService';
import { getAiGatewayBudgetConfig } from '../../services/ai/aiGatewayConfig';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');
const CTX = { ip: null, userAgent: null };
const REQUEST = new Request('https://example.com/api/admin/settings/status');

describe('settingsService — AI Gateway budget/retention settings', () => {
  let adminId: number;

  beforeEach(async () => {
    await env.DB.exec(`DELETE FROM site_settings WHERE key LIKE 'ai_gateway_%'`);
    await env.DB.exec('DELETE FROM admin_users');
    const adminInsert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES ('settings-ai-gateway-test-admin@example.com', 'x:1:x', 'super_admin', 1)`).run();
    adminId = Number(adminInsert.meta.last_row_id);
  });

  it('defaults to the platform-configured defaults when never set (Task 2 — mandatory defaults)', async () => {
    const config = await getAiGatewayBudgetConfig(env as any);
    expect(config.perRequestCapUsdMicros).toBe(1000);
    expect(config.dailyBudgetUsdMicros).toBe(1_000_000);
    expect(config.monthlyBudgetUsdMicros).toBe(20_000_000);
    expect(config.platformBudgetUsdMicros).toBe(100_000_000);
    expect(config.defaultProviderBudgetUsdMicros).toBe(50_000_000);
    expect(config.providerBudgetsUsdMicros).toEqual({});
  });

  it('accepts valid cost cap and budgets, and persists them — read back identically via settingsService AND aiGatewayConfig (single source of truth)', async () => {
    const result = await updateSettings(
      env as any,
      logger,
      adminId,
      {
        aiGatewayCostCapUsdMicros: 5000,
        aiGatewayDailyBudgetUsdMicros: 1_500_000,
        aiGatewayMonthlyBudgetUsdMicros: 25_000_000,
        aiGatewayPlatformBudgetUsdMicros: 200_000_000,
        aiGatewayProviderBudgetsUsdMicros: { openai: 60_000_000 },
      },
      CTX
    );
    expect(result.ok).toBe(true);

    const config = await getAiGatewayBudgetConfig(env as any);
    expect(config.perRequestCapUsdMicros).toBe(5000);
    expect(config.dailyBudgetUsdMicros).toBe(1_500_000);
    expect(config.monthlyBudgetUsdMicros).toBe(25_000_000);
    expect(config.platformBudgetUsdMicros).toBe(200_000_000);
    expect(config.providerBudgetsUsdMicros.openai).toBe(60_000_000);

    const editable = await (await import('../../services/admin/settingsService')).getEditableSettings(env as any);
    expect(editable.aiGatewayCostCapUsdMicros.value).toBe(5000);
    expect(editable.aiGatewayPlatformBudgetUsdMicros.value).toBe(200_000_000);
  });

  it('accepts null to clear a configured budget back to unconfigured', async () => {
    await updateSettings(env as any, logger, adminId, { aiGatewayDailyBudgetUsdMicros: 500 }, CTX);
    const result = await updateSettings(env as any, logger, adminId, { aiGatewayDailyBudgetUsdMicros: null }, CTX);
    expect(result.ok).toBe(true);

    const config = await getAiGatewayBudgetConfig(env as any);
    expect(config.dailyBudgetUsdMicros).toBeNull();
  });

  it('rejects a non-integer, zero, or out-of-range cost cap', async () => {
    for (const bad of [0, -5, 1.5, 999_999_999]) {
      const result = await updateSettings(env as any, logger, adminId, { aiGatewayCostCapUsdMicros: bad }, CTX);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0].field).toBe('aiGatewayCostCapUsdMicros');
    }
  });

  it('rejects an out-of-range budget value (but not null)', async () => {
    const result = await updateSettings(env as any, logger, adminId, { aiGatewayMonthlyBudgetUsdMicros: -1 }, CTX);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].field).toBe('aiGatewayMonthlyBudgetUsdMicros');
  });

  it('rejects a malformed provider budgets object', async () => {
    const notAnObject = await updateSettings(env as any, logger, adminId, { aiGatewayProviderBudgetsUsdMicros: 'not-an-object' }, CTX);
    expect(notAnObject.ok).toBe(false);

    const badValue = await updateSettings(env as any, logger, adminId, { aiGatewayProviderBudgetsUsdMicros: { openai: -5 } }, CTX);
    expect(badValue.ok).toBe(false);
  });

  it('accepts a valid retention storage mode and rejects an unrecognized one', async () => {
    const valid = await updateSettings(env as any, logger, adminId, { aiGatewayRetentionStorageMode: 'encrypted_both' }, CTX);
    expect(valid.ok).toBe(true);

    const invalid = await updateSettings(env as any, logger, adminId, { aiGatewayRetentionStorageMode: 'store_everything_forever' }, CTX);
    expect(invalid.ok).toBe(false);
  });

  it('accepts a valid retention period (including null for forever) and rejects an unrecognized one', async () => {
    const ninety = await updateSettings(env as any, logger, adminId, { aiGatewayRetentionDays: 90 }, CTX);
    expect(ninety.ok).toBe(true);

    const forever = await updateSettings(env as any, logger, adminId, { aiGatewayRetentionDays: null }, CTX);
    expect(forever.ok).toBe(true);

    const invalid = await updateSettings(env as any, logger, adminId, { aiGatewayRetentionDays: 45 }, CTX);
    expect(invalid.ok).toBe(false);
  });
});

describe('settingsService — AI Gateway derived health status', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM ai_usage_log');
  });

  it('is offline when the OpenAI API key is not configured', async () => {
    const envWithoutKey = { ...(env as any), OPENAI_API_KEY: undefined };
    const status = await getSettingsStatus(envWithoutKey, REQUEST);
    expect(status.aiGateway.healthStatus.value).toBe('offline');
    expect(status.aiGateway.openAiConfigured.value).toBe(false);
  });

  it('is a warning (no activity yet) when the key is configured but no calls have ever been made', async () => {
    const envWithKey = { ...(env as any), OPENAI_API_KEY: 'sk-test-fake-key' };
    const status = await getSettingsStatus(envWithKey, REQUEST);
    expect(status.aiGateway.healthStatus.value).toBe('warning');
    expect(status.aiGateway.callsTotal.value).toBe(0);
  });

  it('is healthy after a recent successful call with no warnings', async () => {
    await env.DB.prepare(
      `INSERT INTO ai_usage_log (feature, provider, model, actor_type, actor_id, tokens_in, tokens_out, cost_usd_micros, latency_ms, fallback_used, succeeded, error_message)
       VALUES ('internal.gateway-diagnostic', 'openai', 'gpt-4o-mini', 'admin', 1, 10, 2, 100, 250, 0, 1, NULL)`
    ).run();

    const envWithKey = { ...(env as any), OPENAI_API_KEY: 'sk-test-fake-key' };
    const status = await getSettingsStatus(envWithKey, REQUEST);
    expect(status.aiGateway.healthStatus.value).toBe('healthy');
    expect(status.aiGateway.callsTotal.value).toBe(1);
    expect(status.aiGateway.warnings.value).toEqual([]);
  });

  it('is offline after 3 consecutive failed calls, even with the key configured', async () => {
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        `INSERT INTO ai_usage_log (feature, provider, model, actor_type, actor_id, tokens_in, tokens_out, cost_usd_micros, latency_ms, fallback_used, succeeded, error_message)
         VALUES ('internal.gateway-diagnostic', 'openai', 'gpt-4o-mini', 'admin', 1, 0, 0, 0, 100, 0, 0, 'mock failure')`
      ).run();
    }

    const envWithKey = { ...(env as any), OPENAI_API_KEY: 'sk-test-fake-key' };
    const status = await getSettingsStatus(envWithKey, REQUEST);
    expect(status.aiGateway.healthStatus.value).toBe('offline');
    expect(status.aiGateway.consecutiveFailures.value).toBe(3);
  });

  it('includes the internal.gateway-diagnostic feature in the routing snapshot with no fallback configured', async () => {
    const envWithKey = { ...(env as any), OPENAI_API_KEY: 'sk-test-fake-key' };
    const status = await getSettingsStatus(envWithKey, REQUEST);
    const diagnosticRoute = status.aiGateway.routing.value.find((r) => r.feature === 'internal.gateway-diagnostic');
    expect(diagnosticRoute).toBeTruthy();
    expect(diagnosticRoute!.primaryProvider).toBe('openai');
    expect(diagnosticRoute!.primaryModel).toBe('gpt-4o-mini');
    expect(diagnosticRoute!.fallbackProvider).toBeNull();
  });

  it('reports policy/retention status and a healthy budget status with no activity', async () => {
    const envWithKey = { ...(env as any), OPENAI_API_KEY: 'sk-test-fake-key' };
    const status = await getSettingsStatus(envWithKey, REQUEST);
    expect(status.aiGateway.policyStatus.value.classifications).toContain('HIGHLY_SENSITIVE');
    expect(status.aiGateway.policyStatus.value.version).toBeTruthy();
    expect(status.aiGateway.retentionStatus.value.storageMode).toBe('metadata_only');
    expect(status.aiGateway.retentionStatus.value.encryptionAvailable).toBe(false); // OPENAI_API_KEY set above, not AI_PROMPT_ENCRYPTION_KEY
    expect(status.aiGateway.budgetStatus.value).toBe('healthy');
  });

  it('reports budgetStatus "blocking" and a nonzero budgetBlocks30d after a recent preventive budget rejection', async () => {
    await env.DB.prepare(
      `INSERT INTO ai_usage_log (feature, provider, model, actor_type, actor_id, tokens_in, tokens_out, cost_usd_micros, latency_ms, fallback_used, succeeded, error_message, budget_decision)
       VALUES ('internal.gateway-diagnostic', 'openai', 'gpt-4o-mini', 'admin', 1, 0, 0, 0, 0, 0, 0, 'rejected: daily budget would be exceeded', 'rejected: daily budget would be exceeded')`
    ).run();

    const envWithKey = { ...(env as any), OPENAI_API_KEY: 'sk-test-fake-key' };
    const status = await getSettingsStatus(envWithKey, REQUEST);
    expect(status.aiGateway.budgetStatus.value).toBe('blocking');
    expect(status.aiGateway.budgetBlocks30d.value).toBe(1);
    expect(status.aiGateway.warnings.value.some((w) => w.includes('blocked by budget enforcement'))).toBe(true);
  });

  it('counts a masked, undetected-as-stored prompt in sensitivePromptCount30d and reflects the classification distribution', async () => {
    await env.DB.prepare(
      `INSERT INTO ai_usage_log (feature, provider, model, actor_type, actor_id, sensitivity_classification, tokens_in, tokens_out, cost_usd_micros, latency_ms, fallback_used, succeeded, masking_applied)
       VALUES ('internal.gateway-diagnostic', 'openai', 'gpt-4o-mini', 'admin', 1, 'CONFIDENTIAL', 10, 2, 100, 200, 0, 1, 1)`
    ).run();

    const envWithKey = { ...(env as any), OPENAI_API_KEY: 'sk-test-fake-key' };
    const status = await getSettingsStatus(envWithKey, REQUEST);
    expect(status.aiGateway.sensitivePromptCount30d.value).toBe(1);
    const confidential = status.aiGateway.classificationDistribution30d.value.find((c) => c.label === 'CONFIDENTIAL');
    expect(confidential?.value).toBe(1);
  });
});
