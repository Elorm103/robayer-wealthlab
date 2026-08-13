/**
 * /api/admin/profitability/* — P0-D (Business Intelligence backbone,
 * Profitability & Campaign Performance Reporting). Thin HTTP layer
 * only, per this project's established routes/ convention — all real
 * logic lives in services/admin/profitabilityService.ts.
 *
 * Read-only, open to all three authenticated admin roles (including
 * `support`), matching routes/admin/executiveDashboard.ts's own
 * "nothing to mutate on this page for any role" precedent — this is
 * strictly a reporting view over data already visible elsewhere in the
 * admin (revenue via the Executive Dashboard, ad spend via the
 * Advertising Spend ledger). No CSRF needed: GET-only, no mutation.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth, type AdminAuthContext } from '../../middleware/requireAuth';
import { getPlatformProfitability, getCampaignProfitability } from '../../services/admin/profitabilityService';
import { parseAnalyticsMode, isAnalyticsMode, type AnalyticsMode } from '../../services/admin/executiveDashboardService';
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

/** Same tolerant-default/clamp convention as routes/admin/executiveDashboard.ts's own parseRange() — duplicated rather than imported since that one is deliberately kept private to its own file; identical behavior intentional, not drift. */
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

/** Same "admin's own persisted Analytics Mode is the fallback" convention as routes/admin/executiveDashboard.ts's adminAnalyticsModeDefault(). */
function adminAnalyticsModeDefault(auth: AdminAuthContext): AnalyticsMode {
  return isAnalyticsMode(auth.analyticsMode) ? auth.analyticsMode : 'production';
}

export async function handleProfitabilitySummary(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const analyticsMode = parseAnalyticsMode(new URL(request.url).searchParams.get('analyticsMode'), adminAnalyticsModeDefault(auth.auth));
  const summary = await getPlatformProfitability(env, range, analyticsMode);
  return jsonSuccess(summary);
}

export async function handleProfitabilityCampaigns(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const range = parseRange(new URL(request.url).searchParams);
  const analyticsMode = parseAnalyticsMode(new URL(request.url).searchParams.get('analyticsMode'), adminAnalyticsModeDefault(auth.auth));
  const result = await getCampaignProfitability(env, range, analyticsMode);
  return jsonSuccess({ range, ...result });
}
