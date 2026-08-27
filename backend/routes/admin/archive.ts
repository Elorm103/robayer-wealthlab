/**
 * /api/admin/archive/* — Version 4.9 Phase 7 (Archive Centre). Thin
 * HTTP layer over services/admin/archiveService.ts, matching this
 * project's established routes/ convention. Read-only: nothing here
 * ever mutates data_classification or any archived record — see
 * services/admin/archiveService.ts's own header comment for the full
 * "no row ever moves" reasoning.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireCsrf } from '../../middleware/csrf';
import * as archiveService from '../../services/admin/archiveService';
import type { ApiErrorCode } from '../../types/api-contracts';

const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 500, windowSeconds: 15 * 60 };

function parseClassificationFilter(value: string | null): archiveService.ClassificationFilter {
  if (value === 'ALL' || (archiveService.CLASSIFICATIONS as readonly string[]).includes(value ?? '')) {
    return (value as archiveService.ClassificationFilter) ?? 'ALL';
  }
  return 'ALL';
}

export async function handleArchiveSummary(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const entities = archiveService.ARCHIVE_ENTITIES.map((e) => ({ key: e.key, label: e.label }));
  const summary = await archiveService.getClassificationSummary(env);
  return jsonSuccess({ entities, summary });
}

export async function handleArchiveEntityRecords(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const entityKey = params.entity ?? '';
  const searchParams = new URL(request.url).searchParams;
  const classification = parseClassificationFilter(searchParams.get('classification'));
  const limitRaw = parseInt(searchParams.get('limit') ?? '', 10);
  const offsetRaw = parseInt(searchParams.get('offset') ?? '', 10);

  const result = await archiveService.getEntityRecords(env, entityKey, classification, {
    search: searchParams.get('search'),
    limit: Number.isInteger(limitRaw) ? limitRaw : undefined,
    offset: Number.isInteger(offsetRaw) ? offsetRaw : undefined,
  });

  if (!result) return jsonError('NOT_FOUND', 'Unknown archive entity.');

  return jsonSuccess(result);
}

/** Version 4.9 Phase 8 — full-row "evidence" view plus related records for one specific record, ahead of a possible promotion decision. Read-only, same as every other handler in this file. */
export async function handleArchiveRecordDetail(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const entityKey = params.entity ?? '';
  const recordId = params.id ?? '';

  const result = await archiveService.getRecordDetail(env, entityKey, recordId);
  if (!result) return jsonError('NOT_FOUND', 'This record could not be found.');

  return jsonSuccess(result);
}

/**
 * Version 4.9 Phase 8 + 10 — the one mutation in the entire Archive
 * Centre. Reclassifies a single currently-UNKNOWN record and always
 * writes an audit_logs entry (see archiveService.promoteRecord()) —
 * never a silent change. CSRF-protected like every other admin
 * mutation in this codebase.
 */
export async function handleArchivePromoteRecord(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const entityKey = params.entity ?? '';
  const recordId = params.id ?? '';

  let body: Record<string, unknown> | null;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  const result = await archiveService.promoteRecord(env, logger, entityKey, recordId, body.classification, body.reason, auth.auth.adminId);

  if (!result.ok) {
    const responses: Record<typeof result.reason, { code: ApiErrorCode; message: string }> = {
      not_found: { code: 'NOT_FOUND', message: 'This record could not be found.' },
      not_unknown: { code: 'VALIDATION_ERROR', message: 'Only records currently classified UNKNOWN can be promoted here.' },
      invalid_classification: { code: 'VALIDATION_ERROR', message: 'classification must be one of: PRODUCTION, INTERNAL, DEVELOPMENT.' },
      missing_reason: { code: 'VALIDATION_ERROR', message: 'A reason is required for every reclassification.' },
    };
    const { code, message } = responses[result.reason];
    return jsonError(code, message);
  }

  return jsonSuccess({ promoted: true });
}
