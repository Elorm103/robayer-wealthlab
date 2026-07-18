/**
 * /api/admin/consultations/* — Version 2.0 Phase 3 (Operational
 * Visibility). See docs/v2.0-phase3-architecture-plan.md and
 * services/admin/consultationService.ts (all real logic lives there;
 * this file is the thin HTTP layer only, per this project's established
 * routes/ convention — see routes/admin/products.ts).
 *
 * Role gating: every endpoint here — including status/assignee updates
 * and notes — is open to all three authenticated roles (super_admin,
 * editor, support). This is a deliberate departure from Products'
 * editor-only-writes convention: Consultation Manager is fundamentally
 * a support workflow, and restricting a support-role admin from
 * changing a status or leaving a note would defeat the point of having
 * that role at all — see the architecture plan's "User stories" and
 * "Admin interface" sections for the full reasoning.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireCsrf } from '../../middleware/csrf';
import * as consultationService from '../../services/admin/consultationService';
import { isValidConsultationStatus } from '../../services/admin/consultationService';

const WRITE_RATE_LIMIT = { endpoint: 'admin-ops-write', limit: 60, windowSeconds: 15 * 60 };
const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 120, windowSeconds: 15 * 60 };

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

export async function handleConsultationsMeta(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const admins = await consultationService.listAssignableAdmins(env);
  return jsonSuccess({ statuses: consultationService.CONSULTATION_STATUSES, admins });
}

export async function handleConsultationsList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const params = new URL(request.url).searchParams;

  const statusRaw = params.get('status');
  const status = statusRaw && isValidConsultationStatus(statusRaw) ? statusRaw : null;

  const assignedToRaw = params.get('assignedTo');
  const assignedTo = assignedToRaw ? parseInt(assignedToRaw, 10) : null;

  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '20', 10) || 20));

  const result = await consultationService.listConsultations(env, {
    search: params.get('search'),
    status,
    category: params.get('category'),
    assignedTo: Number.isInteger(assignedTo) ? assignedTo : null,
    page,
    pageSize,
  });

  return jsonSuccess(result);
}

export async function handleConsultationGet(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This consultation request could not be found.');

  const consultation = await consultationService.getConsultationById(env, id);
  if (!consultation) return jsonError('NOT_FOUND', 'This consultation request could not be found.');

  return jsonSuccess(consultation);
}

export async function handleConsultationUpdate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This consultation request could not be found.');

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  if (body.status !== undefined && !isValidConsultationStatus(body.status)) {
    return jsonError('VALIDATION_ERROR', 'A valid status is required.');
  }
  if (body.assignedTo !== undefined && body.assignedTo !== null && typeof body.assignedTo !== 'number') {
    return jsonError('VALIDATION_ERROR', 'assignedTo must be a number or null.');
  }

  const result = await consultationService.updateConsultation(env, logger, auth.auth.adminId, id, {
    status: body.status as consultationService.ConsultationStatus | undefined,
    assignedTo: body.assignedTo as number | null | undefined,
  });

  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This consultation request could not be found.');
    return jsonError('VALIDATION_ERROR', 'The selected assignee could not be found.');
  }

  const updated = await consultationService.getConsultationById(env, id);
  return jsonSuccess(updated);
}

export async function handleConsultationAddNote(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This consultation request could not be found.');

  const body = await readJsonBody(request);
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (!note || note.length > 2000) {
    return jsonError('VALIDATION_ERROR', 'A note between 1 and 2000 characters is required.');
  }

  const result = await consultationService.addConsultationNote(env, logger, auth.auth.adminId, auth.auth.name, id, note);
  if (!result.ok) return jsonError('NOT_FOUND', 'This consultation request could not be found.');

  return jsonSuccess(result.note, 201);
}
