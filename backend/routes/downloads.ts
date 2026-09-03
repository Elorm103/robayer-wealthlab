/**
 * GET /api/download/:token — see docs/digital-fulfilment.md and
 * docs/worker-api-design.md. Thin HTTP layer only: validates/redeems
 * the token via services/entitlementService.ts, then streams the file
 * directly from the R2 STORAGE binding — the one place in this
 * codebase that ever touches R2. No presigned URL, no direct bucket
 * access is ever generated; see docs/storage-strategy.md's "Option B
 * — Worker-mediated download" for why.
 *
 * The response for a successful download is the file itself (binary),
 * not the standard `{ success, data }` JSON envelope — this is the one
 * endpoint whose successful response *is* the file, matching
 * docs/worker-api-design.md's original design. A failed attempt still
 * returns the standard JSON error envelope.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonError } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';
import { redeemDownloadToken, type RedeemDenialReason } from '../services/entitlementService';
import { redeemReceiptDownloadToken } from '../services/orders/receiptEntitlementService';
import { buildDownloadFilename } from '../utils/downloadFilename';
import { logContentAccess } from '../services/contentAccessLogService';
import type { ApiErrorCode } from '../types/api-contracts';

// Slows automated token-guessing attempts — defense in depth alongside
// the token's own 256-bit entropy (docs/download-security.md's
// "Rate limiting on the signing function itself").
const DOWNLOAD_RATE_LIMIT = { endpoint: 'download', limit: 20, windowSeconds: 60 };

const REASON_TO_CODE: Record<RedeemDenialReason, ApiErrorCode> = {
  token_not_found: 'TOKEN_NOT_FOUND',
  token_expired: 'TOKEN_EXPIRED',
  token_already_used: 'TOKEN_ALREADY_USED',
  download_limit_reached: 'DOWNLOAD_LIMIT_REACHED',
  asset_unavailable: 'ASSET_UNAVAILABLE',
};

const REASON_TO_MESSAGE: Record<RedeemDenialReason, string> = {
  token_not_found: 'This download link is invalid.',
  token_expired: 'This download link has expired. Please request a new one.',
  token_already_used: 'This download link has already been used. Please request a new one.',
  download_limit_reached: "You've reached the download limit for this purchase. Please contact support if you need help.",
  asset_unavailable: 'This file is temporarily unavailable. Please try again later or contact support.',
};

const CONTENT_TYPES: Record<string, string> = {
  PDF: 'application/pdf',
  ZIP: 'application/zip',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  MP4: 'video/mp4',
  MP3: 'audio/mpeg',
  JPG: 'image/jpeg',
  JPEG: 'image/jpeg',
  PNG: 'image/png',
};

function contentTypeFor(fileType: string): string {
  return CONTENT_TYPES[fileType.toUpperCase()] ?? 'application/octet-stream';
}

export async function handleDownload(request: Request, env: Env, logger: Logger, params: Record<string, string | undefined>): Promise<Response> {
  if (await isRateLimited(request, env, DOWNLOAD_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again in a minute.');
  }

  const result = await redeemDownloadToken(env, logger, params.token);
  if (!result.ok) {
    return jsonError(REASON_TO_CODE[result.reason], REASON_TO_MESSAGE[result.reason]);
  }

  const object = await env.STORAGE.get(result.asset.storageKey);
  if (!object) {
    // The token was genuinely valid and consumed — this is a real
    // content gap (the R2 object doesn't exist at the asset's own
    // recorded storageKey), not a security denial. Logged at error
    // severity so it gets noticed. See docs/digital-fulfilment.md's
    // "Known limitations" — expected today, since no real R2 bucket
    // has real objects in it yet.
    logger.error('download.object_not_found_in_storage', { storageKey: result.asset.storageKey });
    return jsonError('ASSET_UNAVAILABLE', REASON_TO_MESSAGE.asset_unavailable);
  }

  // Secure Digital Library, Phase 8 - every real redemption through
  // this whole-file endpoint is logged, regardless of which purpose
  // minted the token: "the complete file left the server here" is the
  // meaningfully distinct audit fact, kept as one 'download' action
  // (per the explicit, narrow allowed-action list) with the real
  // purpose preserved in metadata rather than a fifth action value.
  // Never blocks or delays the response below - a logging failure is
  // swallowed inside logContentAccess() itself.
  const owningCustomer = await env.DB.prepare(
    `SELECT ps.customer_id AS customerId FROM deliveries d JOIN purchase_sessions ps ON ps.id = d.purchase_session_id WHERE d.id = ?`
  )
    .bind(result.deliveryId)
    .first<{ customerId: number | null }>();
  await logContentAccess(env, logger, {
    deliveryId: result.deliveryId,
    customerId: owningCustomer?.customerId ?? null,
    action: 'download',
    ip: request.headers.get('CF-Connecting-IP'),
    userAgent: request.headers.get('User-Agent'),
    metadata: { purpose: result.purpose, assetId: result.asset.assetId },
  });

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': contentTypeFor(result.asset.fileType),
      // Digital Library Phase 7A: a 'view'-purpose token (minted by the
      // in-app reader, never consumes a download) gets `inline` — the
      // reader fetches this as a blob for PDF.js, not a browser
      // navigation, so this only matters if the URL is ever opened
      // directly. A 'download'-purpose token is completely unchanged
      // from before this phase: still `attachment`, still built the
      // same way. The saved filename is built fresh from the product's
      // current title, never from result.asset.filename
      // (media_assets.original_filename — the literal filename
      // captured once at upload time, which drifts out of sync the
      // moment a product is ever renamed; see utils/downloadFilename.ts
      // for the incident this fixed).
      'Content-Disposition': `${result.purpose === 'view' ? 'inline' : 'attachment'}; filename="${buildDownloadFilename(result.productTitle, result.asset.fileType)}"`,
      'Content-Length': String(object.size),
      'Cache-Control': 'no-store', // never let a browser/proxy cache a purchased file at a URL that's about to be invalidated
    },
  });
}

// Milestone M2 (Orders, Receipts & Customer Library) — GET
// /api/download-receipt/:token, the guest reference-scoped receipt
// redemption endpoint. Deliberately a separate route/handler from
// handleDownload above rather than a shared one: the two token types
// (download_tokens vs receipt_download_tokens) resolve to different
// tables and different denial vocabularies (see
// services/orders/receiptEntitlementService.ts's own header comment
// on why it mirrors, rather than reuses, entitlementService.ts).
const RECEIPT_DOWNLOAD_RATE_LIMIT = { endpoint: 'download-receipt', limit: 20, windowSeconds: 60 };

const RECEIPT_REASON_TO_MESSAGE: Record<string, string> = {
  token_not_found: 'This receipt link is invalid.',
  token_expired: 'This receipt link has expired. Please request a new one from your purchase confirmation page.',
  token_already_used: 'This receipt link has already been used. Please request a new one from your purchase confirmation page.',
  receipt_unavailable: 'This receipt is temporarily unavailable. Please try again shortly.',
};

export async function handleDownloadReceipt(request: Request, env: Env, logger: Logger, params: Record<string, string | undefined>): Promise<Response> {
  if (await isRateLimited(request, env, RECEIPT_DOWNLOAD_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again in a minute.');
  }

  const result = await redeemReceiptDownloadToken(env, logger, params.token);
  if (!result.ok) {
    return jsonError('RECEIPT_NOT_FOUND', RECEIPT_REASON_TO_MESSAGE[result.reason] ?? RECEIPT_REASON_TO_MESSAGE.token_not_found);
  }

  const object = await env.STORAGE.get(result.storageKey);
  if (!object) {
    logger.error('download_receipt.object_not_found_in_storage', { storageKey: result.storageKey });
    return jsonError('RECEIPT_NOT_FOUND', RECEIPT_REASON_TO_MESSAGE.receipt_unavailable);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${result.receiptNumber}.pdf"`,
      'Content-Length': String(object.size),
      'Cache-Control': 'no-store',
    },
  });
}
