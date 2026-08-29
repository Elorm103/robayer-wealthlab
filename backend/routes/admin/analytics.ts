/**
 * /api/admin/analytics/* — Version 2.0 Phase 3 (Operational Visibility).
 * See docs/v2.0-phase3-architecture-plan.md and
 * services/admin/analyticsService.ts (all real logic lives there; this
 * file is the thin HTTP layer only, per this project's established
 * routes/ convention).
 *
 * Role gating: every endpoint here is read-only and open to all three
 * authenticated roles — there is nothing to mutate on this page for
 * any role (see the architecture plan's "Permissions" section).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import * as analyticsService from '../../services/admin/analyticsService';
import type { PeriodRange } from '../../utils/dateRange';

/**
 * Admin Analytics Dashboard v2 (2026-08-27): raised from 120 to 500.
 * This 'admin-ops-read' bucket is shared, by literal string key, across
 * every admin read endpoint in the app (14 route files each declare
 * their own identical copy of this constant — see middleware/
 * rateLimit.ts's key format, `ratelimit:{endpoint}:{ip}`). Real admin
 * usage hit it: the new System Health (60s poll) and Needs Attention
 * (60s poll, 3 requests per cycle) sections on this page, stacked on
 * top of the pre-existing Online Now poll (25s, admin-live-activity.js)
 * and ordinary page navigation, pushed background load alone to
 * roughly 96 of the old 120/15min budget — one admin with the page
 * open, no abuse involved. 500 stays a real, bounded ceiling (this is
 * not "disable the limiter"), just sized for legitimate combined
 * polling + navigation load from a single admin session. Bumped
 * consistently across all 14 files — see the reasoning above on why a
 * mismatched limit on any one of them would be misleading (they all
 * gate the same shared KV counter, not "protect that file's own
 * requests" reasoning that changes locally).
 */
const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 500, windowSeconds: 15 * 60 };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

