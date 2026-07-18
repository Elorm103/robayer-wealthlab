/**
 * /api/admin/users/* — Version 2.1 Phase 4 (User Management). See
 * docs/v2.1-phase4-design.md. Thin HTTP layer only, per this project's
 * established routes/ convention — all real logic lives in
 * `services/admin/adminUserService.ts`.
 *
 * Every route here requires `super_admin` — this module is closed to
 * `editor`/`support` for reads as well as writes (see the design doc's
 * permission-matrix section for why: the visible fields are sensitive
 * security data about other admins' accounts, not general content).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import * as adminUserService from '../../services/admin/adminUserService';
import type { ManagementError } from '../../services/admin/adminUserService';
import { validateInviteToken, acceptInvite } from '../../services/admin/authService';
import type { PasswordValidationError } from '../../utils/passwordPolicy';

const SUPER_ADMIN_ONLY = ['super_admin'] as const;

function actionContext(request: Request) {
  return { ip: request.headers.get('CF-Connecting-IP'), userAgent: request.headers.get('User-Agent') };
}

function managementErrorResponse(error: ManagementError): Response {
  switch (error.reason) {
    case 'not_found':
    case 'invite_not_found':
      return jsonError('NOT_FOUND', 'This account could not be found.');
    case 'self_targeted':
      return jsonError('SELF_TARGETED', 'You cannot perform this action on your own account.');
    case 'last_super_admin':
      return jsonError('LAST_SUPER_ADMIN', 'This is the last active Super Administrator and cannot be removed, disabled, or demoted.');
    case 'invalid_role':
      return jsonError('INVALID_ROLE', 'A valid role is required.');
    case 'email_taken':
      return jsonError('EMAIL_TAKEN', 'An account with this email already exists.');
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

function parseId(params: RouteParams): number | null {
  const id = parseInt(params.id ?? '', 10);
  return Number.isInteger(id) ? id : null;
}

async function guardWriteAccess(request: Request, env: Env, logger: Logger) {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return { ok: false as const, response: roleFailure };
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return { ok: false as const, response: csrfFailure };
  return auth;
}

// ============================================================
// List / detail
// ============================================================

export async function handleListAdmins(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;

  const showDeleted = new URL(request.url).searchParams.get('deleted') === 'true';
  const [admins, pendingInvites] = await Promise.all([adminUserService.listAdmins(env, showDeleted), adminUserService.listPendingInvites(env)]);

  return jsonSuccess({ admins, pendingInvites });
}

export async function handleGetAdmin(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This account could not be found.');

  const detail = await adminUserService.getAdminDetail(env, id);
  if (!detail) return jsonError('NOT_FOUND', 'This account could not be found.');

  return jsonSuccess(detail);
}

// ============================================================
// Invite / resend / cancel
// ============================================================

export async function handleInviteAdmin(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await guardWriteAccess(request, env, logger);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
  const role = typeof body.role === 'string' ? body.role : '';
  if (!email) return jsonError('VALIDATION_ERROR', 'An email address is required.');

  const result = await adminUserService.inviteAdmin(env, logger, auth.auth.adminId, { email, name, role }, env.SITE_BASE_URL, actionContext(request));
  if (!result.ok) return managementErrorResponse(result);

  return jsonSuccess({ inviteId: result.inviteId }, 201);
}

export async function handleResendInvite(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await guardWriteAccess(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This invitation could not be found.');

  const result = await adminUserService.resendInvite(env, logger, auth.auth.adminId, id, env.SITE_BASE_URL, actionContext(request));
  if (!result.ok) return managementErrorResponse(result);

  return jsonSuccess({ inviteId: result.inviteId });
}

export async function handleCancelInvite(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await guardWriteAccess(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This invitation could not be found.');

  const result = await adminUserService.cancelInvite(env, logger, auth.auth.adminId, id, actionContext(request));
  if (!result.ok) return managementErrorResponse(result);

  return jsonSuccess({ cancelled: true });
}

// ============================================================
// Edit / disable / reactivate / delete
// ============================================================

function validationFieldsResponse(errors: PasswordValidationError[]): Response {
  const body = { success: false, error: { code: 'VALIDATION_ERROR', message: errors[0]?.message ?? 'Validation failed.' }, fields: errors };
  return new Response(JSON.stringify(body), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

export async function handleEditAdmin(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await guardWriteAccess(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This account could not be found.');

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  const input: { name?: string | null; role?: string } = {};
  if (typeof body.name === 'string') input.name = body.name.trim() || null;
  if (typeof body.role === 'string') input.role = body.role;

  const result = await adminUserService.editAdmin(env, logger, auth.auth.adminId, id, input, actionContext(request));
  if (!result.ok) return managementErrorResponse(result);

  return jsonSuccess({ updated: true });
}

export async function handleDisableAdmin(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await guardWriteAccess(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This account could not be found.');

  const result = await adminUserService.setActive(env, logger, auth.auth.adminId, id, false, actionContext(request));
  if (!result.ok) return managementErrorResponse(result);

  return jsonSuccess({ disabled: true });
}

export async function handleReactivateAdmin(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await guardWriteAccess(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This account could not be found.');

  const result = await adminUserService.setActive(env, logger, auth.auth.adminId, id, true, actionContext(request));
  if (!result.ok) return managementErrorResponse(result);

  return jsonSuccess({ reactivated: true });
}

export async function handleDeleteAdmin(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await guardWriteAccess(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This account could not be found.');

  const result = await adminUserService.softDeleteAdmin(env, logger, auth.auth.adminId, id, actionContext(request));
  if (!result.ok) return managementErrorResponse(result);

  return jsonSuccess({ deleted: true });
}

// ============================================================
// Security actions
// ============================================================

export async function handleForcePasswordReset(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await guardWriteAccess(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This account could not be found.');

  const result = await adminUserService.forcePasswordReset(env, logger, auth.auth.adminId, id, env.SITE_BASE_URL, actionContext(request));
  if (!result.ok) return managementErrorResponse(result);

  return jsonSuccess({ sent: true });
}

export async function handleForcePasswordChange(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await guardWriteAccess(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This account could not be found.');

  const result = await adminUserService.forcePasswordChange(env, logger, auth.auth.adminId, id, actionContext(request));
  if (!result.ok) return managementErrorResponse(result);

  return jsonSuccess({ flagged: true });
}

export async function handleForceLogout(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await guardWriteAccess(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This account could not be found.');

  const result = await adminUserService.forceLogout(env, logger, auth.auth.adminId, id, actionContext(request));
  if (!result.ok) return managementErrorResponse(result);

  return jsonSuccess({ loggedOut: true });
}

export async function handleUnlockAdmin(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await guardWriteAccess(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This account could not be found.');

  const result = await adminUserService.unlockAdmin(env, logger, auth.auth.adminId, id, actionContext(request));
  if (!result.ok) return managementErrorResponse(result);

  return jsonSuccess({ unlocked: true });
}

// ============================================================
// Accept-invite — public, unauthenticated. Grouped with the other
// public admin-auth flows (forgot/reset-password), not under
// /users/*, since an invitee has no session yet. Handlers live here
// (not routes/admin/auth.ts) to keep every /users/* concern in one
// file; worker/index.ts wires the paths under /api/admin/auth/*.
// ============================================================

export async function handleValidateInvite(request: Request, env: Env, logger: Logger): Promise<Response> {
  void logger;
  const token = new URL(request.url).searchParams.get('token');
  const invite = await validateInviteToken(env, token);
  if (!invite) return jsonError('INVALID_TOKEN', 'This invitation is invalid or has expired.');
  return jsonSuccess(invite);
}

export async function handleAcceptInvite(request: Request, env: Env, logger: Logger): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  const result = await acceptInvite(env, logger, body.token, body.password);
  if (!result.ok) {
    if (result.reason === 'invalid_or_expired_token') return jsonError('INVALID_TOKEN', 'This invitation is invalid or has expired.');
    if (result.reason === 'email_taken') return jsonError('EMAIL_TAKEN', 'An account with this email already exists.');
    return validationFieldsResponse(result.errors);
  }

  return jsonSuccess({ accepted: true });
}
