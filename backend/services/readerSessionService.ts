/**
 * Reader Session Service - Controlled Library Reader, Phase 2.
 *
 * A reader session is the credential every page/chapter request in
 * the controlled reader is scoped to: short-lived, revocable, bound to
 * one delivery (entitlement grant), issued only after a fresh, full
 * re-run of entitlementService.ts's own checkEntitlement() - the same
 * ownership-integrity checks download/view tokens already get
 * (verified purchase, owned by this customer, asset published,
 * delivery not revoked, within its access window).
 *
 * Only the SHA-256 hash of the real session token is ever stored
 * (reader_sessions.session_token_hash) - see utils/readerToken.ts's
 * own header comment. The raw token is returned to the caller exactly
 * once, at mint time.
 *
 * device_fingerprint_hash is stored purely as a deterrence/concurrency
 * signal, never as a security boundary: a session is fully valid
 * regardless of whether a later request's fingerprint matches the one
 * recorded at mint time. Nothing in this file treats a fingerprint
 * mismatch as a denial.
 *
 * Uses the reader_sessions/content_access_log tables added by
 * migration 0058_secure_reader.sql - already applied in production,
 * unused since the earlier rollback. Reused here rather than adding a
 * new migration; the tables were designed for exactly this.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { checkEntitlement, type EntitlementDenialReason } from './entitlementService';
import { generateReaderSessionToken, hashReaderSessionToken } from '../utils/readerToken';
import { logContentAccess } from './contentAccessLogService';

/** Sliding-renewal window: every valid page/chapter request pushes expiry forward by this much, capped by MAX_SESSION_LIFETIME_MINUTES below. */
const SESSION_TTL_MINUTES = 30;
/** Absolute ceiling on a single session's lifetime regardless of how continuously it's renewed - bounds exposure from a session left open indefinitely, while still comfortably covering one real reading sitting. */
const MAX_SESSION_LIFETIME_MINUTES = 180;

export type CreateReaderSessionResult =
  | { granted: true; token: string; expiresAt: string; deliveryId: number; watermarkId: string }
  | { granted: false; reason: EntitlementDenialReason };

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  deviceFingerprint: string | null;
}

/**
 * Mints a fresh reader session, only after a full, fresh entitlement
 * check (never trusted from an earlier call, including an earlier
 * reader session for the same delivery). Revokes any other currently-
 * active session for this exact delivery first - "starting a new
 * session invalidates the previous one," per explicit product
 * decision - so a customer can always regain reading access from a
 * new device/tab without needing an admin to intervene, at the cost
 * of the old session immediately stopping. This is a courtesy/
 * concurrency-control behavior, not a security enforcement: nothing
 * here claims to detect or prevent credential sharing.
 */
export async function createReaderSession(
  env: Env,
  logger: Logger,
  customerId: number,
  purchaseReference: string,
  assetId: string,
  context: RequestContext
): Promise<CreateReaderSessionResult> {
  const check = await checkEntitlement(env, purchaseReference, assetId, 'view', customerId);
  if (!check.granted) {
    logger.warn('reader_session.denied', { purchaseReference, assetId, reason: check.reason });
    return { granted: false, reason: check.reason };
  }

  const watermarkId = await getOrCreateWatermarkId(env, check.deliveryId);

  // Revoke any other currently-active session for this delivery before
  // minting the new one - a plain, non-atomic UPDATE is sufficient
  // here: this is a courtesy invalidation, not a single-use secret
  // being consumed, so the narrow race window of two briefly-valid
  // sessions (both already belonging to the same entitled customer)
  // carries no real security consequence.
  await env.DB.prepare(`UPDATE reader_sessions SET revoked_at = datetime('now') WHERE delivery_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')`)
    .bind(check.deliveryId)
    .run();

  const token = generateReaderSessionToken();
  const tokenHash = await hashReaderSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000).toISOString();
  const deviceFingerprintHash = context.deviceFingerprint ? await hashReaderSessionToken(context.deviceFingerprint) : null;

  await env.DB.prepare(
    `INSERT INTO reader_sessions (delivery_id, customer_id, session_token_hash, device_fingerprint_hash, expires_at, last_seen_at, data_classification)
     VALUES (?, ?, ?, ?, ?, datetime('now'), 'PRODUCTION')`
  )
    .bind(check.deliveryId, customerId, tokenHash, deviceFingerprintHash, expiresAt)
    .run();

  await logContentAccess(env, logger, {
    deliveryId: check.deliveryId,
    customerId,
    action: 'view_session_started',
    ip: context.ip,
    userAgent: context.userAgent,
  });
  logger.info('reader_session.created', { deliveryId: check.deliveryId, customerId });

  return { granted: true, token, expiresAt, deliveryId: check.deliveryId, watermarkId };
}

export type ReaderSessionDenialReason = 'session_not_found' | 'session_revoked' | 'session_expired';

export type ValidateReaderSessionResult =
  | { ok: true; deliveryId: number; customerId: number }
  | { ok: false; reason: ReaderSessionDenialReason };

interface ReaderSessionRow {
  id: number;
  deliveryId: number;
  customerId: number;
  issuedAt: string;
  revokedAt: string | null;
  expiresAt: string;
}

