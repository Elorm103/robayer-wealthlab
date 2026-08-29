/**
 * /api/admin/library-learning-items* — Digital Library 2.0 Phase H
 * (Interactive Learning Experience). Thin HTTP layer only; all real
 * logic lives in services/libraryLearningAdminService.ts. Mirrors
 * routes/admin/products.ts's own auth -> role -> csrf -> rate-limit ->
 * validate -> service shape exactly.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import * as learningAdminService from '../../services/libraryLearningAdminService';
import type { LearningItemInput } from '../../services/libraryLearningAdminService';

const EDITOR_ROLES = ['super_admin', 'editor'] as const;
const WRITE_RATE_LIMIT = { endpoint: 'library-learning-items-write', limit: 60, windowSeconds: 15 * 60 };
const READ_RATE_LIMIT = { endpoint: 'library-learning-items-read', limit: 120, windowSeconds: 15 * 60 };

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

function toApiShape(record: learningAdminService.LearningItemRecord) {
  return {
    id: record.id,
    productSlug: record.productSlug,
    assetId: record.assetId,
    format: record.format,
    itemType: record.itemType,
    anchorPageNumber: record.anchorPageNumber,
    anchorCfi: record.anchorCfi,
    prompt: record.prompt,
    choices: record.choices,
    correctChoiceIndex: record.correctChoiceIndex,
    explanation: record.explanation,
    actionLabel: record.actionLabel,
    status: record.status,
    sortOrder: record.sortOrder,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Body shape is the same for create and update - a discriminated union on itemType, parsed once. */
function parseInput(body: Record<string, unknown>): LearningItemInput | null {
  if (typeof body.productSlug !== 'string' || body.productSlug.length === 0) return null;
  if (typeof body.assetId !== 'string' || body.assetId.length === 0) return null;
  if (typeof body.prompt !== 'string') return null;
  const status = body.status === 'published' ? 'published' : 'draft';
  const sortOrder = typeof body.sortOrder === 'number' ? body.sortOrder : 0;
  const anchorPageNumber = typeof body.anchorPageNumber === 'number' ? body.anchorPageNumber : null;
  const anchorCfi = typeof body.anchorCfi === 'string' ? body.anchorCfi : null;

  if (body.itemType === 'quick_check') {
    if (!Array.isArray(body.choices) || typeof body.correctChoiceIndex !== 'number' || typeof body.explanation !== 'string') return null;
    return {
      itemType: 'quick_check',
      productSlug: body.productSlug,
      assetId: body.assetId,
      anchorPageNumber,
      anchorCfi,
      prompt: body.prompt,
      choices: body.choices as string[],
      correctChoiceIndex: body.correctChoiceIndex,
      explanation: body.explanation,
      status,
      sortOrder,
    };
  }
  if (body.itemType === 'action') {
    if (typeof body.actionLabel !== 'string') return null;
    return {
      itemType: 'action',
      productSlug: body.productSlug,
      assetId: body.assetId,
      anchorPageNumber,
      anchorCfi,
      prompt: body.prompt,
      actionLabel: body.actionLabel,
      status,
      sortOrder,
    };
  }
  return null;
}

function saveResultToResponse(result: learningAdminService.SaveLearningItemResult, successStatus: number): Response {
  if (!result.ok) {
    if (result.reason === 'product_not_found') return jsonError('NOT_FOUND', 'This product could not be found.');
    if (result.reason === 'asset_not_found') return jsonError('NOT_FOUND', 'This asset could not be found or is not published.');
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This learning item could not be found.');
    return jsonError('VALIDATION_ERROR', 'Invalid learning item input.');
  }
  return jsonSuccess(toApiShape(result.record), successStatus);
}

export async function handleListLearningItems(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const url = new URL(request.url);
  const productSlug = url.searchParams.get('productSlug');
  if (!productSlug) return jsonError('VALIDATION_ERROR', 'A productSlug query parameter is required.');

  const items = await learningAdminService.listLearningItemsForProduct(env, productSlug);
  return jsonSuccess({ items: items.map(toApiShape) });
}

export async function handleCreateLearningItem(request: Request, env: Env, logger: Logger): Promise<Response> {
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
  const input = parseInput(body);
  if (!input) return jsonError('VALIDATION_ERROR', 'Invalid learning item input.');

  const result = await learningAdminService.createLearningItem(env, logger, auth.auth.adminId, input);
  return saveResultToResponse(result, 201);
}

export async function handleUpdateLearningItem(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const id = parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return jsonError('NOT_FOUND', 'This learning item could not be found.');

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');
  const input = parseInput(body);
  if (!input) return jsonError('VALIDATION_ERROR', 'Invalid learning item input.');

  const result = await learningAdminService.updateLearningItem(env, logger, auth.auth.adminId, id, input);
  return saveResultToResponse(result, 200);
}

export async function handleDeleteLearningItem(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const id = parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return jsonError('NOT_FOUND', 'This learning item could not be found.');

  const result = await learningAdminService.deleteLearningItem(env, logger, auth.auth.adminId, id);
  if (!result.ok) return jsonError('NOT_FOUND', 'This learning item could not be found.');
  return jsonSuccess({ deleted: true });
}
