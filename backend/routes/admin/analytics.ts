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
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import * as analyticsService from '../../services/admin/analyticsService';
import type { PeriodRange } from '../../utils/dateRange';

const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 120, windowSeconds: 15 * 60 };

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

/** Defaults to the last 30 days; an invalid or missing param falls back to the default rather than erroring, matching this project's established tolerant-filter convention (see routes/admin/orders.ts's status filter). A reversed range is swapped, and any range longer than a year is clamped — defensive bounds, not a real product constraint. */
function parseRange(params: URLSearchParams): PeriodRange {
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
