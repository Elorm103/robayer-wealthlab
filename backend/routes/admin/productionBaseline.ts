/**
 * /api/admin/production-baseline — Version 4.9 Phase 9 (Production
 * Launch Baseline). Thin HTTP layer over
 * services/admin/productionBaselineService.ts. Capturing a baseline
 * is restricted to super_admin — it's an official, once-per-milestone
 * business record, not routine editorial work, same reasoning as
 * routes/admin/settings.ts's own SUPER_ADMIN_ONLY gate.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import * as productionBaselineService from '../../services/admin/productionBaselineService';

const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 120, windowSeconds: 15 * 60 };
const SUPER_ADMIN_ONLY = ['super_admin'] as const;

export async function handleListProductionBaselines(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const [baselines, latest] = await Promise.all([productionBaselineService.listBaselines(env), productionBaselineService.getLatestBaseline(env)]);
  return jsonSuccess({ baselines, latest });
}

export async function handleCaptureProductionBaseline(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  let body: Record<string, unknown> | null;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (!body || typeof body.platformVersion !== 'string' || body.platformVersion.trim().length === 0) {
    return jsonError('VALIDATION_ERROR', 'platformVersion is required.');
  }

  const baseline = await productionBaselineService.captureBaseline(env, logger, auth.auth.adminId, {
    platformVersion: body.platformVersion.trim(),
    launchDate: typeof body.launchDate === 'string' && body.launchDate ? body.launchDate : undefined,
    notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
  });

  return jsonSuccess({ baseline });
}
