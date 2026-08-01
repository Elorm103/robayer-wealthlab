/**
 * POST /api/analytics/event — Version 4.0 Milestone A (Measurement
 * Foundation). Thin HTTP layer only; writes directly to the new
 * `analytics_events` table (migration 0025) — no service-layer
 * indirection needed for a single INSERT this simple, matching this
 * project's own "routes stay thin, but don't invent a service file
 * for one query" judgment already applied elsewhere.
 *
 * Public, unauthenticated, fire-and-forget by design — the client
 * calls this via `navigator.sendBeacon()` (falling back to a
 * keepalive fetch) and never waits for or inspects the response. No
 * PII is ever accepted: page_path/referrer are same-origin-relative
 * strings, session_id is an ephemeral, anonymous, client-generated
 * identifier (see js/components/analytics.js), never an email,
 * cookie, or customer identifier.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonError, jsonSuccess } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';

const EVENT_RATE_LIMIT = { endpoint: 'analytics-event', limit: 60, windowSeconds: 60 };

const EVENT_TYPES = new Set(['page_view', 'cta_click']);
const MAX_STRING_LENGTH = 200;

function isPlausibleString(value: unknown, maxLength = MAX_STRING_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function sanitizeOptional(value: unknown): string | null {
  return isPlausibleString(value) ? value : null;
}

interface AnalyticsEventBody {
  eventType?: unknown;
  pagePath?: unknown;
  ctaId?: unknown;
  referrer?: unknown;
  utmSource?: unknown;
  utmMedium?: unknown;
  utmCampaign?: unknown;
  sessionId?: unknown;
}

export async function handleAnalyticsEvent(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, EVENT_RATE_LIMIT)) {
    // Never surfaced to a real visitor (this is a background beacon) -
    // returning an error here is only so a future direct API test can
    // tell the limit is real, not so the client does anything with it.
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  let body: AnalyticsEventBody;
  try {
    body = await request.json();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.');
  }

  if (!isPlausibleString(body.eventType) || !EVENT_TYPES.has(body.eventType)) {
    return jsonError('VALIDATION_ERROR', 'A valid eventType is required.');
  }
  if (!isPlausibleString(body.pagePath) || !body.pagePath.startsWith('/')) {
    return jsonError('VALIDATION_ERROR', 'A valid pagePath is required.');
  }
  if (!isPlausibleString(body.sessionId, 64)) {
    return jsonError('VALIDATION_ERROR', 'A valid sessionId is required.');
  }
  if (body.eventType === 'cta_click' && !isPlausibleString(body.ctaId, 100)) {
    return jsonError('VALIDATION_ERROR', 'ctaId is required for a cta_click event.');
  }

  await env.DB.prepare(
    `INSERT INTO analytics_events (event_type, page_path, cta_id, referrer, utm_source, utm_medium, utm_campaign, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      body.eventType,
      body.pagePath,
      body.eventType === 'cta_click' ? (body.ctaId as string) : null,
      sanitizeOptional(body.referrer),
      sanitizeOptional(body.utmSource),
      sanitizeOptional(body.utmMedium),
      sanitizeOptional(body.utmCampaign),
      body.sessionId
    )
    .run();

  return jsonSuccess({ recorded: true });
}
