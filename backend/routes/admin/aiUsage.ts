/**
 * /api/admin/ai-usage/* — Version 5.0 Milestone 1.1 (Operational
 * Hardening). Thin HTTP layer only; all query logic lives in
 * services/admin/aiUsageService.ts.
 *
 * Role gating: super_admin only for every route on this page,
 * including the plain list — matching the posture Settings already
 * established for AI Gateway/Payment diagnostics (operational + cost
 * data, not general content). The single-row detail endpoint is the
 * only one that ever returns prompt/response text, per the explicit
 * "do not expose prompt contents by default" requirement.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { listAiUsage, getAiUsageDetail, exportAiUsageCsv, getAiUsageAnalytics } from '../../services/admin/aiUsageService';
import type { AiUsageFilters } from '../../services/admin/aiUsageService';

const SUPER_ADMIN_ONLY = ['super_admin'] as const;
const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 120, windowSeconds: 15 * 60 };

function parseFilters(params: URLSearchParams): AiUsageFilters {
  const status = params.get('status');
  return {
    search: params.get('search') ?? undefined,
    dateFrom: params.get('dateFrom') ?? undefined,
    dateTo: params.get('dateTo') ?? undefined,
    feature: params.get('feature') ?? undefined,
    provider: params.get('provider') ?? undefined,
    status: status === 'succeeded' || status === 'failed' ? status : undefined,
  };
}

async function gate(request: Request, env: Env, logger: Logger) {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return { ok: false as const, response: auth.response };
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return { ok: false as const, response: roleFailure };
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return { ok: false as const, response: jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.') };
  }
  return { ok: true as const };
}

export async function handleListAiUsage(request: Request, env: Env, logger: Logger): Promise<Response> {
  const gated = await gate(request, env, logger);
  if (!gated.ok) return gated.response;

  const params = new URL(request.url).searchParams;
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '25', 10) || 25));

  const result = await listAiUsage(env, parseFilters(params), page, pageSize);
  return jsonSuccess(result);
}

export async function handleGetAiUsageDetail(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const gated = await gate(request, env, logger);
  if (!gated.ok) return gated.response;

  const id = parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return jsonError('NOT_FOUND', 'This AI usage record could not be found.');

  const detail = await getAiUsageDetail(env, id);
  if (!detail) return jsonError('NOT_FOUND', 'This AI usage record could not be found.');
  return jsonSuccess(detail);
}

export async function handleExportAiUsageCsv(request: Request, env: Env, logger: Logger): Promise<Response> {
  const gated = await gate(request, env, logger);
  if (!gated.ok) return gated.response;

  const params = new URL(request.url).searchParams;
  const csv = await exportAiUsageCsv(env, parseFilters(params));
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ai-usage-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

export async function handleGetAiUsageAnalytics(request: Request, env: Env, logger: Logger): Promise<Response> {
  const gated = await gate(request, env, logger);
  if (!gated.ok) return gated.response;

  const params = new URL(request.url).searchParams;
  const days = Math.max(1, Math.min(365, parseInt(params.get('days') ?? '30', 10) || 30));

  const analytics = await getAiUsageAnalytics(env, days);
  return jsonSuccess(analytics);
}
