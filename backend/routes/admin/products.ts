/**
 * /api/admin/products/* — Version 2.0 Phase 2 (Products Module). See
 * docs/products-module-implementation.md and services/productService.ts (all
 * real logic lives there; this file is the thin HTTP layer only, per
 * this project's established routes/ convention — see routes/admin/media.ts).
 *
 * Role gating: viewing (list/get/meta) is open to every authenticated
 * role (support/viewer included, read-only). Every mutation (create,
 * update, files/gallery/relations, status transitions, duplicate,
 * delete, restore, bulk) requires `editor` or `super_admin` — matching
 * the brief's "Editors can create/edit but not permanently delete" (no
 * endpoint here ever hard-deletes a product at all; soft delete/restore
 * mirrors the Media Library precedent, so "not permanently delete" is
 * satisfied by construction, not by a narrower role check).
 *
 * Price is accepted/returned over the wire in major currency units
 * (GHS, e.g. 39.99) — matching content/products/*.json's existing
 * `price` convention and commerceService.ts's own display-number
 * assumption — and converted to/from `price_pesewas` (the integer
 * column productService.ts actually stores) right here at the HTTP
 * boundary, the same place commerceService.ts does the same conversion
 * today.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import * as productService from '../../services/productService';
import type { ProductInput, ProductRecord, LifecycleAction } from '../../services/productService';
import { TOPICS, PRODUCT_TYPES, PRODUCT_STATUSES } from '../../services/productService';

const EDITOR_ROLES = ['super_admin', 'editor'] as const;

const WRITE_RATE_LIMIT = { endpoint: 'products-write', limit: 60, windowSeconds: 15 * 60 };

function toPesewas(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return NaN; // signals "present but invalid" to the caller
  return Math.round(value * 100);
}

function fromPesewas(value: number | null): number | null {
  return value === null ? null : Math.round(value) / 100;
}

/** Every response shape the admin frontend consumes — camelCase, price in major units. */
function toApiShape(product: ProductRecord) {
  return {
    id: product.id,
    productId: product.productId,
    slug: product.slug,
    title: product.title,
    subtitle: product.subtitle,
    shortDescription: product.shortDescription,
    description: product.description,
    topic: product.topic,
    productType: product.productType,
    status: product.status,
    price: fromPesewas(product.pricePesewas),
    compareAtPrice: fromPesewas(product.compareAtPricePesewas),
    currency: product.currency,
    pricingModel: product.pricingModel,
    taxBehavior: product.taxBehavior,
    sku: product.sku,
    version: product.version,
    language: product.language,
    estimatedReadingTime: product.estimatedReadingTime,
    author: product.author,
    coverMediaId: product.coverMediaId,
    coverPublicUrl: product.coverPublicUrl,
    thumbnailMediaId: product.thumbnailMediaId,
    thumbnailPublicUrl: product.thumbnailPublicUrl,
    previewMediaId: product.previewMediaId,
    previewPublicUrl: product.previewPublicUrl,
    ogMediaId: product.ogMediaId,
    ogPublicUrl: product.ogPublicUrl,
    featured: product.featured,
    bestseller: product.bestseller,
    newRelease: product.newRelease,
    tags: product.tags,
    maxDownloads: product.maxDownloads,
    downloadExpiresDays: product.downloadExpiresDays,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    seoCanonicalUrl: product.seoCanonicalUrl,
    publishedAt: product.publishedAt,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    deletedAt: product.deletedAt,
    files: product.files.map((f) => ({
      assetId: f.assetId,
      mediaId: f.mediaId,
      displayName: f.displayName,
      fileType: f.fileType,
      version: f.version,
      status: f.status,
      sortOrder: f.sortOrder,
      publicUrl: f.publicUrl,
    })),
    gallery: product.gallery,
    relations: product.relations,
  };
}

function toApiListShape(product: Omit<ProductRecord, 'files' | 'gallery' | 'relations'>) {
  return {
    id: product.id,
    productId: product.productId,
    slug: product.slug,
    title: product.title,
    topic: product.topic,
    productType: product.productType,
    status: product.status,
    price: fromPesewas(product.pricePesewas),
    currency: product.currency,
    sku: product.sku,
    featured: product.featured,
    coverPublicUrl: product.coverPublicUrl,
    publishedAt: product.publishedAt,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    deletedAt: product.deletedAt,
  };
}

