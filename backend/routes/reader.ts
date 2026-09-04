/**
 * GET /api/reader/:sessionToken/page/:pageNumber and
 * GET /api/reader/:sessionToken/chapter/:chapterReference - Controlled
 * Library Reader, Phase 2. The controlled reader's actual content
 * delivery: never the complete master file, always exactly one
 * page/chapter, watermarked, `Cache-Control: no-store`.
 *
 * Deliberately session-token-scoped (bearer-token-in-URL), not
 * customer-cookie-scoped - matching the existing
 * GET /api/download/:token pattern exactly, since these are frequent,
 * lightweight GET requests fired once per page/chapter turn. Every
 * single request independently re-validates BOTH the reader session
 * (readerSessionService.validateReaderSession - not revoked, not
 * expired) AND entitlement fresh (readerSessionService.
 * reverifyEntitlementForDelivery - not revoked, still within its
 * access window), never trusting either from session-mint time. Thin
 * HTTP layer only: all real logic lives in pdfPageService.ts /
 * epubChapterService.ts / readerSessionService.ts.
 *
 * The controlled-reader-enabled check still runs before this endpoint
 * does anything else that matters (rendering, storage reads,
 * watermarking) - disabling access must still be an immediate, total
 * stop for an already-open session, never "new sessions only". Phase
 * 6A/6B changed WHICH check function runs and WHEN, not that
 * principle:
 *   - Phase 6A moved it to right after session validation (instead of
 *     before it), because the pilot allowlist is scoped by customerId -
 *     isControlledReaderEnabledForCustomer() needs the session's own
 *     customerId, which only validateReaderSession() can produce.
 *   - Phase 6B moved it once more, to right after
 *     reverifyEntitlementForDelivery() (still well before any real
 *     content is ever touched), because a pilot can now ALSO be scoped
 *     to one specific purchase reference
 *     (controlled_reader_pilot_purchase_references) - that reference is
 *     only known once reverifyEntitlementForDelivery() resolves it,
 *     which this endpoint already calls next anyway for its own
 *     product/asset lookup.
 * A session that fails validation, or an entitlement that fails
 * reverification, is rejected before the enabled-for-this-request check
 * even runs, exactly as before either reordering - across both changes,
 * this only ever affects which of several "you can't have this page"
 * reasons a REJECTED request reports first, never who is actually let
 * through.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import type { RouteParams } from '../worker/index';
import { jsonError } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';
import { validateReaderSession, reverifyEntitlementForDelivery, type ReaderSessionDenialReason } from '../services/readerSessionService';
import { renderProtectedPdfPage, type PdfPageDenialReason } from '../services/pdfPageService';
import { renderProtectedEpubChapter, type RenderEpubChapterDenialReason } from '../services/epubChapterService';
import { fetchCatalogProduct, findPublishedAsset } from '../services/productCatalogService';
import { logContentAccess } from '../services/contentAccessLogService';
import { isControlledReaderEnabledForCustomer } from '../services/admin/settingsService';
import type { ApiErrorCode } from '../types/api-contracts';

// Deliberately tighter than the reader-session mint rate limit
// (which is once-per-book-open): a real customer turns pages far
// slower than this even on a fast skim, so this is generous for
// legitimate use while still catching a scripted "fetch every page in
// a few seconds" extraction attempt.
const READER_CONTENT_RATE_LIMIT = { endpoint: 'reader-content', limit: 120, windowSeconds: 60 };

const SESSION_REASON_TO_MESSAGE: Record<ReaderSessionDenialReason, string> = {
  session_not_found: 'This reading session is invalid. Please reopen the book from My Library.',
  session_revoked: 'This reading session has ended, most likely because it was opened again elsewhere. Please reopen the book from My Library.',
  session_expired: 'This reading session has expired. Please reopen the book from My Library.',
};

function noStoreHeaders(extra: Record<string, string>): HeadersInit {
  return {
    ...extra,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  };
}

async function resolveWatermarkContext(
  env: Env,
  customerId: number
): Promise<{ customerEmail: string } | null> {
  const row = await env.DB.prepare(`SELECT email FROM customers WHERE id = ?`).bind(customerId).first<{ email: string }>();
  return row ? { customerEmail: row.email } : null;
}

export async function handleGetReaderPage(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  if (await isRateLimited(request, env, READER_CONTENT_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please slow down and try again shortly.');
  }

  const session = await validateReaderSession(env, params.sessionToken);
  if (!session.ok) {
    return jsonError('READER_SESSION_INVALID', SESSION_REASON_TO_MESSAGE[session.reason]);
  }

  const pageNumber = Number(params.pageNumber);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return jsonError('INVALID_PAGE', 'A valid page number is required.');
  }

  // Phase 6B — resolved BEFORE the enabled-for-this-request check
  // (reordered from Phase 6A) so that check can see the real
  // purchaseReference too, not just customerId: a pilot scoped to one
  // specific purchase reference (controlled_reader_pilot_purchase_references)
  // needs it to know whether THIS delivery, specifically, is pilot-
  // eligible, regardless of what else this customer owns.
  const entitlement = await reverifyEntitlementForDelivery(env, session.deliveryId, session.customerId);
  if (!entitlement.ok) {
    return jsonError('READER_ACCESS_DENIED', 'This resource is no longer available to read. Please check My Library or contact support.');
  }
  if (!(await isControlledReaderEnabledForCustomer(env, session.customerId, entitlement.context.purchaseReference))) {
    return jsonError('CONTROLLED_READER_DISABLED', 'The controlled reader is not currently available. Please try again later.');
  }

  const product = await fetchCatalogProduct(env, entitlement.context.productSlug);
  const asset = product ? findPublishedAsset(product, entitlement.context.assetId) : null;
  if (!asset || asset.fileType !== 'PDF') {
    return jsonError('READER_ACCESS_DENIED', 'This resource is not available in the controlled reader.');
  }

  const object = await env.STORAGE.get(asset.storageKey);
  if (!object) {
    logger.error('reader.page_object_not_found_in_storage', { storageKey: asset.storageKey });
    return jsonError('ASSET_UNAVAILABLE', 'This resource is temporarily unavailable. Please try again later.');
  }
  const masterBytes = await object.arrayBuffer();

  const watermarkContext = await resolveWatermarkContext(env, session.customerId);
  if (!watermarkContext) {
    return jsonError('READER_ACCESS_DENIED', 'This resource is not available right now.');
  }

  const result = await renderProtectedPdfPage(masterBytes, pageNumber, {
    customerEmail: watermarkContext.customerEmail,
    watermarkId: entitlement.context.watermarkId,
    timestamp: new Date().toISOString(),
  });
  if (!result.ok) {
    return jsonError(PDF_REASON_TO_CODE[result.reason], PDF_REASON_TO_MESSAGE[result.reason]);
  }

  await logContentAccess(env, logger, {
    deliveryId: session.deliveryId,
    customerId: session.customerId,
    action: 'page_rendered',
    ip: request.headers.get('CF-Connecting-IP'),
    userAgent: request.headers.get('User-Agent'),
    metadata: { pageNumber, totalPages: result.totalPages },
  });

  return new Response(result.bytes, {
    status: 200,
    headers: noStoreHeaders({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline',
      'X-Reader-Total-Pages': String(result.totalPages),
    }),
  });
}

const PDF_REASON_TO_CODE: Record<PdfPageDenialReason, ApiErrorCode> = {
  asset_unavailable: 'ASSET_UNAVAILABLE',
  invalid_page: 'INVALID_PAGE',
  render_failed: 'ASSET_UNAVAILABLE',
};
const PDF_REASON_TO_MESSAGE: Record<PdfPageDenialReason, string> = {
  asset_unavailable: 'This resource is temporarily unavailable. Please try again later.',
  invalid_page: 'That page does not exist in this document.',
  render_failed: 'This page could not be prepared right now. Please try again.',
};

export async function handleGetReaderChapter(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  if (await isRateLimited(request, env, READER_CONTENT_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please slow down and try again shortly.');
  }

  const session = await validateReaderSession(env, params.sessionToken);
  if (!session.ok) {
    return jsonError('READER_SESSION_INVALID', SESSION_REASON_TO_MESSAGE[session.reason]);
  }

  const chapterReference = params.chapterReference;
  if (typeof chapterReference !== 'string' || chapterReference.length === 0) {
    return jsonError('INVALID_CHAPTER', 'A valid chapter reference is required.');
  }

  // Phase 6B — same reordering as handleGetReaderPage() above, and for
  // the same reason: the enabled-for-this-request check needs the real
  // purchaseReference reverifyEntitlementForDelivery() resolves, to
  // support a pilot scoped to one specific purchase reference.
  const entitlement = await reverifyEntitlementForDelivery(env, session.deliveryId, session.customerId);
  if (!entitlement.ok) {
    return jsonError('READER_ACCESS_DENIED', 'This resource is no longer available to read. Please check My Library or contact support.');
  }
  if (!(await isControlledReaderEnabledForCustomer(env, session.customerId, entitlement.context.purchaseReference))) {
    return jsonError('CONTROLLED_READER_DISABLED', 'The controlled reader is not currently available. Please try again later.');
  }

  const product = await fetchCatalogProduct(env, entitlement.context.productSlug);
  const asset = product ? findPublishedAsset(product, entitlement.context.assetId) : null;
  if (!asset || asset.fileType !== 'EPUB') {
    return jsonError('READER_ACCESS_DENIED', 'This resource is not available in the controlled reader.');
  }

  const object = await env.STORAGE.get(asset.storageKey);
  if (!object) {
    logger.error('reader.chapter_object_not_found_in_storage', { storageKey: asset.storageKey });
    return jsonError('ASSET_UNAVAILABLE', 'This resource is temporarily unavailable. Please try again later.');
  }
  const masterBytes = await object.arrayBuffer();

  const watermarkContext = await resolveWatermarkContext(env, session.customerId);
  if (!watermarkContext) {
    return jsonError('READER_ACCESS_DENIED', 'This resource is not available right now.');
  }

  // decodeURIComponent: chapterReference travels through a URL path
  // segment, which the client encodes (a manifest href commonly
  // contains no special characters, but this is defensive, not
  // load-bearing - the value is matched exactly against this book's
  // OWN real spine list inside renderProtectedEpubChapter(), never
  // used to build a raw filesystem/zip lookup path directly from
  // untrusted input).
  let decodedRef: string;
  try {
    decodedRef = decodeURIComponent(chapterReference);
  } catch {
    return jsonError('INVALID_CHAPTER', 'A valid chapter reference is required.');
  }

  const result = await renderProtectedEpubChapter(masterBytes, decodedRef, {
    customerEmail: watermarkContext.customerEmail,
    watermarkId: entitlement.context.watermarkId,
    timestamp: new Date().toISOString(),
  });
  if (!result.ok) {
    return jsonError(EPUB_REASON_TO_CODE[result.reason], EPUB_REASON_TO_MESSAGE[result.reason]);
  }

  await logContentAccess(env, logger, {
    deliveryId: session.deliveryId,
    customerId: session.customerId,
    action: 'chapter_rendered',
    ip: request.headers.get('CF-Connecting-IP'),
    userAgent: request.headers.get('User-Agent'),
    metadata: { chapterReference: decodedRef },
  });

  return new Response(result.html, {
    status: 200,
    headers: noStoreHeaders({ 'Content-Type': 'text/html; charset=utf-8' }),
  });
}

const EPUB_REASON_TO_CODE: Record<RenderEpubChapterDenialReason, ApiErrorCode> = {
  invalid_archive: 'ASSET_UNAVAILABLE',
  container_not_found: 'ASSET_UNAVAILABLE',
  opf_not_found: 'ASSET_UNAVAILABLE',
  no_spine: 'ASSET_UNAVAILABLE',
  chapter_not_found: 'INVALID_CHAPTER',
};
const EPUB_REASON_TO_MESSAGE: Record<RenderEpubChapterDenialReason, string> = {
  invalid_archive: 'This resource is temporarily unavailable. Please try again later.',
  container_not_found: 'This resource is temporarily unavailable. Please try again later.',
  opf_not_found: 'This resource is temporarily unavailable. Please try again later.',
  no_spine: 'This resource is temporarily unavailable. Please try again later.',
  chapter_not_found: 'That chapter does not exist in this book.',
};
