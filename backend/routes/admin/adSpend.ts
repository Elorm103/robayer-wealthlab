/**
 * /api/admin/ad-spend/* — P0-B (Business Intelligence backbone, first
 * component). Thin HTTP layer only; all real logic lives in
 * services/admin/adSpendService.ts.
 *
 * Role gating: viewing (list) is open to every authenticated role;
 * every mutation (create, update, delete) requires `editor` or
 * `super_admin` — ad spend is financial data feeding a future
 * profitability calculation, the same reasoning routes/admin/coupons.ts
 * already applies to its own financial-discount instrument.
 *
 * This route (and adSpendService.ts) is a ledger only — it does not
 * compute or expose CPA, ROAS, or any attribution. See the P0-B
 * investigation for why that isn't possible yet.
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
  listAdSpendEntries,
  createAdSpendEntry,
  updateAdSpendEntry,
  softDeleteAdSpendEntry,
} from '../../services/admin/adSpendService';

const EDITOR_ROLES = ['super_admin', 'editor'] as const;

const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 120, windowSeconds: 15 * 60 };
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

export async function handleAdminAdSpendList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const params = new URL(request.url).searchParams;
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '20', 10) || 20));

  const result = await listAdSpendEntries(env, page, pageSize);
  return jsonSuccess(result);
}

export async function handleAdminAdSpendCreate(request: Request, env: Env, logger: Logger): Promise<Response> {
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

  const result = await createAdSpendEntry(env, logger, auth.auth.adminId, {
    entryDate: body.entryDate as string,
    source: body.source as 'meta' | 'google' | 'linkedin' | 'other',
    campaignLabel: body.campaignLabel as string,
    amountMinorUnits: body.amountMinorUnits as number,
    currency: typeof body.currency === 'string' ? body.currency.toUpperCase() : (body.currency as string),
    notes: typeof body.notes === 'string' && body.notes.trim().length > 0 ? body.notes.trim() : null,
  });

  if (!result.ok) {
    return jsonError('VALIDATION_ERROR', 'A valid entryDate (YYYY-MM-DD), source, campaignLabel, amountMinorUnits (whole number ≥ 0), and currency (3-letter code) are required.');
  }

  return jsonSuccess({ id: result.id }, 201);
}

export async function handleAdminAdSpendUpdate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
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
  if (id === null) return jsonError('NOT_FOUND', 'This spend entry could not be found.');

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  const result = await updateAdSpendEntry(env, logger, auth.auth.adminId, id, {
    entryDate: body.entryDate as string | undefined,
    source: body.source as 'meta' | 'google' | 'linkedin' | 'other' | undefined,
    campaignLabel: body.campaignLabel as string | undefined,
    amountMinorUnits: body.amountMinorUnits as number | undefined,
    currency: typeof body.currency === 'string' ? body.currency.toUpperCase() : (body.currency as string | undefined),
    notes: body.notes === undefined ? undefined : (body.notes as string | null),
  });

  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This spend entry could not be found.');
    return jsonError('VALIDATION_ERROR', 'Invalid spend entry details.');
  }

  return jsonSuccess({ updated: true });
}

export async function handleAdminAdSpendDelete(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
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
  if (id === null) return jsonError('NOT_FOUND', 'This spend entry could not be found.');

  const result = await softDeleteAdSpendEntry(env, logger, auth.auth.adminId, id);
  if (!result.ok) return jsonError('NOT_FOUND', 'This spend entry could not be found.');

  return jsonSuccess({ deleted: true });
}
