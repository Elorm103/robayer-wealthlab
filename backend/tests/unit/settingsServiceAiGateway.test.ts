/**
 * Unit tests: the AI Gateway portion of settingsService — Version 5.0
 * Milestone 1.1. Scoped only to what this milestone added
 * (cost cap/budget validation, getAiGatewayBudgetConfig, and the
 * derived health-status/warnings logic in getSettingsStatus's
 * `aiGateway` field) — the pre-existing settings fields (hero content,
 * maintenance mode, etc.) have no dedicated test file of their own and
 * are out of scope here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { updateSettings, getAiGatewayBudgetConfig, getSettingsStatus } from '../../services/admin/settingsService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');
const CTX = { ip: null, userAgent: null };
const REQUEST = new Request('https://example.com/api/admin/settings/status');

describe('settingsService — AI Gateway budget/cost-cap settings', () => {
  let adminId: number;

  beforeEach(async () => {
    await env.DB.exec(`DELETE FROM site_settings WHERE key LIKE 'ai_gateway_%'`);
    await env.DB.exec('DELETE FROM admin_users');
    const adminInsert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES ('settings-ai-gateway-test-admin@example.com', 'x:1:x', 'super_admin', 1)`).run();
    adminId = Number(adminInsert.meta.last_row_id);
  });

  it('defaults to the $0.001 cost cap and unconfigured budgets when never set', async () => {
    const config = await getAiGatewayBudgetConfig(env as any);
    expect(config.costCapUsdMicros).toBe(1000);
    expect(config.dailyBudgetUsdMicros).toBeNull();
    expect(config.monthlyBudgetUsdMicros).toBeNull();
  });

  it('accepts a valid cost cap and budgets, and persists them', async () => {
    const result = await updateSettings(env as any, logger, adminId, { aiGatewayCostCapUsdMicros: 5000, aiGatewayDailyBudgetUsdMicros: 1_000_000, aiGatewayMonthlyBudgetUsdMicros: 20_000_000 }, CTX);
    expect(result.ok).toBe(true);

    const config = await getAiGatewayBudgetConfig(env as any);
    expect(config.costCapUsdMicros).toBe(5000);
    expect(config.dailyBudgetUsdMicros).toBe(1_000_000);
    expect(config.monthlyBudgetUsdMicros).toBe(20_000_000);
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
});
