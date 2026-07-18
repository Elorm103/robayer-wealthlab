/**
 * /api/admin/contacts/* — Version 2.0 Phase 3 (Operational Visibility).
 * See docs/v2.0-phase3-architecture-plan.md and
 * services/admin/contactService.ts (all real logic lives there; this
 * file is the thin HTTP layer only). Near-identical shape to
 * routes/admin/consultations.ts by design — same role-gating decision
 * (every endpoint, including mutations, open to all three roles; this
 * is a support workflow), same CSRF/rate-limit/validation conventions.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireCsrf } from '../../middleware/csrf';
import * as contactService from '../../services/admin/contactService';
import { isValidContactStatus } from '../../services/admin/contactService';
import { listAssignableAdmins } from '../../services/admin/consultationService';

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

export async function handleContactsMeta(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const admins = await listAssignableAdmins(env);
  return jsonSuccess({ statuses: contactService.CONTACT_STATUSES, admins });
}

export async function handleContactsList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const params = new URL(request.url).searchParams;

  const statusRaw = params.get('status');
  const status = statusRaw && isValidContactStatus(statusRaw) ? statusRaw : null;

  const assignedToRaw = params.get('assignedTo');
  const assignedTo = assignedToRaw ? parseInt(assignedToRaw, 10) : null;

  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '20', 10) || 20));

  const result = await contactService.listContacts(env, {
    search: params.get('search'),
    status,
    assignedTo: Number.isInteger(assignedTo) ? assignedTo : null,
    page,
    pageSize,
  });

  return jsonSuccess(result);
}

export async function handleContactGet(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This contact message could not be found.');

  const contact = await contactService.getContactById(env, id);
  if (!contact) return jsonError('NOT_FOUND', 'This contact message could not be found.');

  return jsonSuccess(contact);
}

export async function handleContactUpdate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This contact message could not be found.');

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  if (body.status !== undefined && !isValidContactStatus(body.status)) {
    return jsonError('VALIDATION_ERROR', 'A valid status is required.');
  }
  if (body.assignedTo !== undefined && body.assignedTo !== null && typeof body.assignedTo !== 'number') {
    return jsonError('VALIDATION_ERROR', 'assignedTo must be a number or null.');
  }

  const result = await contactService.updateContact(env, logger, auth.auth.adminId, id, {
    status: body.status as contactService.ContactStatus | undefined,
    assignedTo: body.assignedTo as number | null | undefined,
  });

  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This contact message could not be found.');
    return jsonError('VALIDATION_ERROR', 'The selected assignee could not be found.');
  }

  const updated = await contactService.getContactById(env, id);
  return jsonSuccess(updated);
}

export async function handleContactAddNote(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This contact message could not be found.');

  const body = await readJsonBody(request);
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (!note || note.length > 2000) {
    return jsonError('VALIDATION_ERROR', 'A note between 1 and 2000 characters is required.');
  }

  const result = await contactService.addContactNote(env, logger, auth.auth.adminId, auth.auth.name, id, note);
  if (!result.ok) return jsonError('NOT_FOUND', 'This contact message could not be found.');

  return jsonSuccess(result.note, 201);
}
