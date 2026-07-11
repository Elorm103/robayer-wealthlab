/**
 * Fulfilment Service — Version 1.2 Sprint 2.5 (Digital Fulfilment
 * Platform). See docs/digital-fulfilment.md.
 *
 * Orchestrates what happens once a payment is verified, and nothing
 * before that point: for each published digital asset on the
 * purchased product, grant an entitlement (a `deliveries` row) and
 * notify the buyer by email. Never decides whether a payment
 * succeeded — that remains exclusively commerceService.ts's job (see
 * docs/payment-verification.md); this service only ever runs *after*
 * that decision was already made.
 *
 * Idempotent by construction: `deliveries`'s
 * `UNIQUE(purchase_session_id, asset_id)` index means calling
 * `fulfilPurchase()` twice for the same purchase never creates a
 * duplicate entitlement or sends a duplicate email for an
 * already-fulfilled asset — the second call recognizes nothing needs
 * to happen and returns quietly. This makes fulfilment safely
 * retryable (e.g. after a transient failure) with no separate
 * idempotency key needed, the same pattern already established by
 * `payment_transactions.paystack_reference`.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { fetchCatalogProduct, isAssetPublished, type DigitalAsset, type DownloadPolicy } from './productCatalogService';
import { sendEmail } from './emailService';

export interface FulfilPurchaseInput {
  purchaseSessionId: number;
  purchaseReference: string;
  productSlug: string;
  /** The provider-confirmed email from Sprint 2.4's verification — never a client-supplied value. See docs/payment-verification.md's "Email strategy." */
  customerEmail: string | null;
  amountPesewas: number;
  currency: string;
}

/**
 * Fulfils a verified purchase: grants an entitlement for every
 * published asset on the product, then emails the buyer. Never throws
 * back into the caller — a fulfilment failure must never affect the
 * payment-verification outcome that already succeeded (see
 * commerceService.ts's call site). Any error here is caught, logged,
 * and left for a retry (either a future scheduled sweep, or simply
 * this same webhook being redelivered — see "Deferred work" in
 * docs/digital-fulfilment.md).
 */
