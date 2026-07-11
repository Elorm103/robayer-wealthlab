/**
 * Entitlement Service — Version 1.2 Sprint 2.5 (Digital Fulfilment
 * Platform). See docs/digital-fulfilment.md.
 *
 * The one place this codebase answers the question this sprint is
 * built around: not "did they pay?" but **"does this purchase
 * currently grant access to this digital asset?"** Every check below
 * must pass, freshly, on every single request — nothing is cached or
 * assumed from an earlier check, including an earlier call within the
 * same request lifecycle. No frontend value is ever trusted for any
 * of these decisions; every input here is either a server-generated
 * identifier (`purchaseReference`) or looked up fresh from D1/content.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { fetchCatalogProduct, findPublishedAsset, type DigitalAsset } from './productCatalogService';
import { generateDownloadToken } from '../utils/downloadToken';

/** Matches generateDownloadToken()'s own output shape — 64 lowercase hex characters (32 bytes). Rejecting anything else means a malformed token never even reaches a D1 query. */
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/** Single-use token TTL — short enough that a leaked link has a small, bounded exposure window (docs/download-security.md's "signed, time-limited URLs"). */
const DOWNLOAD_TOKEN_TTL_MINUTES = 15;

/**
 * Every reason an entitlement check can fail — kept detailed here for
 * logging/audit, but NEVER surfaced this specifically to a caller
 * outside this service. `routes/` code maps every one of these to the
 * same generic, visitor-safe message — see docs/digital-fulfilment.md's
 * "Security" section on why distinguishing them externally would leak
 * information (e.g. "purchase_not_verified" vs "asset_not_found" tells
 * a prober which part of their guess was wrong).
 */
export type EntitlementDenialReason =
  | 'purchase_not_verified'
  | 'asset_not_found'
  | 'delivery_not_found'
  | 'delivery_revoked'
  | 'download_limit_reached'
  | 'access_expired';

export type EntitlementCheckResult =
  | { granted: true; deliveryId: number }
  | { granted: false; reason: EntitlementDenialReason };

interface VerifiedPurchaseSessionRow {
  id: number;
  productSlug: string;
  status: string;
}

interface DeliveryRow {
  id: number;
  maxDownloads: number | null;
  downloadsUsed: number;
  accessExpiresAt: string | null;
  status: string;
}

/**
 * The core question. Re-derives the answer from scratch every call:
 *   1. Is the purchase actually verified (never trusts anything but
 *      `purchase_sessions.status`, written only by
 *      `commerceService.ts`'s webhook-verified flow)?
 *   2. Does the asset exist on that purchase's product, and is it
 *      published (an asset can be pulled independently of the
 *      product's own status)?
 *   3. Does a delivery (entitlement grant) exist for this exact
 *      (purchase, asset) pair, and is it not revoked?
 *   4. Is the delivery still within its snapshotted policy (download
 *      count, access window)?
 */
export async function checkEntitlement(env: Env, purchaseReference: string, assetId: string): Promise<EntitlementCheckResult> {
  const session = await getVerifiedPurchaseSession(env, purchaseReference);
  if (!session) {
    return { granted: false, reason: 'purchase_not_verified' };
  }

  const product = await fetchCatalogProduct(env, session.productSlug);
  const asset = product ? findPublishedAsset(product, assetId) : null;
  if (!asset) {
    return { granted: false, reason: 'asset_not_found' };
  }

  const delivery = await getDelivery(env, session.id, assetId);
  if (!delivery) {
    // No delivery row means fulfilment hasn't run (or hasn't reached
    // this asset) yet — never auto-created here. Creating an
    // entitlement is exclusively fulfilmentService.ts's job, so there
    // is exactly one place that ever grants one. See
    // docs/digital-fulfilment.md's "Entitlement model."
    return { granted: false, reason: 'delivery_not_found' };
  }
  if (delivery.status === 'revoked') {
    return { granted: false, reason: 'delivery_revoked' };
  }
  // Advisory pre-check only — avoids minting a token that could never
  // be redeemed. The real, atomic enforcement of this same limit
  // happens at redemption time (routes/downloads.ts's atomic
  // UPDATE ... WHERE downloads_used < max_downloads), not here — see
  // docs/digital-fulfilment.md's "Download policy" for why this is a
  // deliberate two-layer design, not a redundant one.
  if (delivery.maxDownloads !== null && delivery.downloadsUsed >= delivery.maxDownloads) {
    return { granted: false, reason: 'download_limit_reached' };
  }
  if (delivery.accessExpiresAt !== null && Date.now() > new Date(delivery.accessExpiresAt).getTime()) {
    return { granted: false, reason: 'access_expired' };
  }

  return { granted: true, deliveryId: delivery.id };
}

