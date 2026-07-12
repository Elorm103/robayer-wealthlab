/**
 * GET /api/admin/dashboard/summary — Version 2.0 Phase 0.2 (Admin
 * Shell). See docs/v2-admin-shell-architecture.md and
 * docs/v2-authentication-design.md's permissions table ("Analytics —
 * view: all three roles") — this is a read-only endpoint every
 * authenticated admin, regardless of role, can call; no `requireRole`
 * gate needed beyond `requireAuth` itself.
 *
 * Thin HTTP layer only, per this project's established routes/
 * convention: auth check, delegate to services/admin/dashboardService.ts,
 * format the response. Never touches D1 directly.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonSuccess } from '../../utils/responses';
import { requireAuth } from '../../middleware/requireAuth';
import { getDashboardSummary } from '../../services/admin/dashboardService';

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(response.body, { status: response.status, headers });
}

export async function handleAdminDashboardSummary(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  const summary = await getDashboardSummary(env);
  return withNoStore(jsonSuccess(summary));
}
