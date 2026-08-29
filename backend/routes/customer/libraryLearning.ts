/**
 * GET /api/customer/purchases/:reference/learning-items,
 * POST /api/customer/purchases/:reference/learning-items/:itemId/response
 * — Digital Library 2.0 Phase H (Interactive Learning Experience). Thin
 * HTTP layer only; all real logic lives in
 * services/customer/libraryLearningService.ts. Mirrors
 * routes/customer/libraryAi.ts's own shape (a dedicated file per
 * distinct feature, not folded into purchases.ts).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireCustomerAuth } from '../../middleware/requireCustomerAuth';
import { listLearningItemsForAsset, submitLearningResponse, type SubmitLearningResponseInput } from '../../services/customer/libraryLearningService';

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(response.body, { status: response.status, headers });
}

const REFERENCE_PATTERN = /^RWL-\d{4}-\d{6,}$/;
function isPlausibleReference(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value);
}

const READ_RATE_LIMIT = { endpoint: 'customer-library-learning-read', limit: 60, windowSeconds: 15 * 60 };
const RESPONSE_WRITE_RATE_LIMIT = { endpoint: 'customer-library-learning-response-write', limit: 60, windowSeconds: 15 * 60 };

export async function handleListLearningItems(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const reference = params.reference;
  if (!isPlausibleReference(reference)) {
    return withNoStore(jsonError('NOT_FOUND', 'This purchase could not be found.'));
  }

  const url = new URL(request.url);
  const assetId = url.searchParams.get('assetId');
  if (!assetId) {
    return withNoStore(jsonError('VALIDATION_ERROR', 'An assetId query parameter is required.'));
  }

  const items = await listLearningItemsForAsset(env, auth.auth.customerId, reference, assetId);
  return withNoStore(jsonSuccess({ items }));
}

interface SubmitResponseBody {
  itemType?: unknown;
  selectedChoiceIndex?: unknown;
  actionDone?: unknown;
}

export async function handleSubmitLearningResponse(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, RESPONSE_WRITE_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const reference = params.reference;
  if (!isPlausibleReference(reference)) {
    return withNoStore(jsonError('NOT_FOUND', 'This purchase could not be found.'));
  }
  const itemId = parseInt(params.itemId ?? '', 10);
  if (!Number.isInteger(itemId)) {
    return withNoStore(jsonError('NOT_FOUND', 'This learning item could not be found.'));
  }

  const url = new URL(request.url);
  const assetId = url.searchParams.get('assetId');
  if (!assetId) {
    return withNoStore(jsonError('VALIDATION_ERROR', 'An assetId query parameter is required.'));
  }

  let body: SubmitResponseBody;
  try {
    body = await request.json();
  } catch {
    return withNoStore(jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.'));
  }

  let input: SubmitLearningResponseInput;
  if (body.itemType === 'quick_check') {
    if (typeof body.selectedChoiceIndex !== 'number') {
      return withNoStore(jsonError('VALIDATION_ERROR', 'selectedChoiceIndex is required for a quick_check response.'));
    }
    input = { itemType: 'quick_check', selectedChoiceIndex: body.selectedChoiceIndex };
  } else if (body.itemType === 'action') {
    if (typeof body.actionDone !== 'boolean') {
      return withNoStore(jsonError('VALIDATION_ERROR', 'actionDone is required for an action response.'));
    }
    input = { itemType: 'action', actionDone: body.actionDone };
  } else {
    return withNoStore(jsonError('VALIDATION_ERROR', 'itemType must be "quick_check" or "action".'));
  }

  const result = await submitLearningResponse(env, logger, auth.auth.customerId, reference, assetId, itemId, input);
  if (!result.ok) {
    if (result.reason === 'not_authorized') return withNoStore(jsonError('NOT_FOUND', 'This resource could not be found.'));
    if (result.reason === 'not_found') return withNoStore(jsonError('NOT_FOUND', 'This learning item could not be found.'));
    if (result.reason === 'item_type_mismatch') return withNoStore(jsonError('VALIDATION_ERROR', 'itemType does not match this learning item.'));
    return withNoStore(jsonError('VALIDATION_ERROR', 'Invalid response.'));
  }

  return withNoStore(jsonSuccess(result));
}