/** Parses the mutable subset of ProductInput out of a JSON body — every field optional-safe, never throwing on a missing/wrong-typed field (returns undefined so validateProductInput's own required-field checks catch it). */
function parseProductInput(body: Record<string, unknown>): { input: ProductInput; priceInvalid: boolean; compareAtPriceInvalid: boolean } {
  const price = toPesewas(body.price);
  const compareAtPrice = toPesewas(body.compareAtPrice);

  const input: ProductInput = {
    slug: typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '',
    title: typeof body.title === 'string' ? body.title.trim() : '',
    subtitle: typeof body.subtitle === 'string' ? body.subtitle : body.subtitle === null ? null : undefined,
    shortDescription: typeof body.shortDescription === 'string' ? body.shortDescription : body.shortDescription === null ? null : undefined,
    description: typeof body.description === 'string' ? body.description : body.description === null ? null : undefined,
    topic: typeof body.topic === 'string' ? body.topic : '',
    productType: typeof body.productType === 'string' ? body.productType : '',
    status: typeof body.status === 'string' ? body.status : undefined,
    pricePesewas: Number.isNaN(price) ? undefined : price,
    compareAtPricePesewas: Number.isNaN(compareAtPrice) ? undefined : compareAtPrice,
    currency: typeof body.currency === 'string' ? body.currency : undefined,
    taxBehavior: typeof body.taxBehavior === 'string' ? body.taxBehavior : undefined,
    sku: typeof body.sku === 'string' ? body.sku.trim() || null : body.sku === null ? null : undefined,
    version: typeof body.version === 'string' ? body.version : body.version === null ? null : undefined,
    language: typeof body.language === 'string' ? body.language : undefined,
    estimatedReadingTime: typeof body.estimatedReadingTime === 'number' ? body.estimatedReadingTime : body.estimatedReadingTime === null ? null : undefined,
    author: typeof body.author === 'string' ? body.author : body.author === null ? null : undefined,
    coverMediaId: typeof body.coverMediaId === 'number' ? body.coverMediaId : body.coverMediaId === null ? null : undefined,
    thumbnailMediaId: typeof body.thumbnailMediaId === 'number' ? body.thumbnailMediaId : body.thumbnailMediaId === null ? null : undefined,
    previewMediaId: typeof body.previewMediaId === 'number' ? body.previewMediaId : body.previewMediaId === null ? null : undefined,
    ogMediaId: typeof body.ogMediaId === 'number' ? body.ogMediaId : body.ogMediaId === null ? null : undefined,
    featured: typeof body.featured === 'boolean' ? body.featured : undefined,
    bestseller: typeof body.bestseller === 'boolean' ? body.bestseller : undefined,
    newRelease: typeof body.newRelease === 'boolean' ? body.newRelease : undefined,
    tags: typeof body.tags === 'string' ? body.tags : body.tags === null ? null : undefined,
    maxDownloads: typeof body.maxDownloads === 'number' ? body.maxDownloads : body.maxDownloads === null ? null : undefined,
    downloadExpiresDays: typeof body.downloadExpiresDays === 'number' ? body.downloadExpiresDays : body.downloadExpiresDays === null ? null : undefined,
    seoTitle: typeof body.seoTitle === 'string' ? body.seoTitle : body.seoTitle === null ? null : undefined,
    seoDescription: typeof body.seoDescription === 'string' ? body.seoDescription : body.seoDescription === null ? null : undefined,
    seoCanonicalUrl: typeof body.seoCanonicalUrl === 'string' ? body.seoCanonicalUrl : body.seoCanonicalUrl === null ? null : undefined,
  };

  return { input, priceInvalid: Number.isNaN(price), compareAtPriceInvalid: Number.isNaN(compareAtPrice) };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

// ============================================================
// Meta — fixed taxonomies the editor's dropdowns need
// ============================================================

export async function handleProductsMeta(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  return jsonSuccess({ topics: TOPICS, productTypes: PRODUCT_TYPES, statuses: PRODUCT_STATUSES });
}

// ============================================================
// List
// ============================================================

export async function handleProductsList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;

  const sortRaw = params.get('sort');
  const validSorts = ['newest', 'oldest', 'title-az', 'title-za', 'price-asc', 'price-desc'] as const;
  const sort = (validSorts as readonly string[]).includes(sortRaw ?? '') ? (sortRaw as (typeof validSorts)[number]) : 'newest';

  const statusRaw = params.get('status');
  const status = statusRaw && (PRODUCT_STATUSES as readonly string[]).includes(statusRaw) ? statusRaw : null;

  const topicRaw = params.get('topic');
  const topic = topicRaw && (TOPICS as readonly string[]).includes(topicRaw) ? topicRaw : null;

  const productTypeRaw = params.get('productType');
  const productType = productTypeRaw && (PRODUCT_TYPES as readonly string[]).includes(productTypeRaw) ? productTypeRaw : null;

  const featuredRaw = params.get('featured');
  const featured = featuredRaw === 'true' ? true : featuredRaw === 'false' ? false : null;

  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '20', 10) || 20));

  const result = await productService.listProducts(env, {
    search: params.get('search'),
    status,
    topic,
    productType,
    featured,
    showDeleted: params.get('deleted') === 'true',
    sort,
    page,
    pageSize,
  });

  return jsonSuccess({
    items: result.items.map(toApiListShape),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
}

// ============================================================
// Get
// ============================================================

function parseId(params: RouteParams): number | null {
  const id = parseInt(params.id ?? '', 10);
  return Number.isInteger(id) ? id : null;
}

export async function handleProductGet(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This product could not be found.');

  const product = await productService.getProductById(env, id);
  if (!product) return jsonError('NOT_FOUND', 'This product could not be found.');

  return jsonSuccess(toApiShape(product));
}

// ============================================================
// Create
// ============================================================

export async function handleProductCreate(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  const { input, priceInvalid, compareAtPriceInvalid } = parseProductInput(body);
  if (priceInvalid) return jsonError('VALIDATION_ERROR', 'Price must be a non-negative number.');
  if (compareAtPriceInvalid) return jsonError('VALIDATION_ERROR', 'Compare-at price must be a non-negative number.');

  const errors = await productService.validateProductInput(env, input, null);
  if (errors.length > 0) return validationErrorResponse(errors);

  const result = await productService.createProduct(env, logger, auth.auth.adminId, input);
  return jsonSuccess(toApiShape(result.product), 201);
}

// ============================================================
// Update
// ============================================================

export async function handleProductUpdate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This product could not be found.');

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  const { input, priceInvalid, compareAtPriceInvalid } = parseProductInput(body);
  if (priceInvalid) return jsonError('VALIDATION_ERROR', 'Price must be a non-negative number.');
  if (compareAtPriceInvalid) return jsonError('VALIDATION_ERROR', 'Compare-at price must be a non-negative number.');

  const errors = await productService.validateProductInput(env, input, id);
  if (errors.length > 0) return validationErrorResponse(errors);

  const updated = await productService.updateProduct(env, logger, auth.auth.adminId, id, input);
  if (!updated) return jsonError('NOT_FOUND', 'This product could not be found.');

  return jsonSuccess(toApiShape(updated));
}

