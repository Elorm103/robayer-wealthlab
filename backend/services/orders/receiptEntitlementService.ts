/**
 * Receipt Entitlement Service - Version 3.0.2 Milestone M2 (Orders,
 * Receipts & Customer Library). The guest, reference-scoped
 * mint-then-redeem pair for receipt downloads (ADR-013 tier 2 - an
 * *action*, not mere viewing, so it needs its own single-use token,
 * even though no customer session exists for a guest purchaser).
 *
 * Direct structural mirror of `services/entitlementService.ts`'s own
 * `generateDownloadPermission()`/`redeemDownloadToken()` pair - same
 * atomic, race-free token-consumption pattern (a single UPDATE gated
 * on every condition in its WHERE clause), applied to
 * `receipt_download_tokens` instead of `download_tokens`. A receipt,
 * unlike a product asset, has no download-count/expiry policy of its
 * own to enforce at redemption time - the token's own single-use
 * property is the entire access control.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { generateReceiptDownloadToken } from '../../utils/orderToken';
import { getOrCreateReceiptPdf } from './receiptPdfService';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const RECEIPT_DOWNLOAD_TOKEN_TTL_MINUTES = 15;

export type GenerateReceiptDownloadPermissionResult = { granted: true; token: string; expiresAt: string } | { granted: false; reason: 'receipt_not_found' };

/** Mints a token only for a purchase that has an issued receipt - never for a pending/failed/expired session, which has none yet. */
export async function generateReceiptDownloadPermission(env: Env, logger: Logger, purchaseReference: string): Promise<GenerateReceiptDownloadPermissionResult> {
  const receipt = await env.DB.prepare(
    `SELECT r.id FROM receipts r JOIN purchase_sessions ps ON ps.id = r.purchase_session_id WHERE ps.purchase_reference = ?`
  )
    .bind(purchaseReference)
    .first<{ id: number }>();

  if (!receipt) {
    logger.warn('receipt_entitlement.denied', { purchaseReference, reason: 'receipt_not_found' });
    return { granted: false, reason: 'receipt_not_found' };
  }

  const token = generateReceiptDownloadToken();
  const expiresAt = new Date(Date.now() + RECEIPT_DOWNLOAD_TOKEN_TTL_MINUTES * 60_000).toISOString();

  await env.DB.prepare(`INSERT INTO receipt_download_tokens (token, receipt_id, expires_at) VALUES (?, ?, ?)`).bind(token, receipt.id, expiresAt).run();

  logger.info('receipt_entitlement.granted', { purchaseReference, receiptId: receipt.id });
  return { granted: true, token, expiresAt };
}

export type RedeemReceiptTokenReason = 'token_not_found' | 'token_expired' | 'token_already_used' | 'receipt_unavailable';
export type RedeemReceiptTokenResult = { ok: true; storageKey: string; receiptNumber: string } | { ok: false; reason: RedeemReceiptTokenReason };

export async function redeemReceiptDownloadToken(env: Env, logger: Logger, tokenInput: unknown): Promise<RedeemReceiptTokenResult> {
  if (typeof tokenInput !== 'string' || !TOKEN_PATTERN.test(tokenInput)) {
    return { ok: false, reason: 'token_not_found' };
  }
  const token = tokenInput;

  const now = new Date().toISOString();
  const consumed = await env.DB.prepare(`UPDATE receipt_download_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at > ?`)
    .bind(now, token, now)
    .run();

  if (consumed.meta.changes !== 1) {
    const existing = await env.DB.prepare(`SELECT used_at AS usedAt FROM receipt_download_tokens WHERE token = ?`).bind(token).first<{ usedAt: string | null }>();
    if (!existing) return { ok: false, reason: 'token_not_found' };
    if (existing.usedAt !== null) return { ok: false, reason: 'token_already_used' };
    return { ok: false, reason: 'token_expired' };
  }

  const row = await env.DB.prepare(`SELECT receipt_id AS receiptId FROM receipt_download_tokens WHERE token = ?`).bind(token).first<{ receiptId: number }>();
  if (!row) return { ok: false, reason: 'token_not_found' };

  const storageKey = await getOrCreateReceiptPdf(env, logger, row.receiptId);
  if (!storageKey) return { ok: false, reason: 'receipt_unavailable' };

  const receiptRow = await env.DB.prepare(`SELECT receipt_number AS receiptNumber FROM receipts WHERE id = ?`).bind(row.receiptId).first<{ receiptNumber: string }>();

  logger.info('receipt_entitlement.redeemed', { receiptId: row.receiptId });
  return { ok: true, storageKey, receiptNumber: receiptRow?.receiptNumber ?? 'receipt' };
}
