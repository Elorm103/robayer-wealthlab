/**
 * POST /api/analytics/event and POST /api/analytics/heartbeat —
 * Version 4.0 Milestone A (Measurement Foundation), extended by the
 * Analytics & User-Activity Baseline (migration 0045) to add
 * `product_view` plus server-side country/device/customer enrichment,
 * and a KV-only "Online Now" heartbeat. Thin HTTP layer only; writes
 * directly to `analytics_events` — no service-layer indirection needed
 * for an INSERT this simple, matching this project's own "routes stay
 * thin, but don't invent a service file for one query" judgment.
 *
 * Public, unauthenticated, fire-and-forget by design — the client
 * calls both via `navigator.sendBeacon()` (falling back to a keepalive
 * fetch) and never waits for or inspects the response. No PII is ever
 * accepted from the client: page_path/referrer/productSlug are
 * same-origin-relative strings, session_id is an ephemeral, anonymous,
 * client-generated identifier (see js/components/analytics.js), never
 * an email. country/device_type are computed server-side (from
 * `request.cf.country` and a coarse User-Agent bucket — the raw UA is
 * never stored), and customer_id is resolved server-side from an
 * existing, already-validated customer_session cookie when present —
 * a client can never supply its own customer_id.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonError, jsonSuccess } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';
import { parseCookies } from '../utils/cookies';
import { validateSession } from '../services/customer/sessionService';
import { CUSTOMER_SESSION_COOKIE_NAME } from '../middleware/requireCustomerAuth';
import { bucketDeviceType } from '../utils/deviceType';

const EVENT_RATE_LIMIT = { endpoint: 'analytics-event', limit: 60, windowSeconds: 60 };
const HEARTBEAT_RATE_LIMIT = { endpoint: 'analytics-heartbeat', limit: 4, windowSeconds: 60 };

/** Refreshed by a legitimate client roughly every 45-60s; comfortably longer than one missed beat so a closed tab ages out quickly without needing an exact heartbeat cadence. */
const ONLINE_NOW_TTL_SECONDS = 90;

const EVENT_TYPES = new Set(['page_view', 'cta_click', 'product_view']);
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
  utmContent?: unknown;
  sessionId?: unknown;
  productSlug?: unknown;
}

/**
 * Resolves the acting customer's id from an existing, already-valid
 * customer_session cookie, if any — never trusts a client-supplied
 * value. Returns null for anonymous traffic or an invalid/expired
 * session; never throws (an analytics write must never fail because a
 * session happened to be stale).
 */
async function resolveCustomerId(request: Request, env: Env): Promise<number | null> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[CUSTOMER_SESSION_COOKIE_NAME];
  if (!token) return null;
  const check = await validateSession(env, token);
  return check.ok ? check.customerId : null;
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
  if (body.eventType === 'product_view' && !isPlausibleString(body.productSlug, 100)) {
    return jsonError('VALIDATION_ERROR', 'productSlug is required for a product_view event.');
  }

  const [customerId, country] = [
    await resolveCustomerId(request, env),
    (request.cf?.country as string | undefined) ?? null,
  ];
  const deviceType = bucketDeviceType(request.headers.get('User-Agent'));

  await env.DB.prepare(
    `INSERT INTO analytics_events (event_type, page_path, cta_id, referrer, utm_source, utm_medium, utm_campaign, utm_content, session_id, product_slug, country, device_type, customer_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      body.eventType,
      body.pagePath,
      body.eventType === 'cta_click' ? (body.ctaId as string) : null,
      sanitizeOptional(body.referrer),
      sanitizeOptional(body.utmSource),
      sanitizeOptional(body.utmMedium),
      sanitizeOptional(body.utmCampaign),
      sanitizeOptional(body.utmContent),
      body.sessionId,
      body.eventType === 'product_view' ? (body.productSlug as string) : null,
      country,
      deviceType,
      customerId
    )
    .run();

  return jsonSuccess({ recorded: true });
}

interface HeartbeatBody {
  sessionId?: unknown;
}

/**
 * "Online Now" presence signal — KV only, never a D1 row (the whole
 * point of a heartbeat: a visitor who stays on the site for an hour
 * must not create dozens of rows). Key identifies an authenticated
 * customer by their real customer_id when a valid session exists, else
 * falls back to the anonymous session_id — see migration 0045's own
 * header comment on why this never creates a new identity. A forged
 * flood of heartbeats can only inflate the online-now count for at
 * most ONLINE_NOW_TTL_SECONDS per forged identifier, self-healing with
 * no cleanup job — proportionate given this metric has no revenue or
 * account-security dependency.
 */
export async function handleAnalyticsHeartbeat(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, HEARTBEAT_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  let body: HeartbeatBody;
  try {
    body = await request.json();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.');
  }
  if (!isPlausibleString(body.sessionId, 64)) {
    return jsonError('VALIDATION_ERROR', 'A valid sessionId is required.');
  }

  const customerId = await resolveCustomerId(request, env);
  const identifier = customerId !== null ? `customer:${customerId}` : `session:${body.sessionId}`;

  await env.RATE_LIMIT_KV.put(`online:${identifier}`, '1', { expirationTtl: ONLINE_NOW_TTL_SECONDS });

  return jsonSuccess({ recorded: true });
}