function isValidDateString(value: string | null): value is string {
  if (!value || !DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function toDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Defaults to the last 30 days; an invalid or missing param falls back to the default rather than erroring, matching this project's established tolerant-filter convention (see routes/admin/orders.ts's status filter). A reversed range is swapped, and any range longer than a year is clamped — defensive bounds, not a real product constraint. `allTime=true` bypasses the clamp entirely, mirroring executiveDashboardService.ts's own '0001-01-01'..'9999-12-31' lifetime-range literal — except the upper bound here is '9998-12-31', not '9999-12-31': every caller in this file treats PeriodRange.to as INCLUSIVE and passes it through utils/dateRange.ts's exclusiveEndDate(), which adds one calendar day; doing that to '9999-12-31' rolls into year 10000, and `Date.toISOString()`'s extended-year format for years >9999 ("+010000-01-01...") sorts lexicographically BEFORE any real 4-digit-year timestamp (TEXT columns, plain string comparison) — silently matching zero rows instead of "everything," the opposite of what "All time" must do. '9998-12-31' avoids the rollover entirely while remaining, for all practical purposes, forever. */
function parseRange(params: URLSearchParams): PeriodRange {
  if (params.get('allTime') === 'true') {
    return { from: '0001-01-01', to: '9998-12-31' };
  }

  const now = Date.now();
  const defaultTo = toDateString(now);
  const defaultFrom = toDateString(now - 29 * 86_400_000);

  const toRaw = params.get('to');
  const fromRaw = params.get('from');
  let to = isValidDateString(toRaw) ? toRaw : defaultTo;
  let from = isValidDateString(fromRaw) ? fromRaw : defaultFrom;

  if (from > to) [from, to] = [to, from];

  const spanMs = new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime();
  if (spanMs > (MAX_RANGE_DAYS - 1) * 86_400_000) {
    from = toDateString(new Date(`${to}T00:00:00.000Z`).getTime() - (MAX_RANGE_DAYS - 1) * 86_400_000);
  }

  return { from, to };
}

export async function handleAnalyticsSummary(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const summary = await analyticsService.getSummary(env, range);
  return jsonSuccess({ range, ...summary });
}

export async function handleAnalyticsTimeseries(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const timeseries = await analyticsService.getTimeseries(env, range);
  return jsonSuccess({ range, ...timeseries });
}

export async function handleAnalyticsTopProducts(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const topProducts = await analyticsService.getTopProducts(env, range);
  return jsonSuccess({ range, items: topProducts });
}

/** Version 3.3 Milestone M5C — the Business Dashboard's activation/reconciliation/conversion-funnel section. See services/admin/analyticsService.ts's getActivationSummary(). */
export async function handleAnalyticsActivationSummary(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const summary = await analyticsService.getActivationSummary(env, range);
  return jsonSuccess({ range, ...summary });
}

/** Version 5.0 (Customer Acquisition Phase 10) — the admin observability panel for services/analytics/'s conversion dispatch layer. See services/admin/analyticsService.ts's getConversionDispatchSummary() for the full reasoning, including why Leads/Downloads are sourced from their real underlying business tables rather than analytics_conversion_log. */
export async function handleAnalyticsConversionDispatch(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const summary = await analyticsService.getConversionDispatchSummary(env);
  return jsonSuccess(summary);
}

/** Analytics & User-Activity Baseline — registered users + unique visitors, current-vs-previous. See services/admin/analyticsService.ts's getGrowthSummary(). */
export async function handleAnalyticsGrowth(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const summary = await analyticsService.getGrowthSummary(env, range);
  return jsonSuccess({ range, ...summary });
}

/** "Online Now" — no date range; it's inherently "right now". See services/admin/analyticsService.ts's getOnlineNowCount(). */
export async function handleAnalyticsOnlineNow(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  // Forensic-audit fix (2026-08-28): unlike systemHealthService.ts's own
  // checkOnlineNow() (which deliberately lets the KV throw propagate so
  // it can report the degradation), this route has no such wrapper
  // elsewhere in the call chain — a KV outage/quota exhaustion here
  // previously surfaced as an unstructured 500 instead of this project's
  // standard error shape. admin-live-activity.js already treats any
  // non-ok response as "keep the last known value," so this never shows
  // a fabricated 0 for a genuinely unavailable metric.
  try {
    const count = await analyticsService.getOnlineNowCount(env);
    return jsonSuccess({ count });
  } catch (err) {
    logger.error('analytics.online_now_unavailable', { error: err instanceof Error ? err.message : String(err) });
    return jsonError('INTERNAL_ERROR', 'Online Now is temporarily unavailable.', 503);
  }
}

/** Per-book funnel (views/checkout starts/purchases/revenue/downloads/conversion) — one row per real product, generalizes automatically to future books. See services/admin/analyticsService.ts's getPerBookFunnel(). */
export async function handleAnalyticsProductsFunnel(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const items = await analyticsService.getPerBookFunnel(env, range);
  return jsonSuccess({ range, items });
}

/**
 * Phase 8 (Digital Library Observability). Per-book reader opens, AI
 * questions asked, citation clicks, and resume shown/accepted/restarted
 * — plus a site-wide AI-mode breakdown. See
 * services/admin/analyticsService.ts's getLibraryEngagement() and
 * getLibraryAiModeBreakdown() for the exact data sources.
 */
export async function handleAnalyticsLibraryEngagement(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const [books, aiModes] = await Promise.all([
    analyticsService.getLibraryEngagement(env, range),
    analyticsService.getLibraryAiModeBreakdown(env, range),
  ]);
  return jsonSuccess({ range, books, aiModes });
}

/** Device-type breakdown, clamped to the analytics tracking start date. See services/admin/analyticsService.ts's getDeviceBreakdown(). */
export async function handleAnalyticsDevices(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const items = await analyticsService.getDeviceBreakdown(env, range);
  return jsonSuccess({ range, items });
}

/** Country breakdown (Cloudflare edge-computed 2-letter codes), clamped to the analytics tracking start date. See services/admin/analyticsService.ts's getCountryBreakdown(). */
export async function handleAnalyticsGeography(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const items = await analyticsService.getCountryBreakdown(env, range);
  return jsonSuccess({ range, items });
}

/** Reliable Sales Funnel Measurement pass — one row per normalized source (Facebook/Instagram/Email/Announcement/Homepage Spotlight/Google/Direct/etc.), joining analytics_events with purchase_sessions. See services/admin/analyticsService.ts's getSourceBreakdown(). */
export async function handleAnalyticsSourceBreakdown(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const items = await analyticsService.getSourceBreakdown(env, range);
  return jsonSuccess({ range, items });
}

/** Reliable Sales Funnel Measurement pass — the full delivered→opens→clicks→visits→views→checkout→coupon→purchase→download funnel for one newsletter campaign. See services/admin/analyticsService.ts's getCampaignFunnel() for exactly which stages are real vs. proxy vs. permanently unmeasurable. */
export async function handleAnalyticsCampaignFunnel(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const campaignId = Number(params.campaignId);
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return jsonError('NOT_FOUND', 'This campaign could not be found.');
  }

  const funnel = await analyticsService.getCampaignFunnel(env, campaignId);
  if (!funnel) return jsonError('NOT_FOUND', 'This campaign could not be found.');
  return jsonSuccess(funnel);
}

/** Admin Analytics Dashboard v2 — the site-wide Visitors → Book Views → Checkout Starts → Purchases funnel (Coupon Applications shown as a related stat, not a forced stage everyone must pass through). See services/admin/analyticsService.ts's getSalesFunnel(). */
export async function handleAnalyticsSalesFunnel(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const funnel = await analyticsService.getSalesFunnel(env, range);
  return jsonSuccess({ range, ...funnel });
}
