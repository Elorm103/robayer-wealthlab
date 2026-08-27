/**
 * /api/admin/reviews/* — Version 3.2 Milestone M4 (Commerce & Trust
 * Foundations). Thin HTTP layer only; all real logic lives in
 * services/reviewService.ts.
 *
 * Role gating: viewing (list) is open to every authenticated role;
 * moderation (approve/reject) requires `editor` or `super_admin`,
 * matching Products' editor-only-writes convention (a moderation
 * decision has real customer-facing/trust consequences, the same
 * reasoning routes/admin/orders.ts's refund action already applies).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import { listReviewsForModeration, moderateReview, isValidReviewStatus } from '../../services/reviewService';

const EDITOR_ROLES = ['super_admin', 'editor'] as const;

const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 500, windowSeconds: 15 * 60 };
const WRITE_RATE_LIMIT = { endpoint: 'admin-ops-write', limit: 60, windowSeconds: 15 * 60 };

function parseId(params: RouteParams): number | null {
  const id = parseInt(params.id ?? '', 10);
  return Number.isInteger(id) ? id : null;
}

export async function handleAdminReviewsList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const params = new URL(request.url).searchParams;
  const statusRaw = params.get('status');
  const status = statusRaw && isValidReviewStatus(statusRaw) ? statusRaw : null;
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '20', 10) || 20));

  const result = await listReviewsForModeration(env, { status, page, pageSize });
  return jsonSuccess(result);
}

export async function handleAdminReviewModerate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This review could not be found.');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.');
  }
  const status = (body as { status?: unknown })?.status;
  if (status !== 'approved' && status !== 'rejected') {
    return jsonError('VALIDATION_ERROR', 'status must be "approved" or "rejected".');
  }

  const result = await moderateReview(env, logger, auth.auth.adminId, id, status);
  if (!result.ok) return jsonError('NOT_FOUND', 'This review could not be found.');

  return jsonSuccess({ moderated: true });
}
