/**
 * /api/admin/coupons/* — Version 3.2 Milestone M4 (Commerce & Trust
 * Foundations). Thin HTTP layer only; all real logic lives in
 * services/couponService.ts.
 *
 * Role gating: viewing (list) is open to every authenticated role;
 * every mutation (create, update/activate/deactivate) requires
 * `editor` or `super_admin` - a coupon is a direct financial-discount
 * instrument, the same reasoning Products' editor-only-writes
 * convention already applies to catalog pricing.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import { isPlausibleSlug } from '../../services/productCatalogService';
import { listCoupons, createCoupon, updateCoupon, isValidDiscountType, isValidCouponStatus } from '../../services/couponService';
import type { CouponStatus } from '../../services/couponService';

const EDITOR_ROLES = ['super_admin', 'editor'] as const;

const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 500, windowSeconds: 15 * 60 };
const WRITE_RATE_LIMIT = { endpoint: 'admin-ops-write', limit: 60, windowSeconds: 15 * 60 };

function parseId(params: RouteParams): number | null {
  const id = parseInt(params.id ?? '', 10);
  return Number.isInteger(id) ? id : null;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

export async function handleAdminCouponsList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const params = new URL(request.url).searchParams;
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '20', 10) || 20));

  const result = await listCoupons(env, page, pageSize);
  return jsonSuccess(result);
}

export async function handleAdminCouponCreate(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  const code = typeof body.code === 'string' ? body.code : '';
  const productSlug = body.productSlug === null || body.productSlug === undefined ? null : body.productSlug;
  if (productSlug !== null && !isPlausibleSlug(productSlug)) return jsonError('VALIDATION_ERROR', 'productSlug must be a valid slug or null.');
  if (!isValidDiscountType(body.discountType)) return jsonError('VALIDATION_ERROR', 'discountType must be "percentage" or "fixed".');
  if (typeof body.discountValue !== 'number') return jsonError('VALIDATION_ERROR', 'discountValue is required.');
  const maxRedemptions = body.maxRedemptions === null || body.maxRedemptions === undefined ? null : body.maxRedemptions;
  if (maxRedemptions !== null && typeof maxRedemptions !== 'number') return jsonError('VALIDATION_ERROR', 'maxRedemptions must be a number or null.');

  const result = await createCoupon(env, logger, auth.auth.adminId, {
    code,
    productSlug: productSlug as string | null,
    discountType: body.discountType,
    discountValue: body.discountValue,
    maxRedemptions: maxRedemptions as number | null,
    firstPurchaseOnly: body.firstPurchaseOnly === true,
    startsAt: typeof body.startsAt === 'string' ? body.startsAt : null,
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
  });

  if (!result.ok) {
    if (result.reason === 'duplicate_code') return jsonError('VALIDATION_ERROR', 'A coupon with this code already exists.');
    if (result.reason === 'product_not_found') return jsonError('PRODUCT_NOT_FOUND', 'This product could not be found.');
    return jsonError('VALIDATION_ERROR', 'Invalid coupon details.');
  }

  return jsonSuccess({ id: result.id }, 201);
}

export async function handleAdminCouponUpdate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
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
  if (id === null) return jsonError('NOT_FOUND', 'This coupon could not be found.');

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  if (body.status !== undefined && !isValidCouponStatus(body.status)) return jsonError('VALIDATION_ERROR', 'A valid status is required.');
  if (body.maxRedemptions !== undefined && body.maxRedemptions !== null && typeof body.maxRedemptions !== 'number') {
    return jsonError('VALIDATION_ERROR', 'maxRedemptions must be a number or null.');
  }
  if (body.expiresAt !== undefined && body.expiresAt !== null && typeof body.expiresAt !== 'string') {
    return jsonError('VALIDATION_ERROR', 'expiresAt must be a string or null.');
  }

  const result = await updateCoupon(env, logger, auth.auth.adminId, id, {
    status: body.status as CouponStatus | undefined,
    maxRedemptions: body.maxRedemptions as number | null | undefined,
    expiresAt: body.expiresAt as string | null | undefined,
  });

  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This coupon could not be found.');
    return jsonError('VALIDATION_ERROR', 'Invalid coupon details.');
  }

  return jsonSuccess({ updated: true });
}
