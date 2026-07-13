/**
 * GET /api/products, GET /api/products/:slug — Version 2.0 Phase 2
 * (Products Module). The public-facing counterpart to
 * routes/admin/products.ts: read-only, unauthenticated, and only ever
 * returns products in a publicly-listed status (`active` or
 * `coming-soon` — see productService.isPubliclyListedStatus) — a
 * draft/hidden/unavailable/archived product is invisible here exactly
 * as if it didn't exist, matching Media Library's "identical outcome
 * regardless of why" habit for public lookups.
 *
 * This is the intended replacement for `js/components/product-loader.js`
 * fetching `content/products/*.json` directly (task: "Products: public
 * site integration") — the frontend rewrite itself is a separate task;
 * this route is what it will call.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import type { RouteParams } from '../worker/index';
import { jsonError, jsonSuccess } from '../utils/responses';
import * as productService from '../services/productService';
import type { ProductRecord } from '../services/productService';
import { isPubliclyListedStatus } from '../services/productService';

/** Never exposes internal `id`, `createdBy`/`updatedBy`, or the raw `sku` — only what a public page legitimately renders. */
function toPublicShape(product: Omit<ProductRecord, 'files' | 'gallery' | 'relations'>) {
  return {
    id: product.productId,
    slug: product.slug,
    title: product.title,
    subtitle: product.subtitle,
    shortDescription: product.shortDescription,
    description: product.description,
    topic: product.topic,
    productType: product.productType,
    status: product.status,
    price: product.pricePesewas === null ? null : product.pricePesewas / 100,
    compareAtPrice: product.compareAtPricePesewas === null ? null : product.compareAtPricePesewas / 100,
    currency: product.currency,
    version: product.version,
    language: product.language,
    estimatedReadingTime: product.estimatedReadingTime,
    author: product.author,
    coverImage: product.coverPublicUrl,
    thumbnailImage: product.thumbnailPublicUrl,
    previewImage: product.previewPublicUrl,
    featured: product.featured,
    bestseller: product.bestseller,
    newRelease: product.newRelease,
    tags: product.tags ? product.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    seo: {
      title: product.seoTitle,
      description: product.seoDescription,
      canonicalUrl: product.seoCanonicalUrl,
      ogImage: product.ogPublicUrl,
    },
    publishedAt: product.publishedAt,
    updatedAt: product.updatedAt,
  };
}

function toPublicDetailShape(product: ProductRecord) {
  return {
    ...toPublicShape(product),
    gallery: product.gallery.map((g) => g.publicUrl),
    // Files are named/typed for display (e.g. "Ebook.pdf, 2.1 MB") but
    // never expose a storageKey or a direct download URL — a real
    // download always goes through the paid entitlement -> download-
    // token flow (routes/downloads.ts) or, for a free product, through
    // routes/media.ts's own public file route using this same
    // publicUrl (which routes/media.ts already denies for any paid
    // product's file, see that route's updated handler).
    files: product.files
      .filter((f) => f.status === 'published')
      .map((f) => ({ displayName: f.displayName, fileType: f.fileType, publicUrl: f.publicUrl })),
    relatedProducts: product.relations
      .filter((r) => r.relationType === 'related')
      .map((r) => ({ slug: r.relatedProductSlug, title: r.relatedProductTitle })),
    crossSellProducts: product.relations
      .filter((r) => r.relationType === 'cross_sell')
      .map((r) => ({ slug: r.relatedProductSlug, title: r.relatedProductTitle })),
    recommendedProducts: product.relations
      .filter((r) => r.relationType === 'recommended')
      .map((r) => ({ slug: r.relatedProductSlug, title: r.relatedProductTitle })),
  };
}

export async function handlePublicProductsList(request: Request, env: Env, _logger: Logger): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const topicRaw = params.get('topic');
  const productTypeRaw = params.get('productType');
  const featuredRaw = params.get('featured');

  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '24', 10) || 24));

  // Public listing only ever spans the two publicly-listed statuses —
  // never a single `status` query param a caller could set to `draft`
  // to peek at unpublished content. One query, one DB-level page —
  // see listProducts's `statuses` (plural) option.
  const result = await productService.listProducts(env, {
    search: params.get('search'),
    status: null,
    statuses: ['active', 'coming-soon'],
    topic: topicRaw,
    productType: productTypeRaw,
    featured: featuredRaw === 'true' ? true : featuredRaw === 'false' ? false : null,
    showDeleted: false,
    sort: 'newest',
    page,
    pageSize,
  });

  return jsonSuccess({ items: result.items.map(toPublicShape), total: result.total, page: result.page, pageSize: result.pageSize });
}

export async function handlePublicProductGet(_request: Request, env: Env, _logger: Logger, params: RouteParams): Promise<Response> {
  const slug = params.slug;
  if (!slug) return jsonError('PRODUCT_NOT_FOUND', 'This product could not be found.');

  const product = await productService.getProductBySlug(env, slug);
  if (!product || !isPubliclyListedStatus(product.status)) {
    return jsonError('PRODUCT_NOT_FOUND', 'This product could not be found.');
  }

  return jsonSuccess(toPublicDetailShape(product));
}
