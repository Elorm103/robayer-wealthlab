/**
 * /api/admin/orders/* — Version 2.0 Phase 3 (Operational Visibility).
 * See docs/v2.0-phase3-architecture-plan.md and
 * services/admin/orderService.ts (all real logic lives there; this file
 * is the thin HTTP layer only, per this project's established routes/
 * convention — see routes/admin/products.ts).
 *
 * Role gating: list/detail are open to all three authenticated roles
 * (support included — read visibility into orders is a legitimate part
 * of the support workflow, same reasoning as Consultation/Contact
 * Manager). The two resend actions are `super_admin`/`editor` only —
 * this is the first Phase 3 endpoint pair with a real, external,
 * customer-facing consequence (an unwanted email), so it follows
 * Products' `EDITOR_ROLES`-gated-writes convention instead of
 * Consultation/Contact Manager's all-roles-can-write one. The role
 * check happens here, server-side — the frontend hiding the resend
 * buttons for `support` is UX only, never the security boundary (see
 * middleware/requireRole.ts's own header comment).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import * as orderService from '../../services/admin/orderService';
import { isValidOrderStatus } from '../../services/admin/orderService';

const EDITOR_ROLES = ['super_admin', 'editor'] as const;

const WRITE_RATE_LIMIT = { endpoint: 'admin-ops-write', limit: 60, windowSeconds: 15 * 60 };
const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 120, windowSeconds: 15 * 60 };

// Same convention as the public routes/purchases.ts's own REFERENCE_PATTERN
// — validated here, before touching D1, rather than trusting the URL param.
const REFERENCE_PATTERN = /^RWL-\d{4}-\d{6,}$/;

function isPlausibleReference(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value);
}

export async function handleOrdersMeta(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  return jsonSuccess({ statuses: orderService.ORDER_STATUSES });
}

export async function handleOrdersList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const params = new URL(request.url).searchParams;

  const statusRaw = params.get('status');
  const status = statusRaw && isValidOrderStatus(statusRaw) ? statusRaw : null;

  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '20', 10) || 20));

  const result = await orderService.listOrders(env, {
    search: params.get('search'),
    status,
    productSlug: params.get('productSlug'),
    dateFrom: params.get('dateFrom'),
    dateTo: params.get('dateTo'),
    page,
    pageSize,
  });

  return jsonSuccess(result);
}

export async function handleOrderGet(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const reference = params.reference;
  if (!isPlausibleReference(reference)) {
    return jsonError('NOT_FOUND', 'This order could not be found.');
  }

  const order = await orderService.getOrderByReference(env, reference);
  if (!order) return jsonError('NOT_FOUND', 'This order could not be found.');

  return jsonSuccess(order);
}

function resendErrorResponse(reason: 'not_found' | 'not_verified' | 'send_failed'): Response {
  if (reason === 'not_found') return jsonError('NOT_FOUND', 'This order could not be found.');
  if (reason === 'not_verified') return jsonError('VALIDATION_ERROR', 'Only a verified order with a customer email can have emails resent.');
  return jsonError('INTERNAL_ERROR', 'The email could not be sent. Please try again shortly.');
}

export async function handleOrderResendReceipt(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const reference = params.reference;
  if (!isPlausibleReference(reference)) {
    return jsonError('NOT_FOUND', 'This order could not be found.');
  }

  const result = await orderService.resendReceipt(env, logger, auth.auth.adminId, reference);
  if (!result.ok) return resendErrorResponse(result.reason);

  return jsonSuccess({ resent: true });
}

export async function handleOrderResendDownload(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const reference = params.reference;
  if (!isPlausibleReference(reference)) {
    return jsonError('NOT_FOUND', 'This order could not be found.');
  }

  const result = await orderService.resendDownload(env, logger, auth.auth.adminId, reference);
  if (!result.ok) return resendErrorResponse(result.reason);

  return jsonSuccess({ resent: true });
}
