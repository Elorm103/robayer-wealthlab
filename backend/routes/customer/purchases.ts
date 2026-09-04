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
import { getLibraryRecommendations } from '../../services/customer/libraryRecommendationsService';
import { upsertLibraryProgress, getLibraryProgress, listLibraryProgress } from '../../services/customer/libraryProgressService';
import { createBookmark, listBookmarksForAsset, listAllBookmarks, deleteBookmark } from '../../services/customer/libraryBookmarkService';
import { createReaderSession, reverifyEntitlementForDelivery } from '../../services/readerSessionService';
import { getPdfPageCount } from '../../services/pdfPageService';
import { getEpubManifest } from '../../services/epubChapterService';
import { fetchCatalogProduct, findPublishedAsset } from '../../services/productCatalogService';
import { isControlledReaderEnabled } from '../../services/admin/settingsService';

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
// Digital Library Phase 7B — generous enough for a debounced reader
// (roughly one write per page turn, itself already debounced client-
// side to ~1 per few seconds) without being an open door for scripted
// abuse of a write endpoint.
const PROGRESS_WRITE_RATE_LIMIT = { endpoint: 'customer-library-progress-write', limit: 60, windowSeconds: 5 * 60 };
// Digital Library 2.0 — a bookmark is a deliberate, occasional customer
// action (not a per-page-turn signal like progress), so a much tighter
// limit than PROGRESS_WRITE_RATE_LIMIT is still generous for real use.
const BOOKMARK_WRITE_RATE_LIMIT = { endpoint: 'customer-library-bookmark-write', limit: 30, windowSeconds: 15 * 60 };

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

/**
 * Digital Library Modernization (Phase 5) — "Continue your learning."
 * See services/customer/libraryRecommendationsService.ts's own header
 * comment for the full reasoning: reads the existing, admin-curated
 * product_relations table, scoped to what this authenticated customer
 * actually owns, never a client-supplied product list.
 */
export async function handleGetLibraryRecommendations(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const recommendations = await getLibraryRecommendations(env, auth.auth.customerId);
  return withNoStore(jsonSuccess({ recommendations }));
}

// ============================================================
// Digital Library Phase 7B (Personal Reading Experience) — real,
// persisted reading position. Every handler below requires
// requireCustomerAuth (unlike routes/purchases.ts's reference-scoped
// Download/Read endpoints) — see libraryProgressService.ts's own
// header comment on why progress specifically needs a bound identity.
// Ownership is re-verified inside the service layer via
// entitlementService.ts's checkEntitlement(..., customerId) on every
// call, never assumed from the URL alone.
// ============================================================

interface UpsertProgressBody {
  assetId?: unknown;
  currentPage?: unknown;
  totalPages?: unknown;
  cfi?: unknown;
  percentComplete?: unknown;
}

