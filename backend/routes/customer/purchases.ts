/**
 * GET /api/customer/purchases, GET /api/customer/purchases/:reference,
 * GET /api/customer/receipts, GET /api/customer/receipts/:receiptNumber/download,
 * GET /api/customer/licenses - Version 3.0.2 Milestone M2 (Orders,
 * Receipts & Customer Library). See
 * docs/v3.0.2-m2-api-planning-report.md.
 *
 * Thin HTTP layer only, per this project's established routes/
 * convention: parses the request, calls
 * services/customer/purchaseHistoryService.ts /
 * services/orders/receiptPdfService.ts for all real logic, formats the
 * response. Every route requires `requireCustomerAuth` - this is the
 * Customer Library's data layer, not a guest-accessible surface (that
 * lives separately, see routes/purchases.ts's reference-scoped
 * endpoints, extended in Milestone M2 for guest receipt download).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireCustomerAuth } from '../../middleware/requireCustomerAuth';
import {
  listCustomerPurchases,
  getCustomerPurchase,
  listCustomerReceipts,
  findOwnedReceiptId,
  listCustomerLicenses,
} from '../../services/customer/purchaseHistoryService';
import { getOrCreateReceiptPdf } from '../../services/orders/receiptPdfService';

const REFERENCE_PATTERN = /^RWL-\d{4}-\d{6,}$/;
const RECEIPT_NUMBER_PATTERN = /^RWL-RCT-\d{4}-\d{6,}$/;

function isPlausibleReference(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value);
}

function isPlausibleReceiptNumber(value: unknown): value is string {
  return typeof value === 'string' && RECEIPT_NUMBER_PATTERN.test(value);
}

/** Same reasoning as routes/customer/auth.ts's own withNoStore() - these responses carry customer-specific financial/purchase data, never cacheable. Redeclared here rather than imported, matching this codebase's established direct-mirroring convention over cross-file helper sharing for a two-line function. */
function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(response.body, { status: response.status, headers });
}

const READ_RATE_LIMIT = { endpoint: 'customer-purchases-read', limit: 60, windowSeconds: 15 * 60 };
const DOWNLOAD_RATE_LIMIT = { endpoint: 'customer-receipt-download', limit: 20, windowSeconds: 15 * 60 };

export async function handleListCustomerPurchases(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') ?? '1', 10);
  const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
  if (url.searchParams.has('page') && (!Number.isInteger(page) || page < 1)) {
    return withNoStore(jsonError('VALIDATION_ERROR', 'page must be a positive integer.'));
  }
  if (url.searchParams.has('limit') && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
    return withNoStore(jsonError('VALIDATION_ERROR', 'limit must be a positive integer no greater than 50.'));
  }

  const result = await listCustomerPurchases(env, auth.auth.customerId, page, limit);
  return withNoStore(jsonSuccess(result));
}

export async function handleGetCustomerPurchase(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const reference = params.reference;
  if (!isPlausibleReference(reference)) {
    return withNoStore(jsonError('NOT_FOUND', 'This purchase could not be found.'));
  }

  // Same-shape NOT_FOUND whether the reference genuinely doesn't exist
  // or belongs to a different customer - never a distinct signal. See
  // purchaseHistoryService.ts's own header comment.
  const purchase = await getCustomerPurchase(env, auth.auth.customerId, reference);
  if (!purchase) return withNoStore(jsonError('NOT_FOUND', 'This purchase could not be found.'));

  return withNoStore(jsonSuccess(purchase));
}

export async function handleListCustomerReceipts(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const receipts = await listCustomerReceipts(env, auth.auth.customerId);
  return withNoStore(jsonSuccess({ receipts }));
}

export async function handleDownloadCustomerReceipt(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, DOWNLOAD_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const receiptNumber = params.receiptNumber;
  if (!isPlausibleReceiptNumber(receiptNumber)) {
    return withNoStore(jsonError('RECEIPT_NOT_FOUND', 'This receipt could not be found.'));
  }

  const receiptId = await findOwnedReceiptId(env, auth.auth.customerId, receiptNumber);
  if (!receiptId) return withNoStore(jsonError('RECEIPT_NOT_FOUND', 'This receipt could not be found.'));

  const storageKey = await getOrCreateReceiptPdf(env, logger, receiptId);
  if (!storageKey) {
    return withNoStore(jsonError('ASSET_UNAVAILABLE', 'This receipt is temporarily unavailable. Please try again shortly.'));
  }

  const object = await env.STORAGE.get(storageKey);
  if (!object) {
    logger.error('receipt.object_not_found_in_storage', { storageKey, receiptId });
    return withNoStore(jsonError('ASSET_UNAVAILABLE', 'This receipt is temporarily unavailable. Please try again shortly.'));
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${receiptNumber}.pdf"`,
      'Content-Length': String(object.size),
      'Cache-Control': 'no-store',
    },
  });
}

export async function handleListCustomerLicenses(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const licenses = await listCustomerLicenses(env, auth.auth.customerId);
  return withNoStore(jsonSuccess({ licenses }));
}
