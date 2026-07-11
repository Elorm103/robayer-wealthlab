/**
 * Reads a product from the Product Platform for the Commerce Service —
 * see docs/commerce-foundation.md's "Where product data comes from."
 *
 * Deliberately does NOT read from a D1 `products` table.
 * `backend/database/schema.sql`'s `products` table was designed in an
 * earlier sprint, before Sprint 2.1 (Digital Product Platform
 * Foundation) built the real, live product catalog as
 * `content/products/{slug}.json` files served by the static site
 * itself and read by `js/components/product-loader.js`. That table
 * has never been populated and would only drift from the real catalog
 * if used now — so this service fetches the same JSON file the
 * frontend already trusts, over HTTP, from the live site. This keeps
 * exactly one source of truth for product content, matching Sprint
 * 2.2's "no duplicated product data" principle applied to the backend.
 *
 * The Worker never trusts price, currency, or title from the frontend
 * — this file is the only place those values legitimately come from
 * for a checkout request. See docs/commerce-foundation.md's "Security"
 * section.
 */

import type { Env } from '../worker/env';

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
  currency: string | null;
  /** e.g. "1.0" — null for products that haven't set one (see content/SCHEMA.md's Product entry). Also locked into checkout metadata for verification. */
  version: string | null;
  digitalAssets: DigitalAsset[];
  downloadPolicy: DownloadPolicy;
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
export async function fetchCatalogProduct(env: Env, slugInput: unknown): Promise<CatalogProduct | null> {
  if (!isPlausibleSlug(slugInput)) return null;
  const slug = slugInput;

  let response: Response;
  try {
    response = await fetch(`${env.SITE_BASE_URL}/content/products/${slug}.json`);
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;
  if (
    typeof data.id !== 'string' ||
    typeof data.slug !== 'string' ||
    typeof data.title !== 'string' ||
    typeof data.status !== 'string'
  ) {
    return null;
  }
  // Defense in depth: even though the URL already targets `slug`'s own
  // file, confirm the file's own `slug` field actually matches what
  // was requested before trusting anything else in it.
  if (data.slug !== slug) return null;

  return {
    id: data.id,
    slug: data.slug,
    title: data.title,
    status: data.status,
    price: typeof data.price === 'number' ? data.price : null,
    currency: typeof data.currency === 'string' ? data.currency : null,
    version: typeof data.version === 'string' ? data.version : null,
    digitalAssets: parseDigitalAssets(data.downloadFiles, data.slug),
    downloadPolicy: parseDownloadPolicy(data.downloads),
  };
}

/**
 * Parses `downloadFiles` into `DigitalAsset[]`, dropping any entry
 * missing a required field rather than failing the whole product —
 * matching `js/components/product-loader.js`'s own "drop invalid,
 * don't break everything" pattern for content it doesn't fully
 * control the shape of.
 */
function parseDigitalAssets(value: unknown, expectedProductSlug: string): DigitalAsset[] {
  if (!Array.isArray(value)) return [];

  const assets: DigitalAsset[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.assetId !== 'string' ||
      typeof e.productSlug !== 'string' ||
      typeof e.filename !== 'string' ||
      typeof e.displayName !== 'string' ||
      typeof e.fileType !== 'string' ||
      typeof e.storageKey !== 'string' ||
      typeof e.status !== 'string'
    ) {
      continue;
    }
    // Defense in depth, same reasoning as the top-level slug check
    // above: an asset record claiming a different product than the
    // file it was found in is never trusted.
    if (e.productSlug !== expectedProductSlug) continue;

    assets.push({
      assetId: e.assetId,
      productSlug: e.productSlug,
      filename: e.filename,
      displayName: e.displayName,
      fileType: e.fileType,
      fileSizeBytes: typeof e.fileSizeBytes === 'number' ? e.fileSizeBytes : null,
      version: typeof e.version === 'string' ? e.version : null,
      checksum: typeof e.checksum === 'string' ? e.checksum : null,
      storageKey: e.storageKey,
      status: e.status,
    });
  }
  return assets;
}

function parseDownloadPolicy(value: unknown): DownloadPolicy {
  if (!value || typeof value !== 'object') return { maxPerPurchase: null, expiresAfterDays: null };
  const v = value as Record<string, unknown>;
  return {
    maxPerPurchase: typeof v.maxPerPurchase === 'number' ? v.maxPerPurchase : null,
    expiresAfterDays: typeof v.expiresAfterDays === 'number' ? v.expiresAfterDays : null,
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
