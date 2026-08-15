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
import { issuePasswordToken } from './customer/authService';
import { computeSaleState } from './productService';

export interface FulfilPurchaseInput {
  purchaseSessionId: number;
  purchaseReference: string;
  productSlug: string;
  /** The provider-confirmed email from Sprint 2.4's verification — never a client-supplied value. See docs/payment-verification.md's "Email strategy." */
  customerEmail: string | null;
  amountPesewas: number;
  currency: string;
  /**
   * Version 3.0.2 Milestone M1 — set by commerceService.ts's
   * customer-provisioning step, which always runs before this is
   * called. `customerId` is null only if provisioning itself failed or
   * was skipped (no confirmed email) — fulfilment still proceeds either
   * way; the download entitlement never depends on a customer record
   * existing, per the ratified Blueprint's own "email-link access
   * preserved permanently" decision (ADR-003).
   */
  customerId: number | null;
  /** True only for a newly-created customers row — gates the one-time welcome/password-setup email (Deliverable 7: sent once, never repeated on a later guest purchase under the same email). */
  isNewCustomer: boolean;
}

/**
 * Grants an entitlement for every currently-published asset on a
 * product that doesn't already have one for this purchase — the entitlement
 * half of `fulfilPurchase()`, factored out so it can also be run AFTER
 * verification, for a purchase whose product had zero published assets at
 * the time it was first verified (a content-authoring gap, not a payment
 * one — see this file's own "fulfilment.no_published_assets" log line).
 * Never sends email itself; the caller decides whether/what to send once
 * it knows what, if anything, was newly granted. Safe to call any number
 * of times for the same purchase — `grantEntitlement()`'s own
 * `INSERT OR IGNORE` makes a second call for an already-granted asset a
 * true no-op.
 */
