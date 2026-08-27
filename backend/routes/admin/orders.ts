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
import { adminReprocessPurchase } from '../../services/commerceService';

const EDITOR_ROLES = ['super_admin', 'editor'] as const;

const WRITE_RATE_LIMIT = { endpoint: 'admin-ops-write', limit: 60, windowSeconds: 15 * 60 };
const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 500, windowSeconds: 15 * 60 };

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

/**
 * Version 3.0.2 Milestone M2 - the internal, admin-triggered refund
 * action (ADR-003's revocation-sync mechanism). `EDITOR_ROLES`-gated,
 * same as the two resend actions above - this has a real, permanent,
 * customer-facing consequence (access revoked), arguably a stronger
 * reason for this gating than an email resend. The confirmation-step
 * discipline (AR-009) belongs to whichever admin UI calls this - not
 * built in this milestone - but this endpoint itself is idempotent
 * either way (see revocationService.ts), so a double-submit from a
 * slow UI can never double-revoke or corrupt state.
 */
export async function handleOrderRefund(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
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

  const result = await orderService.refundOrder(env, logger, auth.auth.adminId, reference);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This order could not be found.');
    if (result.reason === 'already_refunded') return jsonError('VALIDATION_ERROR', 'This order has already been refunded.');
    return jsonError('VALIDATION_ERROR', 'Only a verified order can be refunded.');
  }

  return jsonSuccess({ refunded: true });
}

const REPROCESS_ERROR_MESSAGES: Record<string, string> = {
  not_found: 'This order could not be found.',
  not_reprocessable: 'Only a purchase currently marked failed or expired can be reprocessed.',
  provider_error: 'Could not reach the payment provider to re-verify this purchase. Please try again shortly.',
  provider_status_not_success: 'The payment provider does not report this transaction as successful.',
  amount_or_currency_mismatch: 'The amount or currency confirmed by the payment provider does not match this purchase.',
  metadata_mismatch: 'The payment provider’s confirmed details do not match this purchase.',
  product_no_longer_valid: 'This product is no longer purchasable, so this purchase cannot be reprocessed.',
  concurrent_resolution: 'This purchase was already resolved by another request.',
};

/**
 * Re-verifies a `failed`/`expired` purchase fresh against Paystack and, if
 * every check now genuinely passes, completes it exactly as the webhook
 * would have — see commerceService.adminReprocessPurchase()'s own doc
 * comment for why this exists and how it stays safe. `super_admin`/`editor`
 * only, same gating as the refund action above (a real, external,
 * customer-facing consequence — an email and a granted download).
 */
export async function handleOrderReprocess(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
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

  const result = await adminReprocessPurchase(env, logger, auth.auth.adminId, reference);
  if (!result.ok) {
    return jsonError('VALIDATION_ERROR', REPROCESS_ERROR_MESSAGES[result.reason] ?? 'This purchase could not be reprocessed.');
  }

  return jsonSuccess({ reprocessed: true });
}
