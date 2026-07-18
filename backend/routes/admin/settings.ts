/**
 * /api/admin/settings/* — Version 2.1 Phase 5 (Settings). See
 * docs/v2.1-phase5-design.md. Thin HTTP layer only, per this
 * project's established routes/ convention — all real logic lives in
 * `services/admin/settingsService.ts`.
 *
 * Every route here requires `super_admin` — reads as well as writes,
 * the same posture Phase 4's Users module already established, for
 * the same reason: payment/email operational data and the ability to
 * flip maintenance mode are not general content `editor`/`support`
 * need visibility into.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import * as settingsService from '../../services/admin/settingsService';

const SUPER_ADMIN_ONLY = ['super_admin'] as const;

function actionContext(request: Request) {
  return { ip: request.headers.get('CF-Connecting-IP'), userAgent: request.headers.get('User-Agent') };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

function validationErrorResponse(errors: settingsService.SettingsValidationError[]): Response {
  const body = { success: false, error: { code: 'VALIDATION_ERROR', message: errors[0]?.message ?? 'Validation failed.' }, fields: errors };
  return new Response(JSON.stringify(body), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

export async function handleGetSettings(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;

  const settings = await settingsService.getEditableSettings(env);
  return jsonSuccess(settings);
}

export async function handleUpdateSettings(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  const result = await settingsService.updateSettings(env, logger, auth.auth.adminId, body, actionContext(request));
  if (!result.ok) return validationErrorResponse(result.errors);

  return jsonSuccess({ updated: true });
}

export async function handleSettingsStatus(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;

  const status = await settingsService.getSettingsStatus(env, request);
  return jsonSuccess(status);
}
