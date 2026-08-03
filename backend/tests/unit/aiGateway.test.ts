/**
 * Unit tests: AI Gateway — Version 5.0 Milestone 1 (foundation),
 * extended for Milestone 1.2 (AI Governance & Safety). Uses the mocked
 * OpenAI provider (tests/outboundMock.ts) — zero real API spend.
 *
 * Milestone 1 ships with exactly one routing candidate
 * (services/ai/routingConfig.ts: 'internal.gateway-diagnostic' →
 * openai/gpt-4o-mini only), so a genuine cross-provider fallback
 * cannot be exercised yet. Milestone 1.2 adds coverage for: preventive
 * (pre-call) budget rejection, the post-call safety-net rejection,
 * mandatory classification validation, default-budget inheritance,
 * masking detection, and the new audit columns.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { callAi, AiClassificationError, AiBudgetExceededError, GATEWAY_VERSION } from '../../services/ai/aiGateway';
import { POLICY_VERSION } from '../../services/ai/providerPolicy';
import { createLogger } from '../../utils/logger';
import { queueOpenAiResponse } from '../outboundMock';

const logger = createLogger('test-request-id', 'test');

async function clearAiGatewaySettings(): Promise<void> {
  await env.DB.exec(`DELETE FROM site_settings WHERE key LIKE 'ai_gateway_%'`);
}

describe('aiGateway.callAi', () => {
  let adminId: number;
  let sessionId: number;

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM ai_usage_log');
    await env.DB.exec('DELETE FROM admin_sessions');
    await env.DB.exec('DELETE FROM admin_users');
    await clearAiGatewaySettings();

    const adminInsert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES ('ai-gateway-test-admin@example.com', 'x:1:x', 'super_admin', 1)`).run();
    adminId = Number(adminInsert.meta.last_row_id);
    const sessionInsert = await env.DB.prepare(
      `INSERT INTO admin_sessions (token, admin_id, csrf_secret, expires_at) VALUES ('test-token', ?, 'test-csrf-secret', datetime('now', '+1 hour'))`
    )
      .bind(adminId)
      .run();
    sessionId = Number(sessionInsert.meta.last_row_id);
  });

  it('completes successfully and logs a succeeded usage row with the full governance audit trail', async () => {
    const result = await callAi(env as any, logger, {
      feature: 'internal.gateway-diagnostic',
      actorType: 'admin',
      actorId: adminId,
      sessionId,
      classification: 'INTERNAL',
      systemPrompt: 'You are a diagnostic health check. Reply with exactly one word: OK.',
      userPrompt: 'Respond now.',
    });

    expect(result.content).toBe('OK');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.classification).toBe('INTERNAL');
    expect(result.fallbackUsed).toBe(false);
    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(2);
    expect(result.costUsdMicros).toBeGreaterThan(0);

    const row = await env.DB.prepare('SELECT * FROM ai_usage_log WHERE feature = ?')
      .bind('internal.gateway-diagnostic')
      .first<{
        succeeded: number;
        provider: string;
        model: string;
        actor_type: string;
        actor_id: number;
        session_id: number;
        sensitivity_classification: string;
        data_classification: string;
        prompt_text: string;
        response_text: string;
        gateway_version: string;
        policy_version: string;
        provider_decision: string;
        budget_decision: string;
        retention_decision: string;
        masking_applied: number;
        cleanup_eligible_date: string | null;
      }>();
    expect(row).toBeTruthy();
    expect(row!.succeeded).toBe(1);
    expect(row!.provider).toBe('openai');
    expect(row!.model).toBe('gpt-4o-mini');
    expect(row!.actor_type).toBe('admin');
    expect(row!.actor_id).toBe(adminId);
    expect(row!.session_id).toBe(sessionId);
    expect(row!.sensitivity_classification).toBe('INTERNAL');
    expect(row!.data_classification).toBe('PRODUCTION');
    // Default retention mode is 'metadata_only' (services/ai/aiGatewayConfig.ts) —
    // prompt/response text is never stored unless an admin opts into a
    // storage mode. See the dedicated 'encrypted_both' test below for
    // the storage path itself.
    expect(row!.prompt_text).toBeNull();
    expect(row!.response_text).toBeNull();
    expect(row!.gateway_version).toBe(GATEWAY_VERSION);
    expect(row!.policy_version).toBe(POLICY_VERSION);
    expect(row!.provider_decision).toMatch(/policy-approved and used/);
    expect(row!.budget_decision).toMatch(/approved/);
    expect(row!.retention_decision).toBe('metadata_only'); // default retention mode — see aiGatewayConfig.ts
    expect(row!.masking_applied).toBe(0); // nothing sensitive in this prompt
    expect(row!.cleanup_eligible_date).toBeNull(); // metadata_only never stores text, so nothing to ever clean up
  });

  it('resolves a stored prompt by promptKey/version and logs the resolved template as prompt_text', async () => {
    // Seeded by database/migrations/0034_ai_gateway_hardening.sql —
    // the first-ever real (non-raw-text) prompt this Gateway resolves.
    const result = await callAi(env as any, logger, {
      feature: 'internal.gateway-diagnostic',
      actorType: 'admin',
      actorId: adminId,
      classification: 'INTERNAL',
      promptKey: 'internal.gateway-diagnostic',
      userPrompt: 'Respond now.',
    });

    expect(result.promptVersion).toBe(1);

    const row = await env.DB.prepare('SELECT prompt_key, prompt_version FROM ai_usage_log WHERE feature = ?')
      .bind('internal.gateway-diagnostic')
      .first<{ prompt_key: string; prompt_version: number }>();
    expect(row!.prompt_key).toBe('internal.gateway-diagnostic');
    expect(row!.prompt_version).toBe(1);
  });

  it('stores the masked prompt/response, AES-GCM encrypted, when retention mode is encrypted_both and the encryption key is configured', async () => {
    // A real 32-byte key generated at test time via Web Crypto, same
    // mechanism promptEncryption.ts itself uses — never a hardcoded
    // secret in test source.
    const rawKey = new Uint8Array(32);
    crypto.getRandomValues(rawKey);
    let binary = '';
    for (const b of rawKey) binary += String.fromCharCode(b);
    const base64Key = btoa(binary);
    const envWithKey = { ...(env as any), AI_PROMPT_ENCRYPTION_KEY: base64Key };

    await env.DB.prepare(`INSERT INTO site_settings (key, value) VALUES ('ai_gateway_retention_storage_mode', '"encrypted_both"')`).run();
    await env.DB.prepare(`INSERT INTO site_settings (key, value) VALUES ('ai_gateway_retention_days', '30')`).run();

    const result = await callAi(envWithKey, logger, {
      feature: 'internal.gateway-diagnostic',
      actorType: 'admin',
      actorId: adminId,
      classification: 'INTERNAL',
      systemPrompt: 'You are a diagnostic health check. Reply with exactly one word: OK.',
      userPrompt: 'Respond now.',
    });
    expect(result.content).toBe('OK');

    const row = await env.DB.prepare('SELECT prompt_text, response_text, retention_decision, cleanup_eligible_date FROM ai_usage_log WHERE feature = ?')
      .bind('internal.gateway-diagnostic')
      .first<{ prompt_text: string; response_text: string; retention_decision: string; cleanup_eligible_date: string | null }>();
    expect(row!.prompt_text).toMatch(/^enc:v1:/);
    expect(row!.response_text).toMatch(/^enc:v1:/);
    expect(row!.prompt_text).not.toContain('diagnostic health check'); // genuinely not plaintext
    expect(row!.retention_decision).toMatch(/encrypted_both, 30 days/);
    expect(row!.cleanup_eligible_date).not.toBeNull();

    // And it decrypts back to the original (masked) text via the same module.
    const { decryptText } = await import('../../services/ai/promptEncryption');
    const decryptedPrompt = await decryptText(envWithKey, row!.prompt_text);
    expect(decryptedPrompt).toContain('diagnostic health check');
    const decryptedResponse = await decryptText(envWithKey, row!.response_text);
    expect(decryptedResponse).toBe('OK');
  });

  it('falls back to metadata_only (never plaintext) when an encrypted mode is configured but the encryption key is missing', async () => {
    await env.DB.prepare(`INSERT INTO site_settings (key, value) VALUES ('ai_gateway_retention_storage_mode', '"encrypted_both"')`).run();

    const result = await callAi(env as any, logger, {
      feature: 'internal.gateway-diagnostic',
      actorType: 'admin',
      actorId: adminId,
      classification: 'INTERNAL',
      userPrompt: 'Respond now.',
    });
    expect(result.content).toBe('OK');

    const row = await env.DB.prepare('SELECT prompt_text, response_text, retention_decision FROM ai_usage_log WHERE feature = ?')
      .bind('internal.gateway-diagnostic')
      .first<{ prompt_text: string | null; response_text: string | null; retention_decision: string }>();
    expect(row!.prompt_text).toBeNull();
    expect(row!.response_text).toBeNull();
    expect(row!.retention_decision).toMatch(/AI_PROMPT_ENCRYPTION_KEY is not configured/);
  });

  it('throws AiClassificationError immediately for a missing/unrecognized classification, with no usage row written', async () => {
    await expect(
      callAi(env as any, logger, {
        feature: 'internal.gateway-diagnostic',
        actorType: 'admin',
        actorId: adminId,
        classification: 'NOT_A_REAL_CLASSIFICATION' as any,
        userPrompt: 'Respond now.',
      })
    ).rejects.toThrow(AiClassificationError);

    const row = await env.DB.prepare('SELECT * FROM ai_usage_log WHERE feature = ?').bind('internal.gateway-diagnostic').first();
    expect(row).toBeNull();
  });

  it('throws and logs a failed usage row when the provider returns an error', async () => {
    await queueOpenAiResponse(env as any, { status: 500, body: { error: { message: 'mock upstream failure' } } });

    await expect(
      callAi(env as any, logger, {
        feature: 'internal.gateway-diagnostic',
        actorType: 'admin',
        actorId: adminId,
        classification: 'INTERNAL',
        userPrompt: 'Respond now.',
      })
    ).rejects.toThrow(/mock upstream failure/);

    const row = await env.DB.prepare('SELECT succeeded, error_message FROM ai_usage_log WHERE feature = ?')
      .bind('internal.gateway-diagnostic')
      .first<{ succeeded: number; error_message: string | null }>();
    expect(row).toBeTruthy();
    expect(row!.succeeded).toBe(0);
    expect(row!.error_message).toMatch(/mock upstream failure/);
  });

  it('preventively refuses an over-cap call BEFORE contacting the provider — zero real spend, provider never called', async () => {
    // The queued response is deliberately never consumed — a low
    // per-request cap (1 micro) is rejected purely from the pre-call
    // estimate, so this mock response is proof the provider was never
    // actually reached (if it had been, tokensIn/tokensOut/cost below
    // would reflect this queued 1,000,000-completion-token response,
    // not zero).
    await queueOpenAiResponse(env as any, {
      status: 200,
      body: { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 10, completion_tokens: 1_000_000 }, model: 'gpt-4o-mini' },
    });

    await expect(
      callAi(env as any, logger, {
        feature: 'internal.gateway-diagnostic',
        actorType: 'admin',
        actorId: adminId,
        classification: 'INTERNAL',
        userPrompt: 'Respond now.',
        maxCostUsdMicros: 1,
      })
    ).rejects.toThrow(AiBudgetExceededError);

    const row = await env.DB.prepare('SELECT succeeded, error_message, tokens_in, tokens_out, cost_usd_micros, provider_decision, budget_decision FROM ai_usage_log WHERE feature = ?')
      .bind('internal.gateway-diagnostic')
      .first<{ succeeded: number; error_message: string | null; tokens_in: number; tokens_out: number; cost_usd_micros: number; provider_decision: string; budget_decision: string }>();
    expect(row).toBeTruthy();
    expect(row!.succeeded).toBe(0);
    expect(row!.tokens_in).toBe(0);
    expect(row!.tokens_out).toBe(0);
    expect(row!.cost_usd_micros).toBe(0); // no real call happened, so no real cost
    expect(row!.error_message).toMatch(/per-request cap/);
    expect(row!.provider_decision).toMatch(/not attempted/);
    expect(row!.budget_decision).toMatch(/rejected/);
  });

  it('post-call safety net catches a real cost that the pre-call estimate under-predicted', async () => {
    // A short prompt makes the pre-call estimate small enough to pass
    // the default $0.001 cap, but the mocked provider reports far more
    // tokens than the chars/4 heuristic could have predicted from that
    // short prompt — simulating the one case the preventive check
    // cannot fully rule out (see aiGateway.ts's own header comment on
    // this being a heuristic, not a guarantee).
    await queueOpenAiResponse(env as any, {
      status: 200,
      body: { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 100_000, completion_tokens: 100_000 }, model: 'gpt-4o-mini' },
    });

    await expect(
      callAi(env as any, logger, {
        feature: 'internal.gateway-diagnostic',
        actorType: 'admin',
        actorId: adminId,
        classification: 'INTERNAL',
        userPrompt: 'Respond now.',
        // Default $0.001 cap — the short prompt's pre-call estimate is
        // well under this, so the call proceeds to the provider.
      })
    ).rejects.toThrow(AiBudgetExceededError);

    const row = await env.DB.prepare('SELECT succeeded, tokens_in, tokens_out, cost_usd_micros, budget_decision FROM ai_usage_log WHERE feature = ?')
      .bind('internal.gateway-diagnostic')
      .first<{ succeeded: number; tokens_in: number; tokens_out: number; cost_usd_micros: number; budget_decision: string }>();
    expect(row).toBeTruthy();
    expect(row!.succeeded).toBe(0);
    expect(row!.tokens_in).toBe(100_000); // the call DID happen this time — real usage was recorded
    expect(row!.tokens_out).toBe(100_000);
    expect(row!.cost_usd_micros).toBeGreaterThan(0);
    expect(row!.budget_decision).toMatch(/post-call rejection/);
  });

  it('inherits the platform-configured default cost cap when the caller omits maxCostUsdMicros (Task 2)', async () => {
    const result = await callAi(env as any, logger, {
      feature: 'internal.gateway-diagnostic',
      actorType: 'admin',
      actorId: adminId,
      classification: 'INTERNAL',
      userPrompt: 'Respond now.',
      // maxCostUsdMicros deliberately omitted
    });
    expect(result.content).toBe('OK');

    const row = await env.DB.prepare('SELECT budget_decision FROM ai_usage_log WHERE feature = ?').bind('internal.gateway-diagnostic').first<{ budget_decision: string }>();
    expect(row!.budget_decision).toMatch(/default cap inherited/);
  });

  it('detects and flags a masked secret in the prompt via masking_applied, even though metadata_only never stores the text', async () => {
    const result = await callAi(env as any, logger, {
      feature: 'internal.gateway-diagnostic',
      actorType: 'admin',
      actorId: adminId,
      classification: 'INTERNAL',
      userPrompt: 'Here is my api_key=sk-abcdef1234567890abcdef, please use it.',
    });
    expect(result.content).toBe('OK');

    const row = await env.DB.prepare('SELECT masking_applied, prompt_text FROM ai_usage_log WHERE feature = ?').bind('internal.gateway-diagnostic').first<{ masking_applied: number; prompt_text: string | null }>();
    expect(row!.masking_applied).toBe(1);
    expect(row!.prompt_text).toBeNull(); // default retention mode is metadata_only — masking is detected, but nothing is ever stored
  });

  it('throws immediately for an unregistered feature key, with no usage row written', async () => {
    await expect(
      callAi(env as any, logger, {
        feature: 'internal.not-a-real-feature',
        actorType: 'system',
        actorId: null,
        classification: 'INTERNAL',
        userPrompt: 'Respond now.',
      })
    ).rejects.toThrow(/No routing configuration/);

    const row = await env.DB.prepare('SELECT * FROM ai_usage_log WHERE feature = ?').bind('internal.not-a-real-feature').first();
    expect(row).toBeNull();
  });

  it('preventively refuses a call once the configured daily budget would be exceeded', async () => {
    await env.DB.prepare(`INSERT INTO site_settings (key, value) VALUES ('ai_gateway_daily_budget_usd_micros', '100')`).run();

    // Seed prior spend already at the daily budget.
    await env.DB.prepare(
      `INSERT INTO ai_usage_log (feature, provider, model, actor_type, actor_id, tokens_in, tokens_out, cost_usd_micros, latency_ms, fallback_used, succeeded)
       VALUES ('internal.gateway-diagnostic', 'openai', 'gpt-4o-mini', 'admin', ?, 10, 2, 100, 200, 0, 1)`
    )
      .bind(adminId)
      .run();

    await expect(
      callAi(env as any, logger, {
        feature: 'internal.gateway-diagnostic',
        actorType: 'admin',
        actorId: adminId,
        classification: 'INTERNAL',
        userPrompt: 'Respond now.',
      })
    ).rejects.toThrow(/daily budget/);
  });
});