/**
 * `ApiErrorResponse` only carries one `{code, message}` pair — a form
 * with several invalid fields still needs to tell the admin editor
 * which ones, so this attaches a `fields` array alongside the standard
 * envelope, the same widen-don't-replace pattern routes/admin/media.ts
 * already uses for its duplicate-asset response.
 */
function validationErrorResponse(errors: productService.ProductValidationError[]): Response {
  const body = {
    success: false,
    error: { code: 'VALIDATION_ERROR', message: errors[0]?.message ?? 'Validation failed.' },
    fields: errors,
  };
  return new Response(JSON.stringify(body), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================
// Status transitions
// ============================================================

const LIFECYCLE_ACTIONS: readonly LifecycleAction[] = ['publish', 'unpublish', 'archive', 'unarchive'];

export async function handleProductStatusTransition(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This product could not be found.');

  const body = await readJsonBody(request);
  const action = body?.action;
  if (typeof action !== 'string' || !(LIFECYCLE_ACTIONS as readonly string[]).includes(action)) {
    return jsonError('VALIDATION_ERROR', 'A valid action is required.');
  }

  const result = await productService.transitionProductStatus(env, logger, auth.auth.adminId, id, action as LifecycleAction);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This product could not be found.');
    return jsonError('INVALID_STATUS_TRANSITION', 'This product needs a price before it can be published.');
  }

  return jsonSuccess(toApiShape(result.product));
}

// ============================================================
// Duplicate
// ============================================================

export async function handleProductDuplicate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This product could not be found.');

  const duplicate = await productService.duplicateProduct(env, logger, auth.auth.adminId, id);
  if (!duplicate) return jsonError('NOT_FOUND', 'This product could not be found.');

  return jsonSuccess(toApiShape(duplicate), 201);
}

