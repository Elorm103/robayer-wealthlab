/**
 * Unit tests: services/analytics/conversionDispatchService.ts —
 * Version 5.0 (Customer Acquisition Phase 1). Covers the fan-out/log/
 * retry behavior directly (dispatchServerEvent, retryFailedConversions),
 * separately from tests/integration/webhook.test.ts's end-to-end
 * coverage of the real commerceService.ts call site.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createLogger } from '../../../utils/logger';
import { dispatchServerEvent, retryFailedConversions } from '../../../services/analytics/conversionDispatchService';
import { queueMetaEventsResponse } from '../../outboundMock';

const logger = createLogger('test-request-id', 'analytics test');

async function baseInput(overrides: Partial<Parameters<typeof dispatchServerEvent>[2]> = {}) {
  return {
    eventName: 'Lead' as const,
    eventId: 'test-event-1',
    eventSourceUrl: 'https://robayerwealthlab.com/free-guide/',
    customerEmail: 'lead@example.com',
    customData: { content_name: 'newsletter' },
    entityType: 'newsletter_subscriber',
    entityId: 1,
    ...overrides,
  };
}

describe('conversionDispatchService.dispatchServerEvent', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM analytics_conversion_log');
    (env as unknown as { META_CAPI_ACCESS_TOKEN?: string }).META_CAPI_ACCESS_TOKEN = undefined;
  });

  it('skips every provider (and logs nothing) when none are configured — never a fake success', async () => {
    const input = await baseInput();
    await dispatchServerEvent(env as any, logger, input);

    const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM analytics_conversion_log').first<{ c: number }>();
    expect(row?.c).toBe(0);
  });

  it('logs a real "sent" row, with the trace id, once Meta is configured and responds successfully', async () => {
    (env as unknown as { META_CAPI_ACCESS_TOKEN: string }).META_CAPI_ACCESS_TOKEN = 'test-token';
    await queueMetaEventsResponse(env as any, { status: 200, body: { events_received: 1, fbtrace_id: 'trace-abc' } });

    const input = await baseInput({ eventId: 'test-event-sent' });
    await dispatchServerEvent(env as any, logger, input);

    const row = await env.DB.prepare(`SELECT status, provider_trace_id, event_id FROM analytics_conversion_log WHERE event_id = 'test-event-sent'`).first<any>();
    expect(row.status).toBe('sent');
    expect(row.provider_trace_id).toBe('trace-abc');
  });

  it('never persists a raw email — only the request_payload with a hash, or nothing when the hash itself is absent from a null email', async () => {
    (env as unknown as { META_CAPI_ACCESS_TOKEN: string }).META_CAPI_ACCESS_TOKEN = 'test-token';
    await queueMetaEventsResponse(env as any, { status: 200, body: { events_received: 1 } });

    const input = await baseInput({ eventId: 'test-event-privacy', customerEmail: 'privacy-check@example.com' });
    await dispatchServerEvent(env as any, logger, input);

    const row = await env.DB.prepare(`SELECT request_payload FROM analytics_conversion_log WHERE event_id = 'test-event-privacy'`).first<any>();
    expect(row.request_payload).not.toContain('privacy-check@example.com');
    const payload = JSON.parse(row.request_payload);
    expect(payload.userData.emailHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a 4xx (non-429) response is logged permanently_failed after exactly one attempt — retrying a genuine rejection would never help', async () => {
    (env as unknown as { META_CAPI_ACCESS_TOKEN: string }).META_CAPI_ACCESS_TOKEN = 'test-token';
    await queueMetaEventsResponse(env as any, { status: 400, body: { error: { message: 'invalid pixel' } } });

    const input = await baseInput({ eventId: 'test-event-400' });
    await dispatchServerEvent(env as any, logger, input);

    const row = await env.DB.prepare(`SELECT status, attempt_count FROM analytics_conversion_log WHERE event_id = 'test-event-400'`).first<any>();
    expect(row.status).toBe('permanently_failed');
    expect(row.attempt_count).toBe(1);
  });
});

describe('conversionDispatchService.retryFailedConversions', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM analytics_conversion_log');
    (env as unknown as { META_CAPI_ACCESS_TOKEN: string }).META_CAPI_ACCESS_TOKEN = 'test-token';
  });

  async function seedFailedRow(eventId: string, attemptCount: number): Promise<void> {
    const payload = JSON.stringify({
      eventName: 'Purchase',
      eventId,
      eventSourceUrl: 'https://robayerwealthlab.com/checkout/callback/',
      userData: {},
      customData: { value: '39.00', currency: 'GHS' },
    });
    await env.DB.prepare(
      `INSERT INTO analytics_conversion_log (provider, event_name, event_id, entity_type, entity_id, status, attempt_count, request_payload)
       VALUES ('meta', 'Purchase', ?, 'purchase_session', 1, 'failed', ?, ?)`
    )
      .bind(eventId, attemptCount, payload)
      .run();
  }

  it('retries an eligible failed row and marks it sent on success', async () => {
    await seedFailedRow('retry-success', 2);
    await queueMetaEventsResponse(env as any, { status: 200, body: { events_received: 1, fbtrace_id: 'retry-trace' } });

    const result = await retryFailedConversions(env as any, logger);
    expect(result.eligible).toBe(1);
    expect(result.nowSent).toBe(1);

    const row = await env.DB.prepare(`SELECT status, attempt_count, provider_trace_id FROM analytics_conversion_log WHERE event_id = 'retry-success'`).first<any>();
    expect(row.status).toBe('sent');
    expect(row.attempt_count).toBe(3);
    expect(row.provider_trace_id).toBe('retry-trace');
  });

  it('gives up (permanently_failed) on a row that has already exhausted the total retry budget, without attempting another send', async () => {
    await seedFailedRow('retry-exhausted', 5); // CRON_RETRY_MAX_ATTEMPTS

    const result = await retryFailedConversions(env as any, logger);
    expect(result.eligible).toBe(1);
    expect(result.nowSent).toBe(0);

    const row = await env.DB.prepare(`SELECT status FROM analytics_conversion_log WHERE event_id = 'retry-exhausted'`).first<any>();
    expect(row.status).toBe('permanently_failed');
  });
});
