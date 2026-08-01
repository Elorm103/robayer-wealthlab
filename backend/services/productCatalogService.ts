/**
 * Reads a product from the Product Platform for the Commerce Service —
 * see docs/commerce-foundation.md's "Where product data comes from."
 *
 * Updated Version 2.0 Phase 2 (Products Module): now reads the real D1
 * `products`/`product_files` tables (migration 0008) instead of
 * fetching `content/products/{slug}.json` over HTTP. D1 is now the
 * live, admin-managed source of truth — the JSON catalog it replaces
 * is deprecated as of this phase (see docs/products-module-implementation.md's
 * migration section). This function's own external contract
 * (`CatalogProduct`/`DigitalAsset`, `fetchCatalogProduct()`'s
 * signature and return shape) is unchanged on purpose, so
 * commerceService.ts / entitlementService.ts / fulfilmentService.ts
 * require zero changes — this was the single integration seam
 * identified during the Phase 2 architecture audit specifically so the
 * JSON-to-D1 switch could happen here alone.
 *
 * The Worker never trusts price, currency, or title from the frontend
 * — this file is the only place those values legitimately come from
 * for a checkout request. See docs/commerce-foundation.md's "Security"
 * section.
 */

import type { Env } from '../worker/env';
import { computeSaleState } from './productService';

/**
 * A Digital Asset — one downloadable file associated with a product.
 * Mirrors content/SCHEMA.md's Product entry's enriched `downloadFiles`
 * shape exactly (Version 1.2 Sprint 2.5, Digital Fulfilment Platform —
 * see docs/digital-fulfilment.md). `assetId` is the stable identifier
 * `deliveries`/`download_tokens` D1 rows reference — never `filename`
 * or `storageKey`, either of which could change without invalidating
 * an already-granted entitlement.
 */
export interface DigitalAsset {
  assetId: string;
  /**
   * The slug of the product this specific file actually belongs to —
   * for a normal product's own asset, identical to the outer
   * CatalogProduct.slug being fetched. For an asset pulled in from a
   * bundle's item products (Version 4.0 Milestone D), this is the
   * ITEM's real slug, not the bundle's — fulfilmentService.ts's
   * grantEntitlement() call site uses this (not the outer purchased
   * slug) so `deliveries.product_slug` correctly attributes each
   * delivery to the real product it came from, not to the bundle
   * wrapper.
   */
  productSlug: string;
  filename: string;
  displayName: string;
  fileType: string;
  fileSizeBytes: number | null;
  version: string | null;
  checksum: string | null;
  /** The planned R2 object key (see docs/storage-strategy.md's bucket layout) — never exposed to a client; only ever read server-side to fetch from the STORAGE binding. */
  storageKey: string;
  /** 'draft' | 'published' | 'archived' — independent of the parent product's own `status`, so one file can be pulled/swapped without touching the product's sale status. */
  status: string;
}

/** content/products/{slug}.json's `downloads` policy object — see docs/digital-fulfilment.md's "Download policy." `null` means unlimited/lifetime, not "unset." */
export interface DownloadPolicy {
  maxPerPurchase: number | null;
  expiresAfterDays: number | null;
}

const PUBLISHED_ASSET_STATUS = 'published';

export function isAssetPublished(asset: DigitalAsset): boolean {
  return asset.status === PUBLISHED_ASSET_STATUS;
}