export type GenerateDownloadPermissionResult =
  | { granted: true; token: string; expiresAt: string }
  | { granted: false; reason: EntitlementDenialReason };

/**
 * "Generate secure download permission" — mints a fresh, single-use,
 * short-lived token only after `checkEntitlement()` passes every
 * check above. Never called by, or influenced by, anything from the
 * frontend beyond the purchase reference and asset id — both are
 * re-validated here, not trusted from an earlier response.
 */
export async function generateDownloadPermission(
  env: Env,
  logger: Logger,
  purchaseReference: string,
  assetId: string
): Promise<GenerateDownloadPermissionResult> {
  const check = await checkEntitlement(env, purchaseReference, assetId);
  if (!check.granted) {
    logger.warn('entitlement.denied', { purchaseReference, assetId, reason: check.reason });
    return { granted: false, reason: check.reason };
  }

  const token = generateDownloadToken();
  const expiresAt = new Date(Date.now() + DOWNLOAD_TOKEN_TTL_MINUTES * 60_000).toISOString();

  await env.DB.prepare(`INSERT INTO download_tokens (token, delivery_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, check.deliveryId, expiresAt)
    .run();

  logger.info('entitlement.granted', { purchaseReference, assetId, deliveryId: check.deliveryId });

  return { granted: true, token, expiresAt };
}

// ============================================================
// Redemption — GET /api/download/:token
// ============================================================

/**
 * Matches docs/worker-api-design.md's originally-documented
 * `GET /api/download/:token` error set exactly. Unlike
 * `EntitlementDenialReason` above (deliberately collapsed to avoid
 * telling a prober which part of a *guessed* identifier was wrong),
 * these ARE distinguished: a 256-bit random token is not realistically
 * guessable in the first place, so a visitor who has a real-but-stale
 * token is virtually always its legitimate original recipient, and
 * telling them precisely *why* their link stopped working ("already
 * used" vs "expired") is better, safe UX with no meaningful
 * enumeration cost.
 */
export type RedeemDenialReason = 'token_not_found' | 'token_expired' | 'token_already_used' | 'download_limit_reached' | 'asset_unavailable';

export type RedeemResult =
  | { ok: true; asset: DigitalAsset }
  | { ok: false; reason: RedeemDenialReason };

interface ConsumeTokenResult {
  ok: true;
  deliveryId: number;
}
type ConsumeTokenOutcome = ConsumeTokenResult | { ok: false; reason: 'token_not_found' | 'token_expired' | 'token_already_used' };

interface DeliveryLocationRow {
  productSlug: string;
  assetId: string;
}

/**
 * Redeems a single-use download token: consumes it (atomically,
 * exactly once), enforces the delivery's download policy (atomically,
 * at this exact moment — the real, final enforcement of the limit
 * `checkEntitlement()` only pre-checks advisorily), then resolves the
 * actual asset to stream.
 */
export async function redeemDownloadToken(env: Env, logger: Logger, tokenInput: unknown): Promise<RedeemResult> {
  if (typeof tokenInput !== 'string' || !TOKEN_PATTERN.test(tokenInput)) {
    return { ok: false, reason: 'token_not_found' };
  }
  const token = tokenInput;

  const consumed = await consumeTokenAtomic(env, token);
  if (!consumed.ok) {
    logger.warn('download.token_rejected', { tokenPrefix: token.slice(0, 8), reason: consumed.reason });
    return { ok: false, reason: consumed.reason };
  }

  const delivery = await incrementDownloadUsageAtomic(env, consumed.deliveryId);
  if (!delivery) {
    // The token itself was valid and is now consumed (single-use holds
    // regardless), but the delivery's policy (limit reached, revoked,
    // or its own access window expired) no longer allows a download —
    // re-checked fresh here, not trusted from whenever the token was
    // minted up to 15 minutes ago. Folded into one code
    // (DOWNLOAD_LIMIT_REACHED, matching docs/worker-api-design.md's
    // original four-code spec) rather than adding new codes for
    // "revoked"/"access expired" specifically — a finer breakdown can
    // be added later if a real need for it shows up.
    logger.warn('download.limit_reached', { deliveryId: consumed.deliveryId });
    return { ok: false, reason: 'download_limit_reached' };
  }

  const product = await fetchCatalogProduct(env, delivery.productSlug);
  const asset = product ? findPublishedAsset(product, delivery.assetId) : null;
  if (!asset) {
    // Rare: the asset was unpublished/removed between token issuance
    // and redemption. Logged at error severity — this is a content
    // state worth investigating, not a routine denial.
    logger.error('download.asset_missing', { deliveryId: consumed.deliveryId, assetId: delivery.assetId });
    return { ok: false, reason: 'asset_unavailable' };
  }

  logger.info('download.redeemed', { deliveryId: consumed.deliveryId, assetId: asset.assetId });
  return { ok: true, asset };
}

/**
 * The security-critical decision — "may this token be consumed right
 * now" — is one atomic UPDATE, exactly as strict as before: it only
 * ever succeeds for a token that exists, is unused, AND unexpired, all
 * three checked in the same WHERE clause, so there is no read-then-
 * write race window a concurrent redemption could exploit (same
 * pattern as `commerceService.ts`'s status-gated conditional updates).
 * If it fails, a SEPARATE, purely-informational read-only SELECT
 * follows *only* to produce a more specific error message — this
 * second read has no bearing on the security decision already made
 * (the UPDATE already atomically refused), so it introduces no new
 * race condition.
 */
async function consumeTokenAtomic(env: Env, token: string): Promise<ConsumeTokenOutcome> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE download_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at > ?`
  )
    .bind(now, token, now)
    .run();

  if (result.meta.changes === 1) {
    const row = await env.DB.prepare(`SELECT delivery_id AS deliveryId FROM download_tokens WHERE token = ?`)
      .bind(token)
      .first<{ deliveryId: number }>();
    return row ? { ok: true, deliveryId: row.deliveryId } : { ok: false, reason: 'token_not_found' };
  }

  const existing = await env.DB.prepare(`SELECT used_at AS usedAt FROM download_tokens WHERE token = ?`)
    .bind(token)
    .first<{ usedAt: string | null }>();
  if (!existing) return { ok: false, reason: 'token_not_found' };
  if (existing.usedAt !== null) return { ok: false, reason: 'token_already_used' };
  return { ok: false, reason: 'token_expired' }; // exists, unused, but the UPDATE still didn't apply — the only remaining possibility is expires_at <= now
}

