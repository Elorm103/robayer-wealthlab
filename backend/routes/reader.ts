/**
 * GET /api/reader/:sessionToken/page/:pageNumber and
 * GET /api/reader/:sessionToken/chapter/:chapterReference - Secure
 * Digital Library, Phases 4/5. The protected reader's actual content
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
import { isSecureReaderEnabled } from '../services/admin/settingsService';
import type { ApiErrorCode } from '../types/api-contracts';

// Deliberately tighter than the reader-session mint rate limit
// (which is once-per-book-open): a real customer turns pages far
// slower than this even on a fast skim, so this is generous for
// legitimate use while still catching a scripted "fetch every page in
// a few seconds" extraction attempt - see Phase 9's explicit ask.
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

  // Checked before session validation, deliberately: an operator
  // disabling secure_reader_enabled must stop EVERY page request, not
  // just new session mints - including a session that was already
  // valid a moment ago. See handleRequestReaderSession()'s own mint-
  // time check (routes/customer/purchases.ts) for the other half of
  // this kill switch; this is what makes it immediate rather than
  // "new sessions only."
  if (!(await isSecureReaderEnabled(env))) {
    return jsonError('SECURE_READER_DISABLED', 'The protected reader is not currently available. Please try again later.');
  }

  const session = await validateReaderSession(env, params.sessionToken);
  if (!session.ok) {
    return jsonError('READER_SESSION_INVALID', SESSION_REASON_TO_MESSAGE[session.reason]);
  }

  const pageNumber = Number(params.pageNumber);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return jsonError('INVALID_PAGE', 'A valid page number is required.');
  }

  const entitlement = await reverifyEntitlementForDelivery(env, session.deliveryId, session.customerId);
  if (!entitlement.ok) {
    return jsonError('READER_ACCESS_DENIED', 'This resource is no longer available to read. Please check My Library or contact support.');
  }

  const product = await fetchCatalogProduct(env, entitlement.context.productSlug);
  const asset = product ? findPublishedAsset(product, entitlement.context.assetId) : null;
  if (!asset || asset.fileType !== 'PDF') {
    return jsonError('READER_ACCESS_DENIED', 'This resource is not available in the protected reader.');
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

  // See handleGetReaderPage()'s identical check above for why this
  // runs before session validation.
  if (!(await isSecureReaderEnabled(env))) {
    return jsonError('SECURE_READER_DISABLED', 'The protected reader is not currently available. Please try again later.');
  }

  const session = await validateReaderSession(env, params.sessionToken);
  if (!session.ok) {
    return jsonError('READER_SESSION_INVALID', SESSION_REASON_TO_MESSAGE[session.reason]);
  }

  const chapterReference = params.chapterReference;
  if (typeof chapterReference !== 'string' || chapterReference.length === 0) {
    return jsonError('INVALID_CHAPTER', 'A valid chapter reference is required.');
  }

  const entitlement = await reverifyEntitlementForDelivery(env, session.deliveryId, session.customerId);
  if (!entitlement.ok) {
    return jsonError('READER_ACCESS_DENIED', 'This resource is no longer available to read. Please check My Library or contact support.');
  }

  const product = await fetchCatalogProduct(env, entitlement.context.productSlug);
  const asset = product ? findPublishedAsset(product, entitlement.context.assetId) : null;
  if (!asset || asset.fileType !== 'EPUB') {
    return jsonError('READER_ACCESS_DENIED', 'This resource is not available in the protected reader.');
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