export async function handleUpsertLibraryProgress(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, PROGRESS_WRITE_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const reference = params.reference;
  if (!isPlausibleReference(reference)) {
    return withNoStore(jsonError('NOT_FOUND', 'This purchase could not be found.'));
  }

  let body: UpsertProgressBody;
  try {
    body = await request.json();
  } catch {
    return withNoStore(jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.'));
  }

  if (typeof body.assetId !== 'string' || body.assetId.length === 0) {
    return withNoStore(jsonError('VALIDATION_ERROR', 'A valid assetId is required.'));
  }

  // Phase Library-2.0 — EPUB reports {cfi, percentComplete} instead of
  // {currentPage, totalPages} (see ProgressInput's own doc comment for
  // why); whichever shape is present in the body decides which the
  // service validates against — never both, never neither.
  let input: Parameters<typeof upsertLibraryProgress>[5];
  if (typeof body.cfi === 'string') {
    if (typeof body.percentComplete !== 'number') {
      return withNoStore(jsonError('VALIDATION_ERROR', 'percentComplete must be a number when cfi is provided.'));
    }
    input = { format: 'EPUB', cfi: body.cfi, percentComplete: body.percentComplete };
  } else if (typeof body.currentPage === 'number' && typeof body.totalPages === 'number') {
    input = { format: 'PDF', currentPage: body.currentPage, totalPages: body.totalPages };
  } else {
    return withNoStore(jsonError('VALIDATION_ERROR', 'Either {cfi, percentComplete} or {currentPage, totalPages} is required.'));
  }

  const result = await upsertLibraryProgress(env, logger, auth.auth.customerId, reference, body.assetId, input);

  if (!result.ok) {
    // Same generic-message discipline as the rest of this file (see
    // handleGetCustomerPurchase's own comment) — never reveals whether
    // the reference doesn't exist, belongs to another customer, or the
    // asset simply isn't a supported format.
    if (result.reason === 'invalid_input') return withNoStore(jsonError('VALIDATION_ERROR', 'currentPage must be between 1 and totalPages.'));
    if (result.reason === 'unsupported_format') return withNoStore(jsonError('UNSUPPORTED_FILE_TYPE', 'Reading progress is not tracked for this file type yet.'));
    return withNoStore(jsonError('NOT_FOUND', 'This resource could not be found.'));
  }

  return withNoStore(jsonSuccess(result.record));
}

export async function handleGetLibraryProgress(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
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

  const record = await getLibraryProgress(env, auth.auth.customerId, reference, assetId);
  // Genuinely absent progress is not an error - a customer opening a
  // resource for the first time has none yet. { progress: null } is
  // the honest, expected shape, not a 404.
  return withNoStore(jsonSuccess({ progress: record }));
}

export async function handleListLibraryProgress(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const progress = await listLibraryProgress(env, auth.auth.customerId);
  return withNoStore(jsonSuccess({ progress }));
}

// ============================================================
// Bookmarks — Digital Library 2.0, Feature 5. Same authorization
// discipline as the progress endpoints just above (requireCustomerAuth
// + a real, re-verified checkEntitlement inside the service layer,
// never trusted from the URL/body alone).
// ============================================================

interface CreateBookmarkBody {
  assetId?: unknown;
  pageNumber?: unknown;
  cfi?: unknown;
  label?: unknown;
}

export async function handleCreateBookmark(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, BOOKMARK_WRITE_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const reference = params.reference;
  if (!isPlausibleReference(reference)) {
    return withNoStore(jsonError('NOT_FOUND', 'This purchase could not be found.'));
  }

  let body: CreateBookmarkBody;
  try {
    body = await request.json();
  } catch {
    return withNoStore(jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.'));
  }

  if (typeof body.assetId !== 'string' || body.assetId.length === 0) {
    return withNoStore(jsonError('VALIDATION_ERROR', 'A valid assetId is required.'));
  }
  const label = typeof body.label === 'string' && body.label.length > 0 ? body.label : null;

  let input: Parameters<typeof createBookmark>[5];
  if (typeof body.cfi === 'string') {
    input = { format: 'EPUB', cfi: body.cfi, label };
  } else if (typeof body.pageNumber === 'number') {
    input = { format: 'PDF', pageNumber: body.pageNumber, label };
  } else {
    return withNoStore(jsonError('VALIDATION_ERROR', 'Either cfi or pageNumber is required.'));
  }

  const result = await createBookmark(env, logger, auth.auth.customerId, reference, body.assetId, input);
  if (!result.ok) {
    if (result.reason === 'invalid_input') return withNoStore(jsonError('VALIDATION_ERROR', 'Invalid bookmark input.'));
    if (result.reason === 'unsupported_format') return withNoStore(jsonError('UNSUPPORTED_FILE_TYPE', 'This bookmark format does not match the asset.'));
    return withNoStore(jsonError('NOT_FOUND', 'This resource could not be found.'));
  }

  return withNoStore(jsonSuccess(result.record, 201));
}

export async function handleListBookmarksForAsset(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
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

  const bookmarks = await listBookmarksForAsset(env, auth.auth.customerId, reference, assetId);
  return withNoStore(jsonSuccess({ bookmarks }));
}

export async function handleListAllBookmarks(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const bookmarks = await listAllBookmarks(env, auth.auth.customerId);
  return withNoStore(jsonSuccess({ bookmarks }));
}

export async function handleDeleteBookmark(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, BOOKMARK_WRITE_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const bookmarkId = parseInt(params.id ?? '', 10);
  if (!Number.isInteger(bookmarkId)) {
    return withNoStore(jsonError('NOT_FOUND', 'This bookmark could not be found.'));
  }

  const result = await deleteBookmark(env, auth.auth.customerId, bookmarkId);
  if (!result.ok) return withNoStore(jsonError('NOT_FOUND', 'This bookmark could not be found.'));

  return withNoStore(jsonSuccess({ deleted: true }));
}

// ============================================================
// Controlled Library Reader, Phase 2 - Reader Session. Customer-auth-
// gated, same discipline as progress/bookmarks above: entitlement is
// re-verified inside readerSessionService.createReaderSession() via
// checkEntitlement(..., customerId), never trusted from the URL/body
// alone. The actual page/chapter content endpoints (routes/reader.ts)
// are session-token-scoped, not cookie-scoped - this is the one place
// a customer cookie is required in the whole controlled-reader flow.
// ============================================================

const READER_SESSION_RATE_LIMIT = { endpoint: 'customer-reader-session', limit: 20, windowSeconds: 60 };

interface RequestReaderSessionBody {
  assetId?: unknown;
  deviceFingerprint?: unknown;
}

export async function handleRequestReaderSession(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, READER_SESSION_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const reference = params.reference;
  if (!isPlausibleReference(reference)) {
    return withNoStore(jsonError('NOT_FOUND', 'This purchase could not be found.'));
  }

  let body: RequestReaderSessionBody;
  try {
    body = await request.json();
  } catch {
    return withNoStore(jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.'));
  }
  if (typeof body.assetId !== 'string' || body.assetId.length === 0) {
    return withNoStore(jsonError('VALIDATION_ERROR', 'A valid assetId is required.'));
  }
  const deviceFingerprint = typeof body.deviceFingerprint === 'string' && body.deviceFingerprint.length > 0 ? body.deviceFingerprint : null;

  // The documented rollback path: when disabled (the default), this
  // endpoint simply stops minting new sessions, and library-reader.js
  // falls back to its existing, unmodified whole-file read-access
  // flow - no deploy or migration needed to recover from a production
  // issue, and no customer is ever moved onto the new path until this
  // is explicitly turned on.
  if (!(await isControlledReaderEnabled(env))) {
    return withNoStore(jsonError('CONTROLLED_READER_DISABLED', 'The controlled reader is not currently available.'));
  }

  const session = await createReaderSession(env, logger, auth.auth.customerId, reference, body.assetId, {
    ip: request.headers.get('CF-Connecting-IP'),
    userAgent: request.headers.get('User-Agent'),
    deviceFingerprint,
  });
  if (!session.granted) {
    return withNoStore(jsonError('READER_ACCESS_DENIED', "This resource isn't available to read right now."));
  }

  // One extra, cheap re-verification purely to recover productSlug/
  // assetId for the format-specific metadata lookup below - session
  // creation above already ran the real, authoritative entitlement
  // check; this never re-decides granted/denied, only reads back
  // context this route needs to answer "how many pages" / "what
  // chapters" in the SAME response, sparing the reader a second
  // round-trip before it can render anything.
  const context = await reverifyEntitlementForDelivery(env, session.deliveryId, auth.auth.customerId);
  if (!context.ok) {
    return withNoStore(jsonError('READER_ACCESS_DENIED', "This resource isn't available to read right now."));
  }

  const product = await fetchCatalogProduct(env, context.context.productSlug);
  const asset = product ? findPublishedAsset(product, context.context.assetId) : null;
  if (!asset || (asset.fileType !== 'PDF' && asset.fileType !== 'EPUB')) {
    return withNoStore(jsonError('READER_ACCESS_DENIED', 'This resource is not available in the controlled reader.'));
  }

  const object = await env.STORAGE.get(asset.storageKey);
  if (!object) {
    logger.error('reader_session.object_not_found_in_storage', { storageKey: asset.storageKey });
    return withNoStore(jsonError('ASSET_UNAVAILABLE', 'This resource is temporarily unavailable. Please try again later.'));
  }
  const masterBytes = await object.arrayBuffer();

  if (asset.fileType === 'PDF') {
    const pageCount = await getPdfPageCount(masterBytes);
    if (!pageCount.ok) {
      return withNoStore(jsonError('ASSET_UNAVAILABLE', 'This resource is temporarily unavailable. Please try again later.'));
    }
    return withNoStore(
      jsonSuccess({ token: session.token, expiresAt: session.expiresAt, fileType: 'PDF', totalPages: pageCount.totalPages })
    );
  }

  const manifest = await getEpubManifest(masterBytes);
  if (!manifest.ok) {
    return withNoStore(jsonError('ASSET_UNAVAILABLE', 'This resource is temporarily unavailable. Please try again later.'));
  }
  return withNoStore(jsonSuccess({ token: session.token, expiresAt: session.expiresAt, fileType: 'EPUB', spine: manifest.spine }));
}
