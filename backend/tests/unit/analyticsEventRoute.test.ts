/**
 * Route-level test: POST /api/analytics/event — Phase 8 (Digital
 * Library Observability) change only: cta_click now optionally accepts
 * and persists productSlug (previously product_view-only). This route
 * had no dedicated test before this change; scoped to the new
 * behavior, not backfilling full coverage for pre-existing code.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createLogger } from '../../utils/logger';
import { handleAnalyticsEvent } from '../../routes/analytics';

const logger = createLogger('test-request-id', 'test');

function eventRequest(body: unknown, ip: string): Request {
  return new Request('https://example.com/api/analytics/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

describe('POST /api/analytics/event — Phase 8 cta_click productSlug', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM analytics_events');
  });

  it('persists productSlug when provided on a cta_click event', async () => {
    const res = await handleAnalyticsEvent(
      eventRequest({ eventType: 'cta_click', pagePath: '/dashboard/read/', ctaId: 'library-reader-opened', productSlug: 'test-guide', sessionId: 'a'.repeat(36) }, '203.0.113.10'),
      env as any,
      logger
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(`SELECT product_slug FROM analytics_events WHERE cta_id = 'library-reader-opened'`).first<{ product_slug: string | null }>();
    expect(row?.product_slug).toBe('test-guide');
  });

  it('still succeeds, with a null product_slug, when a cta_click omits productSlug entirely (every pre-existing cta_click on the site)', async () => {
    const res = await handleAnalyticsEvent(
      eventRequest({ eventType: 'cta_click', pagePath: '/books/some-book/', ctaId: 'buy-now', sessionId: 'b'.repeat(36) }, '203.0.113.11'),
      env as any,
      logger
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(`SELECT product_slug FROM analytics_events WHERE cta_id = 'buy-now'`).first<{ product_slug: string | null }>();
    expect(row?.product_slug).toBeNull();
  });

  it('rejects a cta_click whose productSlug is present but invalid (over length)', async () => {
    const res = await handleAnalyticsEvent(
      eventRequest({ eventType: 'cta_click', pagePath: '/dashboard/read/', ctaId: 'library-reader-opened', productSlug: 'x'.repeat(101), sessionId: 'c'.repeat(36) }, '203.0.113.12'),
      env as any,
      logger
    );
    expect(res.status).toBe(400);
  });

  it('still requires productSlug for product_view, unchanged by this phase', async () => {
    const res = await handleAnalyticsEvent(
      eventRequest({ eventType: 'product_view', pagePath: '/books/some-book/', sessionId: 'd'.repeat(36) }, '203.0.113.13'),
      env as any,
      logger
    );
    expect(res.status).toBe(400);
  });
});
