/**
 * GET /api/admin/customer-ai/analytics — Version 5.0 Milestone 3,
 * Phase 6 (Observability). Thin HTTP layer only; real logic lives in
 * services/admin/customerAiAnalyticsService.ts. super_admin-only,
 * matching every other admin-analytics surface in this project.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { getCustomerAiAnalytics } from '../../services/admin/customerAiAnalyticsService';

const SUPER_ADMIN_ONLY = ['super_admin'] as const;
const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 500, windowSeconds: 15 * 60 };

export async function handleGetCustomerAiAnalytics(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const analytics = await getCustomerAiAnalytics(env);
  return jsonSuccess(analytics);
}