export async function fulfilPurchase(env: Env, logger: Logger, input: FulfilPurchaseInput): Promise<void> {
  try {
    const product = await fetchCatalogProduct(env, input.productSlug);
    if (!product) {
      logger.error('fulfilment.product_not_found', { purchaseReference: input.purchaseReference, productSlug: input.productSlug });
      return;
    }

    const publishedAssets = product.digitalAssets.filter(isAssetPublished);
    if (publishedAssets.length === 0) {
      // Honest, not silent: a purchasable product with zero published
      // assets is a content-authoring gap, not a customer-facing
      // error — logged at error severity so it gets noticed, never
      // thrown back to break the (already-succeeded) verification.
      logger.error('fulfilment.no_published_assets', { purchaseReference: input.purchaseReference, productSlug: input.productSlug });
      return;
    }

    const newlyGrantedAssetIds: string[] = [];
    for (const asset of publishedAssets) {
      const granted = await grantEntitlement(env, input.purchaseSessionId, input.productSlug, asset, product.downloadPolicy);
      if (granted) newlyGrantedAssetIds.push(asset.assetId);
    }

    if (newlyGrantedAssetIds.length === 0) {
      // Every asset already had a delivery row — this purchase was
      // already fulfilled by an earlier call (e.g. this exact webhook
      // redelivered). Idempotent no-op, not an error.
      logger.info('fulfilment.already_fulfilled', { purchaseReference: input.purchaseReference });
      return;
    }

    logger.info('fulfilment.entitlements_granted', {
      purchaseReference: input.purchaseReference,
      assetIds: newlyGrantedAssetIds,
    });

    if (!input.customerEmail) {
      // Should not happen — Sprint 2.4 only reaches 'verified' with a
      // provider-confirmed email — but never crash fulfilment over a
      // missing email; the entitlement already exists and is usable
      // from the fulfilment page regardless of whether email succeeds.
      logger.error('fulfilment.no_customer_email', { purchaseReference: input.purchaseReference });
      return;
    }

    await sendFulfilmentEmails(env, logger, input, product.title);
    await markDelivered(env, input.purchaseSessionId, newlyGrantedAssetIds);

    logger.info('fulfilment.delivered', { purchaseReference: input.purchaseReference, assetIds: newlyGrantedAssetIds });
  } catch (err) {
    logger.error('fulfilment.error', {
      purchaseReference: input.purchaseReference,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Returns `true` only if this call genuinely created a new delivery
 * row — `false` means one already existed for this (purchase, asset)
 * pair. `INSERT OR IGNORE` relies on `deliveries`'s
 * `UNIQUE(purchase_session_id, asset_id)` index to make this atomic,
 * the same pattern as `payment_transactions.paystack_reference`.
 */
async function grantEntitlement(
  env: Env,
  purchaseSessionId: number,
  productSlug: string,
  asset: DigitalAsset,
  policy: DownloadPolicy
): Promise<boolean> {
  const accessExpiresAt = policy.expiresAfterDays !== null
    ? new Date(Date.now() + policy.expiresAfterDays * 24 * 60 * 60_000).toISOString()
    : null;

  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO deliveries
       (purchase_session_id, asset_id, product_slug, max_downloads, access_expires_at, status)
     VALUES (?, ?, ?, ?, ?, 'ready')`
  )
    .bind(purchaseSessionId, asset.assetId, productSlug, policy.maxPerPurchase, accessExpiresAt)
    .run();

  return result.meta.changes === 1;
}

async function markDelivered(env: Env, purchaseSessionId: number, assetIds: string[]): Promise<void> {
  for (const assetId of assetIds) {
    await env.DB.prepare(
      `UPDATE deliveries SET status = 'delivered', delivered_at = datetime('now'), updated_at = datetime('now')
       WHERE purchase_session_id = ? AND asset_id = ? AND status = 'ready'`
    )
      .bind(purchaseSessionId, assetId)
      .run();
  }
}

/**
 * Two emails, matching backend/emails/README.md's already-planned
 * template names — reusing services/emailService.ts exactly as every
 * other triggering action already does, never a second email-sending
 * code path. See docs/digital-fulfilment.md's "Email integration."
 */
async function sendFulfilmentEmails(env: Env, logger: Logger, input: FulfilPurchaseInput, productTitle: string): Promise<void> {
  const amountDisplay = formatAmount(input.amountPesewas, input.currency);
  const fulfilmentUrl = `${env.SITE_BASE_URL}/checkout/callback/?ref=${encodeURIComponent(input.purchaseReference)}`;

  await sendEmail(env, logger, {
    template: 'purchase-receipt',
    to: input.customerEmail as string,
    data: {
      purchaseReference: input.purchaseReference,
      productTitle,
      amount: amountDisplay,
    },
    entityType: 'purchase_session',
    entityId: input.purchaseSessionId,
  });

  await sendEmail(env, logger, {
    template: 'secure-download',
    to: input.customerEmail as string,
    data: {
      purchaseReference: input.purchaseReference,
      productTitle,
      fulfilmentUrl,
    },
    entityType: 'purchase_session',
    entityId: input.purchaseSessionId,
  });
}

function formatAmount(amountPesewas: number, currency: string): string {
  const symbol = currency === 'GHS' ? 'GH₵' : `${currency} `;
  const display = (amountPesewas / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${symbol}${display}`;
}

// ============================================================
// Fulfilment status — the fulfilment page's one read
// ============================================================

export interface FulfilmentStatusAsset {
  assetId: string;
  displayName: string;
  fileType: string;
}

/**
 * The only vocabulary ever shown to a visitor — deliberately coarser
 * than `purchase_sessions.status`'s six internal values (see
 * docs/payment-verification.md's "Purchase state machine"). A
 * visitor never needs to know, and should never be told, whether a
 * purchase is `failed` vs `expired` vs `cancelled` — all three read
 * identically as `'unavailable'`. See docs/digital-fulfilment.md's
 * "Security" — "Do not expose internal identifiers" extends to
 * internal *state names*, not just database ids.
 */
export type CustomerFacingStatus = 'processing' | 'ready' | 'unavailable';

export interface FulfilmentStatus {
  status: CustomerFacingStatus;
  purchaseReference: string;
  productTitle: string;
  amountDisplay: string;
  /** Only populated when `status === 'ready'`. */
  assets: FulfilmentStatusAsset[];
}

interface PurchaseSessionSummaryRow {
  status: string;
  productSlug: string;
  productTitle: string;
  amountPesewas: number;
  currency: string;
}

/**
 * The one read the fulfilment page (and its "has this purchase been
 * verified?" API route) ever needs. Read-only; never mutates
 * anything, never mints a download token — see entitlementService.ts
 * for that.
 */
export async function getFulfilmentStatus(env: Env, purchaseReference: string): Promise<FulfilmentStatus | null> {
  const session = await env.DB.prepare(
    `SELECT status, product_slug AS productSlug, product_title AS productTitle,
            amount_pesewas AS amountPesewas, currency
     FROM purchase_sessions WHERE purchase_reference = ?`
  )
    .bind(purchaseReference)
    .first<PurchaseSessionSummaryRow>();

  if (!session) return null;

  const customerStatus: CustomerFacingStatus =
    session.status === 'verified' ? 'ready' : session.status === 'pending' ? 'processing' : 'unavailable';

  let assets: FulfilmentStatusAsset[] = [];
  if (customerStatus === 'ready') {
    const product = await fetchCatalogProduct(env, session.productSlug);
    if (product) {
      assets = product.digitalAssets
        .filter(isAssetPublished)
        .map((asset) => ({ assetId: asset.assetId, displayName: asset.displayName, fileType: asset.fileType }));
    }
  }

  return {
    status: customerStatus,
    purchaseReference,
    productTitle: session.productTitle,
    amountDisplay: formatAmount(session.amountPesewas, session.currency),
    assets,
  };
}