/**
 * Validates a reader session token for a page/chapter request. Every
 * caller (pdfPageService, epubChapterService) re-checks entitlement
 * fresh on top of this - a valid session alone is necessary but not
 * sufficient; see routes/reader.ts. On success, slides the session's
 * expiry forward (capped at MAX_SESSION_LIFETIME_MINUTES from
 * issuance) so continuous reading never gets cut off mid-book by the
 * short per-request TTL, while a genuinely abandoned session still
 * expires on schedule.
 */
export async function validateReaderSession(env: Env, sessionToken: unknown): Promise<ValidateReaderSessionResult> {
  if (typeof sessionToken !== 'string' || !/^[a-f0-9]{64}$/.test(sessionToken)) {
    return { ok: false, reason: 'session_not_found' };
  }
  const tokenHash = await hashReaderSessionToken(sessionToken);

  const row = await env.DB.prepare(
    `SELECT id, delivery_id AS deliveryId, customer_id AS customerId, issued_at AS issuedAt, revoked_at AS revokedAt, expires_at AS expiresAt
     FROM reader_sessions WHERE session_token_hash = ?`
  )
    .bind(tokenHash)
    .first<ReaderSessionRow>();

  if (!row) return { ok: false, reason: 'session_not_found' };
  if (row.revokedAt !== null) return { ok: false, reason: 'session_revoked' };
  if (Date.now() > new Date(row.expiresAt).getTime()) return { ok: false, reason: 'session_expired' };

  const slidTo = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000);
  const absoluteCeiling = new Date(new Date(row.issuedAt).getTime() + MAX_SESSION_LIFETIME_MINUTES * 60_000);
  const newExpiresAt = (slidTo < absoluteCeiling ? slidTo : absoluteCeiling).toISOString();

  // Best-effort bookkeeping - a failed/raced renewal never denies this
  // already-valid request; it only means the NEXT request re-evaluates
  // against whatever expires_at is actually stored.
  await env.DB.prepare(`UPDATE reader_sessions SET expires_at = ?, last_seen_at = datetime('now') WHERE id = ?`).bind(newExpiresAt, row.id).run();

  return { ok: true, deliveryId: row.deliveryId, customerId: row.customerId };
}

export interface DeliveryContext {
  purchaseReference: string;
  assetId: string;
  productSlug: string;
  watermarkId: string;
}

/**
 * Re-derives (purchaseReference, assetId) from a delivery id, then
 * runs the EXACT same checkEntitlement() every other entitlement
 * decision in this codebase goes through - never a parallel/duplicated
 * check. This is what makes "every page/chapter request independently
 * verifies entitlement" real rather than aspirational: a session being
 * merely unexpired is never treated as sufficient on its own by
 * routes/reader.ts - this call re-confirms the delivery is still not
 * revoked and still within its access window on every single request.
 */
export async function reverifyEntitlementForDelivery(env: Env, deliveryId: number, customerId: number): Promise<{ ok: true; context: DeliveryContext } | { ok: false; reason: EntitlementDenialReason | 'delivery_missing' }> {
  const row = await env.DB.prepare(
    `SELECT d.asset_id AS assetId, d.product_slug AS productSlug, d.owner_watermark_id AS watermarkId, ps.purchase_reference AS purchaseReference
     FROM deliveries d JOIN purchase_sessions ps ON ps.id = d.purchase_session_id WHERE d.id = ?`
  )
    .bind(deliveryId)
    .first<{ assetId: string; productSlug: string; watermarkId: string | null; purchaseReference: string }>();
  if (!row) return { ok: false, reason: 'delivery_missing' };

  const check = await checkEntitlement(env, row.purchaseReference, row.assetId, 'view', customerId);
  if (!check.granted) return { ok: false, reason: check.reason };

  const watermarkId = row.watermarkId ?? (await getOrCreateWatermarkId(env, deliveryId));
  return { ok: true, context: { purchaseReference: row.purchaseReference, assetId: row.assetId, productSlug: row.productSlug, watermarkId } };
}

/** Lazily generates and persists deliveries.owner_watermark_id the first time a delivery ever opens a controlled reader session - never backfilled in bulk. A fresh, independent identifier (not derived from licenses.license_key): not every delivery is guaranteed to have a matching license row, and this stays a simple, self-contained fact about the delivery. */
async function getOrCreateWatermarkId(env: Env, deliveryId: number): Promise<string> {
  const existing = await env.DB.prepare(`SELECT owner_watermark_id AS id FROM deliveries WHERE id = ?`).bind(deliveryId).first<{ id: string | null }>();
  if (existing?.id) return existing.id;

  const watermarkId = `RWL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  // WHERE owner_watermark_id IS NULL keeps this idempotent under a rare
  // concurrent double-mint (two near-simultaneous reader-session
  // requests for the same delivery before either has generated one
  // yet): whichever write lands first wins, the second is a no-op, and
  // both callers re-read below to converge on the SAME final value
  // rather than each returning a different generated id.
  await env.DB.prepare(`UPDATE deliveries SET owner_watermark_id = ?, updated_at = datetime('now') WHERE id = ? AND owner_watermark_id IS NULL`).bind(watermarkId, deliveryId).run();

  const final = await env.DB.prepare(`SELECT owner_watermark_id AS id FROM deliveries WHERE id = ?`).bind(deliveryId).first<{ id: string }>();
  return final!.id;
}