export interface CatalogProduct {
  /** content/products/{slug}.json's own `id` field (e.g. "prod-starting-to-invest-with-gh100") — distinct from `slug`, locked into Paystack metadata at checkout time for Sprint 2.4's verification cross-check. See docs/payment-verification.md. */
  id: string;
  slug: string;
  title: string;
  status: string;
  price: number | null;
  /**
   * Version 3.4.2 Milestone M6.2 (Dynamic Pricing) - the price checkout
   * must actually charge right now: the live sale price while a sale is
   * active, otherwise the same as `price`. Computed here, at the one
   * place this file's own header comment already establishes as "the
   * only place price legitimately comes from for a checkout request" -
   * commerceService.ts reads this, never `price` directly, so a sale's
   * start/end dates are honored down to the second regardless of when
   * within that window the request happens to land.
   */
  effectivePrice: number | null;
  currency: string | null;
  /** e.g. "1.0" — null for products that haven't set one (see content/SCHEMA.md's Product entry). Also locked into checkout metadata for verification. */
  version: string | null;
  digitalAssets: DigitalAsset[];
  downloadPolicy: DownloadPolicy;
  /** 'inclusive' | 'exclusive' | 'exempt' — Version 3.0.2 Milestone M2 (Orders, Receipts & Customer Library), see services/orders/taxService.ts. Already a live `products` column since before M1; simply not read by this function until M2 needed it for receipt generation. */
  taxBehavior: string;
  /** Version 4.0 Milestone D — see migration 0027. Not read by commerceService.ts/fulfilmentService.ts at all (a bundle checks out and fulfils through the exact same code paths as any product); present here purely for callers that want to display or log bundle-ness honestly, e.g. a future admin diagnostic. */
  isBundle: boolean;
}

const PURCHASABLE_STATUS = 'active';

/**
 * Same shape a URL path segment/slug must always have across this
 * project (content/products/, books/{slug}/) — rejecting anything
 * else here means a malformed or hostile productId never even reaches
 * a fetch() call.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

export function isPlausibleSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

/**
 * Fetches and shape-validates one product record. Returns null for
 * anything that doesn't resolve to a well-formed product — an unknown
 * slug, a network failure, or a JSON file missing required fields are
 * all treated identically by the caller (see commerceService.ts),
 * never distinguished in a way that would leak which slugs exist.
 */
interface ProductRow {
  product_id: string;
  slug: string;
  title: string;
  status: string;
  price_pesewas: number | null;
  sale_price_pesewas: number | null;
  sale_enabled: number;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  currency: string;
  version: string | null;
  max_downloads: number | null;
  download_expires_days: number | null;
  tax_behavior: string;
  is_bundle: number;
}

interface ProductFileRow {
  asset_id: string;
  display_name: string;
  file_type: string;
  version: string | null;
  status: string;
  storage_key: string;
  original_filename: string;
  size_bytes: number;
  content_hash: string;
  /** Only present on the bundle-items query below — the item's own real slug, distinct from the outer bundle's slug. Falls back to the outer product's slug for a normal (non-bundle) product's own files. */
  item_slug?: string;
}

