/**
 * Unit tests: AI Gateway retention cleanup — Version 5.0 Milestone 1.2
 * (AI Governance & Safety), Task 5's scheduled cleanup requirement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { runScheduledCleanup } from '../../services/ai/retentionCleanupService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');

async function seedRow(overrides: { cleanupEligibleDate: string | null; purgedAt?: string | null; promptText?: string | null; responseText?: string | null }): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO ai_usage_log (feature, provider, model, actor_type, actor_id, tokens_in, tokens_out, cost_usd_micros, latency_ms, fallback_used, succeeded, prompt_text, response_text, cleanup_eligible_date, purged_at)
     VALUES ('internal.gateway-diagnostic', 'openai', 'gpt-4o-mini', 'system', NULL, 10, 2, 100, 200, 0, 1, ?, ?, ?, ?)`
  )
    .bind(overrides.promptText ?? 'enc:v1:fake:ciphertext', overrides.responseText ?? 'enc:v1:fake:ciphertext', overrides.cleanupEligibleDate, overrides.purgedAt ?? null)
    .run();
  return Number(insert.meta.last_row_id);
}

describe('retentionCleanupService.runScheduledCleanup', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM ai_usage_log');
  });

  it('does nothing when no rows are past their cleanup_eligible_date', async () => {
    const futureDate = await env.DB.prepare(`SELECT datetime('now', '+30 days') AS d`).first<{ d: string }>();
    await seedRow({ cleanupEligibleDate: null });
    await seedRow({ cleanupEligibleDate: futureDate!.d });

    const result = await runScheduledCleanup(env as any, logger);
    expect(result.eligible).toBe(0);
    expect(result.purged).toBe(0);
  });

  it('nulls out prompt_text/response_text and stamps purged_at for a row past its cleanup_eligible_date, leaving the row itself intact', async () => {
    const pastDate = await env.DB.prepare(`SELECT datetime('now', '-1 day') AS d`).first<{ d: string }>();
    const id = await seedRow({ cleanupEligibleDate: pastDate!.d, promptText: 'enc:v1:real:ciphertext' });

    const result = await runScheduledCleanup(env as any, logger);
    expect(result.eligible).toBe(1);
    expect(result.purged).toBe(1);

    const row = await env.DB.prepare('SELECT prompt_text, response_text, purged_at, cost_usd_micros FROM ai_usage_log WHERE id = ?').bind(id).first<{
      prompt_text: string | null;
      response_text: string | null;
      purged_at: string | null;
      cost_usd_micros: number;
    }>();
    expect(row!.prompt_text).toBeNull();
    expect(row!.response_text).toBeNull();
    expect(row!.purged_at).not.toBeNull();
    expect(row!.cost_usd_micros).toBe(100); // the row itself — its cost/audit history — is never touched
  });

  it('does not touch a row with no cleanup_eligible_date (retained forever)', async () => {
    const id = await seedRow({ cleanupEligibleDate: null, promptText: 'kept-forever' });
    await runScheduledCleanup(env as any, logger);

    const row = await env.DB.prepare('SELECT prompt_text, purged_at FROM ai_usage_log WHERE id = ?').bind(id).first<{ prompt_text: string | null; purged_at: string | null }>();
    expect(row!.prompt_text).toBe('kept-forever');
    expect(row!.purged_at).toBeNull();
  });

  it('does not touch a row whose cleanup_eligible_date is still in the future', async () => {
    const futureDate = await env.DB.prepare(`SELECT datetime('now', '+30 days') AS d`).first<{ d: string }>();
    const id = await seedRow({ cleanupEligibleDate: futureDate!.d, promptText: 'not-yet-eligible' });

    const result = await runScheduledCleanup(env as any, logger);
    expect(result.eligible).toBe(0);

    const row = await env.DB.prepare('SELECT prompt_text FROM ai_usage_log WHERE id = ?').bind(id).first<{ prompt_text: string | null }>();
    expect(row!.prompt_text).toBe('not-yet-eligible');
  });

  it('is idempotent — running twice does not re-count or re-purge an already-purged row', async () => {
    const pastDate = await env.DB.prepare(`SELECT datetime('now', '-1 day') AS d`).first<{ d: string }>();
    await seedRow({ cleanupEligibleDate: pastDate!.d });

    const first = await runScheduledCleanup(env as any, logger);
    expect(first.purged).toBe(1);

    const second = await runScheduledCleanup(env as any, logger);
    expect(second.eligible).toBe(0);
    expect(second.purged).toBe(0);
  });
});
