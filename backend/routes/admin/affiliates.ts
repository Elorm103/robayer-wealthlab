/**
 * /api/admin/affiliates/*: the Admin Affiliate Centre. Thin HTTP
 * layer only; all real logic lives in affiliateService.ts /
 * affiliateCommissionService.ts / affiliatePayoutService.ts. Role
 * gating matches routes/admin/reviews.ts/coupons.ts exactly: reads
 * open to every authenticated admin role, every write (moderation,
 * rate changes, suspension, payout actions, manual adjustments)
 * requires `editor` or `super_admin`.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import {
  listAffiliates,
  getAffiliateDetail,
  moderateApplication,
  suspendAffiliate,
  reactivateAffiliate,
  setDefaultCommissionRate,
  setProductCommissionRate,
  isValidAffiliateStatus,
} from '../../services/affiliateService';
import { listAllCommissions, approveCommission, markCommissionPayable, adjustCommission, AFFILIATE_COMMISSION_STATUSES, type AffiliateCommissionStatus } from '../../services/affiliateCommissionService';
import { listAllPayouts, approvePayout, processPayout, failPayout, cancelPayout, AFFILIATE_PAYOUT_STATUSES, type AffiliatePayoutStatus } from '../../services/affiliatePayoutService';
import { listAllResourcesForAdmin, createResource, updateResourceStatus, isValidResourceCategory } from '../../services/affiliateResourceService';

const EDITOR_ROLES = ['super_admin', 'editor'] as const;
const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 500, windowSeconds: 15 * 60 };
const WRITE_RATE_LIMIT = { endpoint: 'admin-ops-write', limit: 60, windowSeconds: 15 * 60 };

function parseId(params: RouteParams): number | null {
  const id = parseInt(params.id ?? '', 10);
  return Number.isInteger(id) ? id : null;
}

function isValidCommissionStatus(value: unknown): value is AffiliateCommissionStatus {
  return typeof value === 'string' && (AFFILIATE_COMMISSION_STATUSES as readonly string[]).includes(value);
}
function isValidPayoutStatus(value: unknown): value is AffiliatePayoutStatus {
  return typeof value === 'string' && (AFFILIATE_PAYOUT_STATUSES as readonly string[]).includes(value);
}

// ============================================================
// Affiliates: list / detail / moderation / suspension / rates
// ============================================================

export async function handleAdminAffiliatesList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const params = new URL(request.url).searchParams;
  const statusRaw = params.get('status');
  const status = statusRaw && isValidAffiliateStatus(statusRaw) ? statusRaw : undefined;
  const search = params.get('search') ?? undefined;
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '20', 10) || 20));

  const result = await listAffiliates(env, { status, search }, page, pageSize);
  return jsonSuccess(result);
}

export async function handleAdminAffiliateDetail(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const id = parseId(params);
  if (id === null) return jsonError('AFFILIATE_NOT_FOUND', 'This affiliate could not be found.');

  const detail = await getAffiliateDetail(env, id);
  if (!detail) return jsonError('AFFILIATE_NOT_FOUND', 'This affiliate could not be found.');
  return jsonSuccess(detail);
}

export async function handleAdminAffiliateModerate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const id = parseId(params);
  if (id === null) return jsonError('AFFILIATE_NOT_FOUND', 'This affiliate could not be found.');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.');
  }
  const { status, rejectionReason } = (body as { status?: unknown; rejectionReason?: unknown }) ?? {};
  if (status !== 'approved' && status !== 'rejected') return jsonError('VALIDATION_ERROR', 'status must be "approved" or "rejected".');

  const result = await moderateApplication(env, logger, auth.auth.adminId, id, status, typeof rejectionReason === 'string' ? rejectionReason : null);
  if (!result.ok) return jsonError(result.reason === 'not_found' ? 'AFFILIATE_NOT_FOUND' : 'INVALID_STATE_TRANSITION', 'This application could not be moderated in its current state.');
  return jsonSuccess({ moderated: true });
}

export async function handleAdminAffiliateSuspend(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const id = parseId(params);
  if (id === null) return jsonError('AFFILIATE_NOT_FOUND', 'This affiliate could not be found.');

  const body = await request.json().catch(() => ({}));
  const reason = (body as { reason?: unknown })?.reason;
  if (typeof reason !== 'string' || reason.trim().length < 3) return jsonError('VALIDATION_ERROR', 'A reason is required to suspend an affiliate.');

  const result = await suspendAffiliate(env, logger, auth.auth.adminId, id, reason.trim());
  if (!result.ok) return jsonError(result.reason === 'not_found' ? 'AFFILIATE_NOT_FOUND' : 'INVALID_STATE_TRANSITION', 'This affiliate could not be suspended in its current state.');
  return jsonSuccess({ suspended: true });
}

export async function handleAdminAffiliateReactivate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const id = parseId(params);
  if (id === null) return jsonError('AFFILIATE_NOT_FOUND', 'This affiliate could not be found.');

  const result = await reactivateAffiliate(env, logger, auth.auth.adminId, id);
  if (!result.ok) return jsonError(result.reason === 'not_found' ? 'AFFILIATE_NOT_FOUND' : 'INVALID_STATE_TRANSITION', 'This affiliate could not be reactivated in its current state.');
  return jsonSuccess({ reactivated: true });
}

export async function handleAdminAffiliateSetDefaultRate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const id = parseId(params);
  if (id === null) return jsonError('AFFILIATE_NOT_FOUND', 'This affiliate could not be found.');

  const body = await request.json().catch(() => ({}));
  const percent = (body as { percent?: unknown })?.percent;
  if (typeof percent !== 'number') return jsonError('VALIDATION_ERROR', 'A numeric percent is required.');

  const result = await setDefaultCommissionRate(env, logger, auth.auth.adminId, id, percent);
  if (!result.ok) return jsonError(result.reason === 'not_found' ? 'AFFILIATE_NOT_FOUND' : 'VALIDATION_ERROR', 'This rate could not be set.');
  return jsonSuccess({ ok: true });
}

export async function handleAdminAffiliateSetProductRate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const id = parseId(params);
  if (id === null) return jsonError('AFFILIATE_NOT_FOUND', 'This affiliate could not be found.');

  const body = await request.json().catch(() => ({}));
  const { productSlug, percent } = (body as { productSlug?: unknown; percent?: unknown }) ?? {};
  if (typeof productSlug !== 'string' || typeof percent !== 'number') return jsonError('VALIDATION_ERROR', 'productSlug and a numeric percent are required.');

  const result = await setProductCommissionRate(env, logger, auth.auth.adminId, id, productSlug, percent);
  if (!result.ok) {
    const code = result.reason === 'product_not_found' ? 'PRODUCT_NOT_FOUND' : result.reason === 'not_found' ? 'AFFILIATE_NOT_FOUND' : 'VALIDATION_ERROR';
    return jsonError(code, 'This product rate could not be set.');
  }
  return jsonSuccess({ ok: true });
}

// ============================================================
// Commissions: list / lifecycle / manual adjustment
// ============================================================

export async function handleAdminCommissionsList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const params = new URL(request.url).searchParams;
  const statusRaw = params.get('status');
  const status = statusRaw && isValidCommissionStatus(statusRaw) ? statusRaw : undefined;
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '20', 10) || 20));

  const result = await listAllCommissions(env, { status }, page, pageSize);
  return jsonSuccess(result);
}

export async function handleAdminCommissionApprove(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This commission could not be found.');
  const result = await approveCommission(env, logger, auth.auth.adminId, id);
  if (!result.ok) return jsonError(result.reason === 'not_found' ? 'NOT_FOUND' : 'INVALID_STATE_TRANSITION', 'This commission could not be approved in its current state.');
  return jsonSuccess({ ok: true });
}

export async function handleAdminCommissionMarkPayable(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This commission could not be found.');
  const result = await markCommissionPayable(env, logger, auth.auth.adminId, id);
  if (!result.ok) return jsonError(result.reason === 'not_found' ? 'NOT_FOUND' : 'INVALID_STATE_TRANSITION', 'This commission could not be marked payable in its current state.');
  return jsonSuccess({ ok: true });
}

export async function handleAdminCommissionAdjust(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This commission could not be found.');

  const body = await request.json().catch(() => ({}));
  const { newStatus, newCommissionPesewas, reason } = (body as { newStatus?: unknown; newCommissionPesewas?: unknown; reason?: unknown }) ?? {};
  if (typeof reason !== 'string') return jsonError('VALIDATION_ERROR', 'A reason is required for any manual commission adjustment.');
  if (newStatus !== undefined && !isValidCommissionStatus(newStatus)) return jsonError('VALIDATION_ERROR', 'Invalid newStatus.');
  if (newCommissionPesewas !== undefined && typeof newCommissionPesewas !== 'number') return jsonError('VALIDATION_ERROR', 'Invalid newCommissionPesewas.');

  const result = await adjustCommission(env, logger, auth.auth.adminId, id, {
    newStatus: newStatus as AffiliateCommissionStatus | undefined,
    newCommissionPesewas: newCommissionPesewas as number | undefined,
    reason,
  });
  if (!result.ok) return jsonError(result.reason === 'not_found' ? 'NOT_FOUND' : 'VALIDATION_ERROR', 'This commission could not be adjusted.');
  return jsonSuccess({ ok: true });
}

// ============================================================
// Payouts: list / approve / process / fail / cancel
// ============================================================

export async function handleAdminPayoutsList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const params = new URL(request.url).searchParams;
  const statusRaw = params.get('status');
  const status = statusRaw && isValidPayoutStatus(statusRaw) ? statusRaw : undefined;
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '20', 10) || 20));

  const result = await listAllPayouts(env, { status }, page, pageSize);
  return jsonSuccess(result);
}

async function handlePayoutTransition(
  request: Request,
  env: Env,
  logger: Logger,
  params: RouteParams,
  run: (adminId: number, payoutId: number, body: Record<string, unknown>) => ReturnType<typeof approvePayout>
): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const id = parseId(params);
  if (id === null) return jsonError('PAYOUT_NOT_FOUND', 'This payout could not be found.');
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const result = await run(auth.auth.adminId, id, body);
  if (!result.ok) return jsonError(result.reason === 'not_found' ? 'PAYOUT_NOT_FOUND' : result.reason === 'invalid_input' ? 'VALIDATION_ERROR' : 'INVALID_STATE_TRANSITION', 'This payout could not be updated in its current state.');
  return jsonSuccess({ ok: true });
}

export async function handleAdminPayoutApprove(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  return handlePayoutTransition(request, env, logger, params, (adminId, id) => approvePayout(env, logger, adminId, id));
}

export async function handleAdminPayoutProcess(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  return handlePayoutTransition(request, env, logger, params, (adminId, id, body) => processPayout(env, logger, adminId, id, typeof body.reference === 'string' ? body.reference : ''));
}

export async function handleAdminPayoutFail(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  return handlePayoutTransition(request, env, logger, params, (adminId, id, body) => failPayout(env, logger, adminId, id, typeof body.reason === 'string' ? body.reason : 'Not specified'));
}

export async function handleAdminPayoutCancel(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  return handlePayoutTransition(request, env, logger, params, (adminId, id, body) => cancelPayout(env, logger, adminId, id, typeof body.reason === 'string' ? body.reason : 'Not specified'));
}

// ============================================================
// Resources (Marketing Centre)
// ============================================================

export async function handleAdminResourcesList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const resources = await listAllResourcesForAdmin(env);
  return jsonSuccess({ resources });
}

export async function handleAdminResourceCreate(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const { title, category, resourceBody, mediaId, productSlug, sortOrder } = body;
  if (typeof title !== 'string' || !isValidResourceCategory(category)) return jsonError('VALIDATION_ERROR', 'title and a valid category are required.');

  const result = await createResource(env, logger, auth.auth.adminId, {
    title,
    category,
    body: typeof resourceBody === 'string' ? resourceBody : null,
    mediaId: typeof mediaId === 'number' ? mediaId : null,
    productSlug: typeof productSlug === 'string' ? productSlug : null,
    sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
  });
  if (!result.ok) return jsonError('VALIDATION_ERROR', 'This resource could not be created.');
  return jsonSuccess({ id: result.id });
}

export async function handleAdminResourceUpdateStatus(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This resource could not be found.');
  const body = (await request.json().catch(() => ({}))) as { status?: unknown };
  if (body.status !== 'draft' && body.status !== 'published' && body.status !== 'archived') return jsonError('VALIDATION_ERROR', 'Invalid status.');

  const result = await updateResourceStatus(env, logger, auth.auth.adminId, id, body.status);
  if (!result.ok) return jsonError('NOT_FOUND', 'This resource could not be found.');
  return jsonSuccess({ ok: true });
}
