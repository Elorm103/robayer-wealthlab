/**
 * GET /api/purchases/:reference and
 * POST /api/purchases/:reference/downloads — see
 * docs/digital-fulfilment.md and docs/worker-api-design.md. Thin HTTP
 * layer only: parses/validates the request, calls
 * services/fulfilmentService.ts and services/entitlementService.ts for
 * all business logic. No D1 write happens directly in this file — see
 * backend/routes/README.md's "routes stay thin" rule.
 *
 * The fulfilment page (checkout/callback/index.html) is these two
 * routes' only real consumer: the GET tells it what to show; the POST
 * is what the page's Download button actually calls.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonError, jsonSuccess } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';
import { getFulfilmentStatus } from '../services/fulfilmentService';
import { generateDownloadPermission } from '../services/entitlementService';

const REFERENCE_PATTERN = /^RWL-\d{4}-\d{6,}$/;

function isPlausibleReference(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value);
}

const STATUS_RATE_LIMIT = { endpoint: 'purchases-status', limit: 20, windowSeconds: 60 };

export async function handleGetPurchaseStatus(request: Request, env: Env, logger: Logger, params: Record<string, string | undefined>): Promise<Response> {
  if (await isRateLimited(request, env, STATUS_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again in a minute.');
  }

  const reference = params.reference;
  if (!isPlausibleReference(reference)) {
    return jsonError('PURCHASE_NOT_FOUND', 'This purchase could not be found.');
  }

  const status = await getFulfilmentStatus(env, reference);
  if (!status) {
    return jsonError('PURCHASE_NOT_FOUND', 'This purchase could not be found.');
  }

  // Only ever returns the customer-facing shape from
  // getFulfilmentStatus() — no internal ids, no raw purchase_sessions
  // status vocabulary. See docs/digital-fulfilment.md's "Security."
  return jsonSuccess(status);
}

// Slightly more generous than checkout's own rate limit (10/min) since
// a visitor legitimately re-requesting a download for a second device
// or after closing a browser tab is normal, expected behavior, not
// abuse — the real defense against abuse is the entitlement check
// itself, not this limit. See docs/digital-fulfilment.md's "Security."
const DOWNLOAD_REQUEST_RATE_LIMIT = { endpoint: 'purchases-download', limit: 20, windowSeconds: 60 };

interface RequestDownloadBody {
  assetId?: unknown;
}

export async function handleRequestDownload(request: Request, env: Env, logger: Logger, params: Record<string, string | undefined>): Promise<Response> {
  if (await isRateLimited(request, env, DOWNLOAD_REQUEST_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again in a minute.');
  }

  const reference = params.reference;
  if (!isPlausibleReference(reference)) {
    return jsonError('PURCHASE_NOT_FOUND', 'This purchase could not be found.');
  }

  let body: RequestDownloadBody;
  try {
    body = await request.json();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.');
  }

  if (typeof body.assetId !== 'string' || body.assetId.length === 0) {
    return jsonError('VALIDATION_ERROR', 'A valid assetId is required.');
  }

  const result = await generateDownloadPermission(env, logger, reference, body.assetId);
  if (!result.granted) {
    // Every EntitlementDenialReason maps to the same generic message —
    // never reveals which specific check failed. See
    // entitlementService.ts's own doc comment on this.
    return jsonError('DOWNLOAD_NOT_AVAILABLE', "This download isn't available right now.");
  }

  return jsonSuccess({ downloadUrl: `/api/download/${result.token}`, expiresAt: result.expiresAt });
}
