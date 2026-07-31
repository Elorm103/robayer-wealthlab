/**
 * /api/admin/dashboard/* (executive endpoints) — Version 3.5 (Executive
 * Dashboard & Business Intelligence). Extends the existing
 * routes/admin/dashboard.ts (kept as-is) with the health/KPI/chart/
 * customer-insight/operational/alert endpoints the new executive
 * command-centre Dashboard page needs. Thin HTTP layer only, per this
 * project's established routes/ convention — all real logic lives in
 * services/admin/systemHealthService.ts and
 * services/admin/executiveDashboardService.ts.
 *
 * Every endpoint here is read-only and open to all three authenticated
 * admin roles, matching routes/admin/analytics.ts's own "nothing to
 * mutate on this page for any role" reasoning.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { getSystemHealth } from '../../services/admin/systemHealthService';
import * as executiveDashboardService from '../../services/admin/executiveDashboardService';
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

/** Same tolerant-default/clamp convention as routes/admin/analytics.ts's parseRange() — duplicated rather than imported since that one is deliberately kept private to its own file; identical behavior intentional, not drift. */
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

export async function handleDashboardHealth(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const health = await getSystemHealth(env, request);
  return jsonSuccess(health);
}

export async function handleDashboardExecutiveSummary(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const summary = await executiveDashboardService.getExecutiveSummary(env);
  return jsonSuccess(summary);
}

export async function handleDashboardCharts(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const charts = await executiveDashboardService.getSalesCharts(env, range);
  return jsonSuccess({ range, ...charts });
}

export async function handleDashboardCustomerInsights(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const insights = await executiveDashboardService.getCustomerInsights(env, range);
  return jsonSuccess({ range, ...insights });
}

export async function handleDashboardOperational(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const operational = await executiveDashboardService.getOperationalFeeds(env);
  return jsonSuccess(operational);
}

export async function handleDashboardAlerts(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const alerts = await executiveDashboardService.getBusinessAlerts(env);
  return jsonSuccess({ alerts });
}