/**
 * Atomically increments `downloads_used`, but only if the delivery is
 * not revoked, still within its download limit, and still within its
 * access window — all three re-checked fresh, in the UPDATE's WHERE
 * clause itself, the actual enforcement point for every policy this
 * delivery was granted with.
 */
async function incrementDownloadUsageAtomic(env: Env, deliveryId: number): Promise<DeliveryLocationRow | null> {
  const result = await env.DB.prepare(
    `UPDATE deliveries
     SET downloads_used = downloads_used + 1, last_download_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?
       AND status != 'revoked'
       AND (max_downloads IS NULL OR downloads_used < max_downloads)
       AND (access_expires_at IS NULL OR access_expires_at > datetime('now'))`
  )
    .bind(deliveryId)
    .run();
  if (result.meta.changes !== 1) return null;

  const row = await env.DB.prepare(`SELECT product_slug AS productSlug, asset_id AS assetId FROM deliveries WHERE id = ?`)
    .bind(deliveryId)
    .first<DeliveryLocationRow>();
  return row ?? null;
}

async function getVerifiedPurchaseSession(env: Env, purchaseReference: string): Promise<VerifiedPurchaseSessionRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, product_slug AS productSlug, status FROM purchase_sessions WHERE purchase_reference = ?`
  )
    .bind(purchaseReference)
    .first<VerifiedPurchaseSessionRow>();
  if (!row || row.status !== 'verified') return null;
  return row;
}

async function getDelivery(env: Env, purchaseSessionId: number, assetId: string): Promise<DeliveryRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, max_downloads AS maxDownloads, downloads_used AS downloadsUsed, access_expires_at AS accessExpiresAt, status
     FROM deliveries WHERE purchase_session_id = ? AND asset_id = ?`
  )
    .bind(purchaseSessionId, assetId)
    .first<DeliveryRow>();
  return row ?? null;
}