export async function fetchCatalogProduct(env: Env, slugInput: unknown): Promise<CatalogProduct | null> {
  if (!isPlausibleSlug(slugInput)) return null;
  const slug = slugInput;

  const productRow = await env.DB.prepare(
    `SELECT product_id, slug, title, status, price_pesewas, sale_price_pesewas, sale_enabled, sale_starts_at, sale_ends_at,
            currency, version, max_downloads, download_expires_days, tax_behavior, is_bundle
     FROM products WHERE slug = ? AND deleted_at IS NULL`
  )
    .bind(slug)
    .first<ProductRow>();
  if (!productRow) return null;

  // The bundle's own files (normally none — a bundle typically has zero
  // product_files of its own, since everything it delivers belongs to
  // its item products — but not forbidden, in case a bundle ever ships
  // its own extra bonus file alongside its items).
  const { results: ownFileRows } = await env.DB.prepare(
    `SELECT pf.asset_id, pf.display_name, pf.file_type, pf.version, pf.status,
            m.storage_key, m.original_filename, m.size_bytes, m.content_hash
     FROM product_files pf
     JOIN media_assets m ON m.id = pf.media_id
     WHERE pf.product_id = (SELECT id FROM products WHERE slug = ?)
     ORDER BY pf.sort_order ASC, pf.id ASC`
  )
    .bind(slug)
    .all<ProductFileRow>();

  // Version 4.0 Milestone D (Second Product Ecosystem & Bundles) — the
  // one integration seam that makes fulfilmentService.fulfilPurchase(),
  // resolveAssetsWithDeliveryInfo() (Customer Library), and
  // getFulfilmentStatus() all correctly handle a bundle purchase with
  // ZERO changes to any of those three functions: a bundle's
  // `digitalAssets` is the union of every item product's own published
  // files, each still carrying ITS OWN real slug (not the bundle's) via
  // `item_slug` below — see DigitalAsset.productSlug's own doc comment
  // for why that distinction matters to fulfilmentService.ts's
  // grantEntitlement() call site.
  let bundleItemFileRows: ProductFileRow[] = [];
  if (productRow.is_bundle === 1) {
    const { results } = await env.DB.prepare(
      `SELECT pf.asset_id, pf.display_name, pf.file_type, pf.version, pf.status,
              m.storage_key, m.original_filename, m.size_bytes, m.content_hash, ip.slug AS item_slug
       FROM bundle_items bi
       JOIN products ip ON ip.id = bi.item_product_id AND ip.deleted_at IS NULL
       JOIN product_files pf ON pf.product_id = ip.id
       JOIN media_assets m ON m.id = pf.media_id
       WHERE bi.bundle_product_id = (SELECT id FROM products WHERE slug = ?)
       ORDER BY bi.sort_order ASC, pf.sort_order ASC, pf.id ASC`
    )
      .bind(slug)
      .all<ProductFileRow>();
    bundleItemFileRows = results;
  }

  const digitalAssets: DigitalAsset[] = [...ownFileRows, ...bundleItemFileRows].map((row) => ({
    assetId: row.asset_id,
    productSlug: row.item_slug ?? slug,
    filename: row.original_filename,
    displayName: row.display_name,
    fileType: row.file_type,
    fileSizeBytes: row.size_bytes,
    version: row.version,
    checksum: row.content_hash,
    storageKey: row.storage_key,
    status: row.status,
  }));

  return {
    id: productRow.product_id,
    slug: productRow.slug,
    title: productRow.title,
    status: productRow.status,
    // price_pesewas (integer, smallest unit) -> price (major-unit
    // display number) — this function's contract has always returned
    // price in major units (commerceService.ts multiplies by 100
    // itself); D1 stores the integer form instead, so the conversion
    // happens once, here, at the boundary.
    price: productRow.price_pesewas === null ? null : productRow.price_pesewas / 100,
    effectivePrice: (() => {
      const sale = computeSaleState({
        pricePesewas: productRow.price_pesewas,
        salePricePesewas: productRow.sale_price_pesewas,
        saleEnabled: productRow.sale_enabled === 1,
        saleStartsAt: productRow.sale_starts_at,
        saleEndsAt: productRow.sale_ends_at,
      });
      const effectivePesewas = sale.isActive ? sale.effectivePricePesewas : productRow.price_pesewas;
      return effectivePesewas === null ? null : effectivePesewas / 100;
    })(),
    currency: productRow.currency,
    version: productRow.version,
    digitalAssets,
    downloadPolicy: { maxPerPurchase: productRow.max_downloads, expiresAfterDays: productRow.download_expires_days },
    taxBehavior: productRow.tax_behavior,
    isBundle: productRow.is_bundle === 1,
  };
}

/** Finds one asset belonging to a product by its stable `assetId` — returns `null` if not found or not published, never distinguishing the two to a caller (see docs/digital-fulfilment.md's "Security"). */
export function findPublishedAsset(product: CatalogProduct, assetId: string): DigitalAsset | null {
  const asset = product.digitalAssets.find((a) => a.assetId === assetId);
  if (!asset || !isAssetPublished(asset)) return null;
  return asset;
}

/**
 * A single check covering every non-purchasable state at once —
 * draft, archived, coming-soon, and any future status value the
 * catalog ever adds (e.g. "hidden"/"discontinued") — rather than
 * enumerating each one. See docs/commerce-foundation.md's "Product
 * validation" section for why this is deliberately a whitelist
 * ("only 'active' passes"), not a blacklist of rejected statuses.
 * A free product (price === 0) is also rejected — checkout is for
 * paid purchases; free content already has its own delivery path
 * (e.g. the lead-magnet flow), not this one.
 */
export function isPurchasable(product: CatalogProduct): boolean {
  return (
    product.status === PURCHASABLE_STATUS &&
    typeof product.price === 'number' &&
    product.price > 0 &&
    typeof product.currency === 'string' &&
    product.currency.length > 0
  );
}