export async function ensureEntitlementsGranted(env: Env, logger: Logger, purchaseSessionId: number, productSlug: string): Promise<string[]> {
  const product = await fetchCatalogProduct(env, productSlug);
  if (!product) {
    logger.error('fulfilment.product_not_found', { purchaseSessionId, productSlug });
    return [];
  }

  const publishedAssets = product.digitalAssets.filter(isAssetPublished);
  if (publishedAssets.length === 0) {
    logger.error('fulfilment.no_published_assets', { purchaseSessionId, productSlug });
    return [];
  }

  const newlyGrantedAssetIds: string[] = [];
  for (const asset of publishedAssets) {
    // Version 4.0 Milestone D (Second Product Ecosystem & Bundles) —
    // asset.productSlug, NOT productSlug: for a normal product these are
    // identical, but for a bundle purchase productSlug is the bundle's
    // own slug while each asset carries the real item product's slug it
    // actually came from (see productCatalogService.ts's
    // DigitalAsset.productSlug comment) — this one substitution is what
    // makes deliveries.product_slug correctly attribute each entitlement
    // to its real source product.
    const granted = await grantEntitlement(env, purchaseSessionId, asset.productSlug, asset, product.downloadPolicy);
    if (granted) newlyGrantedAssetIds.push(asset.assetId);
  }
  if (newlyGrantedAssetIds.length > 0) {
    await markDelivered(env, purchaseSessionId, newlyGrantedAssetIds);
  }
  return newlyGrantedAssetIds;
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
    const newlyGrantedAssetIds = await ensureEntitlementsGranted(env, logger, input.purchaseSessionId, input.productSlug);

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

    const product = await fetchCatalogProduct(env, input.productSlug);
    await sendFulfilmentEmails(env, logger, input, product?.title ?? input.productSlug);

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
 * Two or three emails, matching backend/emails/README.md's
 * already-planned template names — reusing services/emailService.ts
 * exactly as every other triggering action already does, never a
 * second email-sending code path. See docs/digital-fulfilment.md's
 * "Email integration."
 *
 * Milestone M1 adds a third, conditional email: the welcome/
 * password-setup invite, sent only when this purchase created a new
 * `customers` row (`input.isNewCustomer`) — never on a second guest
 * purchase under an email that already has an account, per the
 * ratified Blueprint's Deliverable 7 ("sent once, never repeated").
 * Uses `authService.issuePasswordToken()`, the same shared mechanism a
 * later self-service password reset uses — see that function's own
 * doc comment.
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

  if (input.isNewCustomer && input.customerId) {
    try {
      await issuePasswordToken(env, logger, input.customerId, input.customerEmail as string, env.SITE_BASE_URL, 'customer-welcome');
    } catch (err) {
      // Same "never let an email failure affect fulfilment" discipline
      // this whole function already operates under (its caller wraps
      // everything in a try/catch that only logs) — explicit here too
      // since this is the one email in this function that isn't itself
      // already inside sendEmail()'s own never-throws contract.
      logger.error('fulfilment.welcome_email_failed', {
        purchaseReference: input.purchaseReference,
        customerId: input.customerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
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
// 'refunded' added Version 3.0.2 Milestone M2 (Orders, Receipts &
// Customer Library) — see docs/v3.0.2-m2-customer-library-ux-plan.md's
// "Purchase status" section. purchase_sessions.status already had a
// live 'refunded' enum value since before M1; this is the first code
// path that actually surfaces it distinctly to a visitor, once
// services/orders/revocationService.ts sets it.
export type CustomerFacingStatus = 'processing' | 'ready' | 'unavailable' | 'refunded';

/** Revenue Engine Phase 6 — the "complete the collection" post-purchase offer, see getFulfilmentStatus()'s own comment for eligibility. */
export interface FulfilmentBundleUpsell {
  bundleSlug: string;
  bundleTitle: string;
  priceDisplay: string;
  savedDisplay: string | null;
}

export interface FulfilmentStatus {
  status: CustomerFacingStatus;
  purchaseReference: string;
  productTitle: string;
  amountDisplay: string;
  /** Only populated when `status === 'ready'`. */
  assets: FulfilmentStatusAsset[];
  /** Milestone M2 — null until the order-artifacts pass has run (or if it failed and hasn't yet been retried). */
  receiptNumber: string | null;
  /**
   * Revenue Engine Phase 6 (Financial Literacy Bundle post-purchase
   * upsell). `null` unless ALL of: this purchase's own product is one
   * of the bundle's components, the bundle itself is `status='active'`,
   * and — computed here, server-side, never trusting anything the
   * client could claim — this customer's email has no OTHER verified
   * purchase of any bundle component from before this exact purchase
   * (the approved ownership-eligibility rule: showing the bundle to
   * someone who already owns part of it would mean selling them
   * content they already paid for, which this rule exists to prevent).
   * A `purchase_reference` is a public URL parameter with no login
   * required, so this can never be computed client-side.
   */
  bundleUpsell: FulfilmentBundleUpsell | null;
}

interface PurchaseSessionSummaryRow {
  status: string;
  productSlug: string;
  productTitle: string;
  amountPesewas: number;
  currency: string;
  purchaseReference: string;
  /** Read only to compute bundleUpsell below — never included in the returned FulfilmentStatus itself, matching this file's existing "no internal identifiers exposed" convention. */
  customerEmail: string | null;
}

interface BundleProductRow {
  id: number;
  slug: string;
  title: string;
  status: string;
  price_pesewas: number | null;
  sale_price_pesewas: number | null;
  sale_enabled: number;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
}

function formatGHSPesewas(pesewas: number): string {
  const rounded = Math.round(pesewas) / 100;
  const withSeparators = Math.abs(rounded).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `GH₵${withSeparators}`;
}

const BUNDLE_SLUG = 'financial-literacy-bundle';

/**
 * Business decision (Financial Literacy Bundle launch, approved
 * release phase) — the post-purchase "complete the collection" offer
 * at the bundle's flat full price is economically unfavorable to the
 * customer in 2 of its 3 possible first-purchase scenarios (buying the
 * two missing books individually is cheaper than the GH₵99.99 bundle
 * in those cases). The public bundle page, its cross-sell CTA on
 * individual book pages, checkout, fulfilment, and analytics all stay
 * fully live — only this one post-purchase offer is disabled, by
 * short-circuiting computeBundleUpsell() to always return null,
 * without touching its eligibility logic. Flip back to `false` once a
 * proper partial-completion ("missing books only") offer replaces the
 * current flat-price one — a separate, later phase, not built here.
 */
const POST_PURCHASE_BUNDLE_UPSELL_DISABLED = true;

async function computeBundleUpsell(env: Env, session: PurchaseSessionSummaryRow): Promise<FulfilmentBundleUpsell | null> {
  if (POST_PURCHASE_BUNDLE_UPSELL_DISABLED) return null;
  if (!session.customerEmail) return null;

  const bundleRow = await env.DB.prepare(
    `SELECT id, slug, title, status, price_pesewas, sale_price_pesewas, sale_enabled, sale_starts_at, sale_ends_at
     FROM products WHERE slug = ? AND is_bundle = 1 AND deleted_at IS NULL`
  )
    .bind(BUNDLE_SLUG)
    .first<BundleProductRow>();
  if (!bundleRow || bundleRow.status !== 'active') return null;

  const { results: itemRows } = await env.DB.prepare(
    `SELECT ip.slug FROM bundle_items bi JOIN products ip ON ip.id = bi.item_product_id AND ip.deleted_at IS NULL WHERE bi.bundle_product_id = ?`
  )
    .bind(bundleRow.id)
    .all<{ slug: string }>();
  const itemSlugs = itemRows.map((r) => r.slug);
  if (itemSlugs.length === 0) return null;

  // Only offer "complete the collection" on the confirmation page of a
  // purchase that is itself one of the bundle's own components — never
  // on an unrelated product's confirmation page.
  if (!itemSlugs.includes(session.productSlug)) return null;

  // Approved ownership rule: show only if, excluding this exact
  // purchase, the customer owns none of the bundle's components yet.
  const placeholders = itemSlugs.map(() => '?').join(',');
  const priorOwned = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM purchase_sessions
     WHERE customer_email = ? AND status = 'verified' AND product_slug IN (${placeholders}) AND purchase_reference != ?`
  )
    .bind(session.customerEmail, ...itemSlugs, session.purchaseReference)
    .first<{ n: number }>();
  if (!priorOwned || priorOwned.n > 0) return null;

  const sale = computeSaleState({
    pricePesewas: bundleRow.price_pesewas,
    salePricePesewas: bundleRow.sale_price_pesewas,
    saleEnabled: bundleRow.sale_enabled === 1,
    saleStartsAt: bundleRow.sale_starts_at,
    saleEndsAt: bundleRow.sale_ends_at,
  });
  const chargeablePesewas = sale.isActive ? sale.effectivePricePesewas : bundleRow.price_pesewas;
  if (chargeablePesewas === null) return null;

  return {
    bundleSlug: bundleRow.slug,
    bundleTitle: bundleRow.title,
    priceDisplay: formatGHSPesewas(chargeablePesewas),
    savedDisplay: sale.isActive ? formatGHSPesewas(sale.amountSavedPesewas as number) : null,
  };
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
            amount_pesewas AS amountPesewas, currency, purchase_reference AS purchaseReference,
            customer_email AS customerEmail
     FROM purchase_sessions WHERE purchase_reference = ?`
  )
    .bind(purchaseReference)
    .first<PurchaseSessionSummaryRow>();

  if (!session) return null;

  const customerStatus: CustomerFacingStatus =
    session.status === 'verified'
      ? 'ready'
      : session.status === 'pending'
        ? 'processing'
        : session.status === 'refunded'
          ? 'refunded'
          : 'unavailable';

  let assets: FulfilmentStatusAsset[] = [];
  let receiptNumber: string | null = null;
  let bundleUpsell: FulfilmentBundleUpsell | null = null;
  if (customerStatus === 'ready') {
    // Deliberately NOT populated for 'refunded' — a revoked entitlement
    // must never be listed as downloadable, even though the real
    // access gate (entitlementService.ts's deliveries.status check)
    // would independently deny the actual download attempt regardless.
    // Listing it anyway would be confusing at best.
    const product = await fetchCatalogProduct(env, session.productSlug);
    if (product) {
      assets = product.digitalAssets
        .filter(isAssetPublished)
        .map((asset) => ({ assetId: asset.assetId, displayName: asset.displayName, fileType: asset.fileType }));
    }
    bundleUpsell = await computeBundleUpsell(env, session);
  }
  if (customerStatus === 'ready' || customerStatus === 'refunded') {
    // The receipt itself remains viewable/downloadable even after a
    // refund — a receipt is a historical financial record, not an
    // access grant (see docs/v3.0.2-m2-database-planning-report.md's
    // retention note: receipts are never deleted).
    const receiptRow = await env.DB.prepare(
      `SELECT receipt_number AS receiptNumber FROM receipts
       WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`
    )
      .bind(purchaseReference)
      .first<{ receiptNumber: string | null }>();
    receiptNumber = receiptRow?.receiptNumber ?? null;
  }

  return {
    status: customerStatus,
    purchaseReference,
    productTitle: session.productTitle,
    amountDisplay: formatAmount(session.amountPesewas, session.currency),
    assets,
    receiptNumber,
    bundleUpsell,
  };
}

// ============================================================
// Asset + delivery info for the Customer Library — Version 3.1
// Milestone M3 (Checkout Auto-Provisioning & Dashboard MVP). See
// docs/v3.1-m3-api-gap-analysis.md's Gap 1/2.
// ============================================================

export interface AssetDeliveryInfo {
  assetId: string;
  displayName: string;
  fileType: string;
  /** True once services/orders/revocationService.ts has revoked this entitlement (e.g. after a refund) — the Library must show this distinctly, never offer a Download action for it. */
  revoked: boolean;
  downloadsUsed: number;
  /** Null = unlimited, mirrors deliveries.max_downloads' own nullability. */
  maxDownloads: number | null;
  lastDownloadAt: string | null;
}

interface DeliveryUsageRow {
  assetId: string;
  status: string;
  downloadsUsed: number;
  maxDownloads: number | null;
  lastDownloadAt: string | null;
}

/**
 * Every published asset for a product, joined against this specific
 * purchase's own `deliveries` row (if fulfilment has run) for its
 * usage/limit/revocation state. Deliberately a separate function from
 * `getFulfilmentStatus()`'s own `assets` field, which stays narrower
 * (assetId/displayName/fileType only) to avoid changing the
 * already-tested, already-live guest-facing `GET /api/purchases/:reference`
 * response shape - this richer shape is for the customer-authenticated
 * Library only (`purchaseHistoryService.ts`), per
 * docs/v3.1-m3-api-gap-analysis.md's explicit "don't touch the guest
 * contract" reasoning.
 */
export async function resolveAssetsWithDeliveryInfo(env: Env, purchaseSessionId: number, productSlug: string): Promise<AssetDeliveryInfo[]> {
  const product = await fetchCatalogProduct(env, productSlug);
  if (!product) return [];

  const publishedAssets = product.digitalAssets.filter(isAssetPublished);
  if (publishedAssets.length === 0) return [];

  const { results } = await env.DB.prepare(
    `SELECT asset_id AS assetId, status, downloads_used AS downloadsUsed, max_downloads AS maxDownloads, last_download_at AS lastDownloadAt
     FROM deliveries WHERE purchase_session_id = ?`
  )
    .bind(purchaseSessionId)
    .all<DeliveryUsageRow>();

  const deliveryByAsset = new Map(results.map((row) => [row.assetId, row]));

  return publishedAssets.map((asset) => {
    const delivery = deliveryByAsset.get(asset.assetId);
    return {
      assetId: asset.assetId,
      displayName: asset.displayName,
      fileType: asset.fileType,
      revoked: delivery?.status === 'revoked',
      downloadsUsed: delivery?.downloadsUsed ?? 0,
      maxDownloads: delivery?.maxDownloads ?? null,
      lastDownloadAt: delivery?.lastDownloadAt ?? null,
    };
  });
}