// ============================================================
// Soft delete / restore
// ============================================================

export async function handleProductDelete(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This product could not be found.');

  const result = await productService.softDeleteProduct(env, logger, auth.auth.adminId, id);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This product could not be found.');
    return jsonError('ALREADY_DELETED', 'This product has already been deleted.');
  }

  return jsonSuccess({ deleted: true });
}

export async function handleProductRestore(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This product could not be found.');

  const result = await productService.restoreProduct(env, logger, auth.auth.adminId, id);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This product could not be found.');
    return jsonError('NOT_DELETED', 'This product is not deleted.');
  }

  return jsonSuccess(toApiShape(result.product));
}

// ============================================================
// Files / gallery / relations — full-replace PUT
// ============================================================

export async function handleProductFilesUpdate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This product could not be found.');

  const product = await productService.getProductById(env, id);
  if (!product) return jsonError('NOT_FOUND', 'This product could not be found.');

  const body = await readJsonBody(request);
  const filesRaw = body?.files;
  if (!Array.isArray(filesRaw)) return jsonError('VALIDATION_ERROR', 'A files array is required.');

  const files: productService.ProductFileInput[] = [];
  for (const entry of filesRaw) {
    if (!entry || typeof entry !== 'object') return jsonError('VALIDATION_ERROR', 'Invalid file entry.');
    const e = entry as Record<string, unknown>;
    if (typeof e.mediaId !== 'number' || typeof e.displayName !== 'string' || typeof e.fileType !== 'string') {
      return jsonError('VALIDATION_ERROR', 'Each file needs a mediaId, displayName, and fileType.');
    }
    files.push({
      assetId: typeof e.assetId === 'string' ? e.assetId : null,
      mediaId: e.mediaId,
      displayName: e.displayName,
      fileType: e.fileType,
      version: typeof e.version === 'string' ? e.version : null,
      status: e.status === 'published' || e.status === 'archived' ? e.status : 'draft',
    });
  }

  // Every referenced mediaId must be a real, non-deleted media asset —
  // never trust the client's claim.
  const mediaIds = files.map((f) => f.mediaId);
  if (mediaIds.length > 0) {
    const placeholders = mediaIds.map(() => '?').join(',');
    const { results } = await env.DB.prepare(`SELECT id FROM media_assets WHERE id IN (${placeholders}) AND deleted_at IS NULL`)
      .bind(...mediaIds)
      .all<{ id: number }>();
    const found = new Set(results.map((r) => r.id));
    for (const mediaId of new Set(mediaIds)) {
      if (!found.has(mediaId)) return jsonError('INVALID_MEDIA_REFERENCE', `Media asset ${mediaId} could not be found.`);
    }
  }

  await productService.setProductFiles(env, logger, auth.auth.adminId, id, product.slug, files);
  const updated = await productService.getProductById(env, id);
  return jsonSuccess(toApiShape(updated!));
}

export async function handleProductGalleryUpdate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This product could not be found.');

  const existing = await productService.getProductById(env, id);
  if (!existing) return jsonError('NOT_FOUND', 'This product could not be found.');

  const body = await readJsonBody(request);
  const mediaIdsRaw = body?.mediaIds;
  if (!Array.isArray(mediaIdsRaw) || mediaIdsRaw.some((v) => typeof v !== 'number')) {
    return jsonError('VALIDATION_ERROR', 'A mediaIds array of numbers is required.');
  }
  const mediaIds = mediaIdsRaw as number[];

  if (mediaIds.length > 0) {
    const placeholders = mediaIds.map(() => '?').join(',');
    const { results } = await env.DB.prepare(`SELECT id FROM media_assets WHERE id IN (${placeholders}) AND deleted_at IS NULL`)
      .bind(...mediaIds)
      .all<{ id: number }>();
    const found = new Set(results.map((r) => r.id));
    for (const mediaId of new Set(mediaIds)) {
      if (!found.has(mediaId)) return jsonError('INVALID_MEDIA_REFERENCE', `Media asset ${mediaId} could not be found.`);
    }
  }

  await productService.setProductGallery(env, logger, auth.auth.adminId, id, mediaIds);
  const updated = await productService.getProductById(env, id);
  return jsonSuccess(toApiShape(updated!));
}

