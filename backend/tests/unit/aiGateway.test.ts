/**
 * Unit tests: AI Gateway — Version 5.0 Milestone 1. Covers
 * docs/v5.0-ai-gateway.md's stated responsibilities using the mocked
 * OpenAI provider (tests/outboundMock.ts) — zero real API spend, per
 * that doc's own testing strategy.
 *
 * Milestone 1 ships with exactly one routing candidate
 * (services/ai/routingConfig.ts: 'internal.gateway-diagnostic' →
 * openai/gpt-4o-mini only), so a genuine cross-provider fallback
 * cannot be exercised yet — that becomes testable once a second
 * routing candidate exists. What IS covered here: a successful call
 * end-to-end, a provider-error path, cost-cap enforcement, and an
 * unregistered feature key, each verified against the ai_usage_log
 * row it produces.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { callAi } from '../../services/ai/aiGateway';
import { createLogger } from '../../utils/logger';
import { queueOpenAiResponse } from '../outboundMock';

const logger = createLogger('test-request-id', 'test');

describe('aiGateway.callAi', () => {
  let adminId: number;
  let sessionId: number;

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM ai_usage_log');
    await env.DB.exec('DELETE FROM admin_sessions');
    await env.DB.exec('DELETE FROM admin_users');

    const adminInsert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES ('ai-gateway-test-admin@example.com', 'x:1:x', 'super_admin', 1)`).run();
    adminId = Number(adminInsert.meta.last_row_id);
    const sessionInsert = await env.DB.prepare(
      `INSERT INTO admin_sessions (token, admin_id, csrf_secret, expires_at) VALUES ('test-token', ?, 'test-csrf-secret', datetime('now', '+1 hour'))`
    )
      .bind(adminId)
      .run();
    sessionId = Number(sessionInsert.meta.last_row_id);
  });

  it('completes successfully and logs a succeeded usage row', async () => {
    const result = await callAi(env as any, logger, {
      feature: 'internal.gateway-diagnostic',
      actorType: 'admin',
      actorId: adminId,
      sessionId,
      systemPrompt: 'You are a diagnostic health check. Reply with exactly one word: OK.',
      userPrompt: 'Respond now.',
    });

    expect(result.content).toBe('OK');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o-mini');
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
        data_classification: string;
        prompt_text: string;
        response_text: string;
      }>();
    expect(row).toBeTruthy();
    expect(row!.succeeded).toBe(1);
    expect(row!.provider).toBe('openai');
    expect(row!.model).toBe('gpt-4o-mini');
    expect(row!.actor_type).toBe('admin');
    expect(row!.actor_id).toBe(adminId);
    expect(row!.session_id).toBe(sessionId);
    expect(row!.data_classification).toBe('PRODUCTION');
    expect(row!.prompt_text).toContain('You are a diagnostic health check.');
    expect(row!.prompt_text).toContain('Respond now.');
    expect(row!.response_text).toBe('OK');
  });

  it('resolves a stored prompt by promptKey/version and logs the resolved template as prompt_text', async () => {
    // Seeded by database/migrations/0034_ai_gateway_hardening.sql —
    // the first-ever real (non-raw-text) prompt this Gateway resolves.
    const result = await callAi(env as any, logger, {
      feature: 'internal.gateway-diagnostic',
      actorType: 'admin',
      actorId: 1,
      promptKey: 'internal.gateway-diagnostic',
      userPrompt: 'Respond now.',
    });

    expect(result.promptVersion).toBe(1);

    const row = await env.DB.prepare('SELECT prompt_key, prompt_version, prompt_text FROM ai_usage_log WHERE feature = ?')
      .bind('internal.gateway-diagnostic')
      .first<{ prompt_key: string; prompt_version: number; prompt_text: string }>();
    expect(row!.prompt_key).toBe('internal.gateway-diagnostic');
    expect(row!.prompt_version).toBe(1);
    expect(row!.prompt_text).toContain('diagnostic health check');
  });

  it('throws and logs a failed usage row when the provider returns an error', async () => {
    await queueOpenAiResponse(env as any, { status: 500, body: { error: { message: 'mock upstream failure' } } });

    await expect(
      callAi(env as any, logger, {
        feature: 'internal.gateway-diagnostic',
        actorType: 'admin',
        actorId: 1,
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

  it('refuses an over-budget response and logs it as a failure', async () => {
    // 1,000,000 completion tokens at gpt-4o-mini's $0.6/million output
    // rate prices out to $0.60 — comfortably over a 1-micro cap.
    await queueOpenAiResponse(env as any, {
      status: 200,
      body: { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 10, completion_tokens: 1_000_000 }, model: 'gpt-4o-mini' },
    });

    await expect(
      callAi(env as any, logger, {
        feature: 'internal.gateway-diagnostic',
        actorType: 'admin',
        actorId: 1,
        userPrompt: 'Respond now.',
        maxCostUsdMicros: 1,
      })
    ).rejects.toThrow(/cost cap/);

    const row = await env.DB.prepare('SELECT succeeded, error_message FROM ai_usage_log WHERE feature = ?')
      .bind('internal.gateway-diagnostic')
      .first<{ succeeded: number; error_message: string | null }>();
    expect(row).toBeTruthy();
    expect(row!.succeeded).toBe(0);
    expect(row!.error_message).toMatch(/exceeded cap/);
  });

  it('throws immediately for an unregistered feature key, with no usage row written', async () => {
    await expect(
      callAi(env as any, logger, {
        feature: 'internal.not-a-real-feature',
        actorType: 'system',
        actorId: null,
        userPrompt: 'Respond now.',
      })
    ).rejects.toThrow(/No routing configuration/);

    const row = await env.DB.prepare('SELECT * FROM ai_usage_log WHERE feature = ?').bind('internal.not-a-real-feature').first();
    expect(row).toBeNull();
  });
});
