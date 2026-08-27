/**
 * /api/admin/knowledge-base/* — Version 5.0 Milestone 2 (Knowledge
 * Base). Thin HTTP layer only; real logic lives in
 * services/knowledge/* (indexing/search) and
 * services/admin/knowledgeBaseAdminService.ts (dashboard aggregation).
 *
 * super_admin only, matching the posture already established for the
 * AI Gateway's own Settings/AI Usage sections — this is cost-bearing
 * (every re-index makes real embedding calls) and operationally
 * sensitive in the same way.
 *
 * "Background indexing": handleReindex/handleRebuild return
 * immediately via `ctx.waitUntil()` — the actual run continues after
 * the HTTP response, tracked in `knowledge_indexing_runs` and polled
 * by the dashboard (handleGetRuns) — the same fire-and-continue
 * pattern this project's Cron Trigger already uses, not a new
 * mechanism.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import { getKnowledgeBaseStatus, listKnowledgeDocuments, listIndexingRuns, getEmbeddingVersionSummary, listDeadLetters } from '../../services/admin/knowledgeBaseAdminService';
import { getSearchAnalytics } from '../../services/admin/knowledgeSearchAnalyticsService';
import { planIncrementalIndex, planFullRebuild, retryDeadLetter } from '../../services/knowledge/indexingService';
import { searchKnowledge } from '../../services/knowledge/searchService';
import * as auditService from '../../services/admin/auditService';

const SUPER_ADMIN_ONLY = ['super_admin'] as const;
const READ_RATE_LIMIT = { endpoint: 'admin-ops-read', limit: 500, windowSeconds: 15 * 60 };
const WRITE_RATE_LIMIT = { endpoint: 'admin-ops-write', limit: 20, windowSeconds: 15 * 60 };

async function gateRead(request: Request, env: Env, logger: Logger) {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return { ok: false as const, response: auth.response };
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return { ok: false as const, response: roleFailure };
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return { ok: false as const, response: jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.') };
  }
  return { ok: true as const, auth };
}

export async function handleGetStatus(request: Request, env: Env, logger: Logger): Promise<Response> {
  const gated = await gateRead(request, env, logger);
  if (!gated.ok) return gated.response;

  const status = await getKnowledgeBaseStatus(env);
  return jsonSuccess(status);
}

export async function handleListDocuments(request: Request, env: Env, logger: Logger): Promise<Response> {
  const gated = await gateRead(request, env, logger);
  if (!gated.ok) return gated.response;

  const params = new URL(request.url).searchParams;
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '25', 10) || 25));
  const status = params.get('status');
  const sourceType = params.get('sourceType');

  const result = await listKnowledgeDocuments(
    env,
    {
      status: status === 'pending' || status === 'indexed' || status === 'failed' ? status : undefined,
      sourceType: (sourceType as any) || undefined,
      search: params.get('search') ?? undefined,
    },
    page,
    pageSize
  );
  return jsonSuccess(result);
}

export async function handleGetRuns(request: Request, env: Env, logger: Logger): Promise<Response> {
  const gated = await gateRead(request, env, logger);
  if (!gated.ok) return gated.response;

  const params = new URL(request.url).searchParams;
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(params.get('pageSize') ?? '10', 10) || 10));

  const result = await listIndexingRuns(env, page, pageSize);
  return jsonSuccess(result);
}

async function triggerRun(request: Request, env: Env, logger: Logger, ctx: ExecutionContext, runType: 'incremental' | 'full_rebuild'): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  // Version 5.0 Milestone 2.1 — planIncrementalIndex/planFullRebuild
  // only run the lightweight PLANNING phase (gather, hash-compare,
  // enqueue) inside this ctx.waitUntil() job; actual indexing happens
  // across however many separate queue-consumer invocations it takes
  // to drain, tracked in knowledge_indexing_runs' own
  // documents_enqueued/documents_resolved columns and polled by the
  // dashboard (handleGetRuns) — see indexingService.ts's header comment
  // for why this replaced the original single-invocation design.
  const planner = runType === 'incremental' ? planIncrementalIndex : planFullRebuild;
  const adminId = auth.auth.adminId;

  ctx.waitUntil(
    planner(env, logger, adminId)
      .then((summary) =>
        auditService.record(env, logger, {
          actorType: 'admin',
          actorId: adminId,
          action: `knowledge_base.${runType}_planned`,
          entityType: 'knowledge_indexing_run',
          entityId: summary.runId,
          metadata: {
            documentsSeen: summary.documentsSeen,
            documentsUnchanged: summary.documentsUnchanged,
            documentsFailedAtPlanning: summary.documentsFailedAtPlanning,
            documentsEnqueued: summary.documentsEnqueued,
          },
        })
      )
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('knowledge_base.run_failed', { runType, error: message });
        return auditService.record(env, logger, {
          actorType: 'admin',
          actorId: adminId,
          action: `knowledge_base.${runType}_failed`,
          entityType: 'knowledge_indexing_run',
          entityId: null,
          metadata: { error: message },
        });
      })
  );

  return jsonSuccess({ started: true, runType });
}

export async function handleReindex(request: Request, env: Env, logger: Logger, params: RouteParams, ctx: ExecutionContext): Promise<Response> {
  return triggerRun(request, env, logger, ctx, 'incremental');
}

export async function handleRebuild(request: Request, env: Env, logger: Logger, params: RouteParams, ctx: ExecutionContext): Promise<Response> {
  return triggerRun(request, env, logger, ctx, 'full_rebuild');
}

export async function handleGetSearchAnalytics(request: Request, env: Env, logger: Logger): Promise<Response> {
  const gated = await gateRead(request, env, logger);
  if (!gated.ok) return gated.response;

  const analytics = await getSearchAnalytics(env);
  return jsonSuccess(analytics);
}

export async function handleGetEmbeddingVersions(request: Request, env: Env, logger: Logger): Promise<Response> {
  const gated = await gateRead(request, env, logger);
  if (!gated.ok) return gated.response;

  const groups = await getEmbeddingVersionSummary(env);
  return jsonSuccess({ groups });
}

export async function handleListDeadLetters(request: Request, env: Env, logger: Logger): Promise<Response> {
  const gated = await gateRead(request, env, logger);
  if (!gated.ok) return gated.response;

  const params = new URL(request.url).searchParams;
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(params.get('pageSize') ?? '25', 10) || 25));

  const result = await listDeadLetters(env, page, pageSize);
  return jsonSuccess(result);
}

export async function handleRetryDeadLetter(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const deadLetterId = parseInt(params.id ?? '', 10);
  if (!Number.isInteger(deadLetterId)) {
    return jsonError('VALIDATION_ERROR', 'Invalid dead letter id.');
  }

  const result = await retryDeadLetter(env, logger, deadLetterId, auth.auth.adminId);
  if (!result.ok) {
    return jsonError('VALIDATION_ERROR', result.reason ?? 'Could not retry this dead letter.');
  }

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId: auth.auth.adminId,
    action: 'knowledge_base.dead_letter_retried',
    entityType: 'knowledge_indexing_dead_letter',
    entityId: deadLetterId,
    metadata: {},
  });

  return jsonSuccess({ retried: true });
}

export async function handleSearchTest(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  let body: { query?: unknown; visibility?: unknown; limit?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Invalid request body.');
  }
  if (typeof body.query !== 'string' || body.query.trim().length === 0) {
    return jsonError('VALIDATION_ERROR', 'query is required.');
  }

  try {
    const result = await searchKnowledge(env, logger, {
      query: body.query,
      visibility: body.visibility === 'admin_only' ? 'admin_only' : 'public',
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      actorType: 'admin',
      actorId: auth.auth.adminId,
    });
    return jsonSuccess(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown search error';
    return jsonError('AI_GATEWAY_ERROR', message);
  }
}