const RELATION_TYPES = ['related', 'cross_sell', 'recommended'] as const;

export async function handleProductRelationsUpdate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This product could not be found.');

  const existing = await productService.getProductById(env, id);
  if (!existing) return jsonError('NOT_FOUND', 'This product could not be found.');

  const body = await readJsonBody(request);
  const relationsRaw = body?.relations;
  if (!Array.isArray(relationsRaw)) return jsonError('VALIDATION_ERROR', 'A relations array is required.');

  const relations: productService.ProductRelationInput[] = [];
  for (const entry of relationsRaw) {
    if (!entry || typeof entry !== 'object') return jsonError('VALIDATION_ERROR', 'Invalid relation entry.');
    const e = entry as Record<string, unknown>;
    if (typeof e.relatedProductId !== 'number' || !(RELATION_TYPES as readonly string[]).includes(e.relationType as string)) {
      return jsonError('VALIDATION_ERROR', 'Each relation needs a relatedProductId and a valid relationType.');
    }
    relations.push({ relatedProductId: e.relatedProductId, relationType: e.relationType as productService.ProductRelationInput['relationType'] });
  }

  const relatedIds = relations.map((r) => r.relatedProductId);
  if (relatedIds.length > 0) {
    const placeholders = relatedIds.map(() => '?').join(',');
    const { results } = await env.DB.prepare(`SELECT id FROM products WHERE id IN (${placeholders}) AND deleted_at IS NULL`)
      .bind(...relatedIds)
      .all<{ id: number }>();
    const found = new Set(results.map((r) => r.id));
    for (const relatedId of new Set(relatedIds)) {
      if (!found.has(relatedId)) return jsonError('VALIDATION_ERROR', `Product ${relatedId} could not be found.`);
    }
  }

  await productService.setProductRelations(env, logger, auth.auth.adminId, id, relations);
  const updated = await productService.getProductById(env, id);
  return jsonSuccess(toApiShape(updated!));
}

// ============================================================
// Bulk actions
// ============================================================

type BulkAction = 'delete' | 'restore' | 'publish' | 'unpublish' | 'archive' | 'unarchive';
const BULK_ACTIONS: readonly BulkAction[] = ['delete', 'restore', 'publish', 'unpublish', 'archive', 'unarchive'];
const BULK_LIFECYCLE_ACTIONS = new Set<BulkAction>(['publish', 'unpublish', 'archive', 'unarchive']);

export async function handleProductsBulkAction(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is number => typeof v === 'number') : [];
  const action = body.action;
  if (ids.length === 0) return jsonError('VALIDATION_ERROR', 'At least one product id is required.');
  if (typeof action !== 'string' || !(BULK_ACTIONS as readonly string[]).includes(action)) {
    return jsonError('VALIDATION_ERROR', 'A valid bulk action is required.');
  }

  // Every item is attempted independently and reported individually —
  // one bad id (already deleted, missing price for publish) never
  // silently aborts the rest of the batch. Matches how a real admin
  // reviewing "12 succeeded, 1 failed: needs a price" expects bulk UI
  // to behave.
  const results: Array<{ id: number; ok: boolean; reason?: string }> = [];
  for (const id of ids) {
    if (action === 'delete') {
      const r = await productService.softDeleteProduct(env, logger, auth.auth.adminId, id);
      results.push({ id, ok: r.ok, reason: r.ok ? undefined : r.reason });
    } else if (action === 'restore') {
      const r = await productService.restoreProduct(env, logger, auth.auth.adminId, id);
      results.push({ id, ok: r.ok, reason: r.ok ? undefined : r.reason });
    } else if ((BULK_LIFECYCLE_ACTIONS as Set<string>).has(action)) {
      const r = await productService.transitionProductStatus(env, logger, auth.auth.adminId, id, action as LifecycleAction);
      results.push({ id, ok: r.ok, reason: r.ok ? undefined : r.reason });
    }
  }

  return jsonSuccess({ results });
}
