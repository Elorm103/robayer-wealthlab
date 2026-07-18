/**
 * Product Service — Version 2.0 Phase 2 (Products Module). See
 * docs/products-module-implementation.md. The only code that writes to
 * `products`/`product_files`/`product_gallery`/`product_relations` —
 * mirrors this codebase's established "one service owns its tables"
 * discipline (e.g. `services/mediaService.ts` for `media_assets`).
 *
 * Every mutating action here writes its own audit_logs row, matching
 * `mediaService.ts`'s convention (the service calls
 * `auditService.record()` itself, not the route).
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import * as auditService from './admin/auditService';
import { sanitizeRichTextHtml } from '../utils/richTextSanitizer';
import { getDownloadDefaults } from './admin/settingsService';

export const TOPICS = ['investing', 'personal-finance', 'budgeting', 'business', 'mindset'] as const;
export type Topic = (typeof TOPICS)[number];
export function isValidTopic(value: unknown): value is Topic {
  return typeof value === 'string' && (TOPICS as readonly string[]).includes(value);
}

export const PRODUCT_TYPES = ['ebook', 'guide', 'template', 'spreadsheet', 'report', 'checklist', 'course'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
export function isValidProductType(value: unknown): value is ProductType {
  return typeof value === 'string' && (PRODUCT_TYPES as readonly string[]).includes(value);
}

export const PRODUCT_STATUSES = ['draft', 'active', 'coming-soon', 'archived', 'hidden', 'unavailable'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export function isValidStatus(value: unknown): value is ProductStatus {
  return typeof value === 'string' && (PRODUCT_STATUSES as readonly string[]).includes(value);
}

/** Statuses a real storefront/checkout should ever treat as "for sale" — mirrors the legacy JSON model's isPurchasable() whitelist-not-blacklist reasoning. */
const PURCHASABLE_STATUSES: readonly ProductStatus[] = ['active'];
export function isPurchasableStatus(status: string): boolean {
  return (PURCHASABLE_STATUSES as readonly string[]).includes(status);
}

/** Statuses a public listing (Books page, homepage) should ever render — never draft/hidden/unavailable/archived. */
const PUBLICLY_LISTED_STATUSES: readonly ProductStatus[] = ['active', 'coming-soon'];
export function isPubliclyListedStatus(status: string): boolean {
  return (PUBLICLY_LISTED_STATUSES as readonly string[]).includes(status);
}

export interface ProductFile {
  id: number;
  assetId: string;
  mediaId: number;
  displayName: string;
  fileType: string;
  version: string | null;
  status: 'draft' | 'published' | 'archived';
  sortOrder: number;
  storageKey: string; // resolved from media_assets — never exposed to a client, server-side use only (matches DigitalAsset.storageKey's existing discipline)
  publicUrl: string;
}

export interface ProductGalleryItem {
  mediaId: number;
  sortOrder: number;
  publicUrl: string;
  thumbnailPublicUrl: string | null;
}

export interface ProductRelation {
  relatedProductId: number;
  relatedProductSlug: string;
  relatedProductTitle: string;
  relationType: 'related' | 'cross_sell' | 'recommended';
  sortOrder: number;
}

export interface ProductRecord {
  id: number;
  productId: string;
  slug: string;
  title: string;
  subtitle: string | null;
  shortDescription: string | null;
  description: string | null;
  topic: string;
  productType: string;
  status: string;
  pricePesewas: number | null;
  compareAtPricePesewas: number | null;
  currency: string;
  pricingModel: string;
  taxBehavior: string;
  sku: string | null;
  version: string | null;
  language: string;
  estimatedReadingTime: number | null;
  author: string | null;
  coverMediaId: number | null;
  coverPublicUrl: string | null;
  thumbnailMediaId: number | null;
  thumbnailPublicUrl: string | null;
  previewMediaId: number | null;
  previewPublicUrl: string | null;
  ogMediaId: number | null;
  ogPublicUrl: string | null;
  featured: boolean;
  bestseller: boolean;
  newRelease: boolean;
  tags: string | null;
  maxDownloads: number | null;
  downloadExpiresDays: number | null;
  seoTitle: string | null;
  seoDescription: string | null;
  seoCanonicalUrl: string | null;
  publishedAt: string | null;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  files: ProductFile[];
  gallery: ProductGalleryItem[];
  relations: ProductRelation[];
}

interface ProductRow {
  id: number;
  product_id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  short_description: string | null;
  description: string | null;
  topic: string;
  product_type: string;
  status: string;
  price_pesewas: number | null;
  compare_at_price_pesewas: number | null;
  currency: string;
  pricing_model: string;
  tax_behavior: string;
  sku: string | null;
  version: string | null;
  language: string;
  estimated_reading_time: number | null;
  author: string | null;
  cover_media_id: number | null;
  cover_public_url: string | null;
  thumbnail_media_id: number | null;
  thumbnail_public_url: string | null;
  preview_media_id: number | null;
  preview_public_url: string | null;
  og_media_id: number | null;
  og_public_url: string | null;
  featured: number;
  bestseller: number;
  new_release: number;
  tags: string | null;
  max_downloads: number | null;
  download_expires_days: number | null;
  seo_title: string | null;
  seo_description: string | null;
  seo_canonical_url: string | null;
  published_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const PRODUCT_SELECT_COLUMNS = `
  p.id, p.product_id, p.slug, p.title, p.subtitle, p.short_description, p.description,
  p.topic, p.product_type, p.status, p.price_pesewas, p.compare_at_price_pesewas, p.currency,
  p.pricing_model, p.tax_behavior, p.sku, p.version, p.language, p.estimated_reading_time, p.author,
  p.cover_media_id, cover.public_url AS cover_public_url,
  p.thumbnail_media_id, thumb.public_url AS thumbnail_public_url,
  p.preview_media_id, preview.public_url AS preview_public_url,
  p.og_media_id, og.public_url AS og_public_url,
  p.featured, p.bestseller, p.new_release, p.tags, p.max_downloads, p.download_expires_days,
  p.seo_title, p.seo_description, p.seo_canonical_url, p.published_at,
  p.created_by, p.updated_by, p.created_at, p.updated_at, p.deleted_at
`;

const PRODUCT_FROM_CLAUSE = `
  FROM products p
  LEFT JOIN media_assets cover ON cover.id = p.cover_media_id
  LEFT JOIN media_assets thumb ON thumb.id = p.thumbnail_media_id
  LEFT JOIN media_assets preview ON preview.id = p.preview_media_id
  LEFT JOIN media_assets og ON og.id = p.og_media_id
`;

function fromRow(row: ProductRow): Omit<ProductRecord, 'files' | 'gallery' | 'relations'> {
  return {
    id: row.id,
    productId: row.product_id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    shortDescription: row.short_description,
    description: row.description,
    topic: row.topic,
    productType: row.product_type,
    status: row.status,
    pricePesewas: row.price_pesewas,
    compareAtPricePesewas: row.compare_at_price_pesewas,
    currency: row.currency,
    pricingModel: row.pricing_model,
    taxBehavior: row.tax_behavior,
    sku: row.sku,
    version: row.version,
    language: row.language,
    estimatedReadingTime: row.estimated_reading_time,
    author: row.author,
    coverMediaId: row.cover_media_id,
    coverPublicUrl: row.cover_public_url,
    thumbnailMediaId: row.thumbnail_media_id,
    thumbnailPublicUrl: row.thumbnail_public_url,
    previewMediaId: row.preview_media_id,
    previewPublicUrl: row.preview_public_url,
    ogMediaId: row.og_media_id,
    ogPublicUrl: row.og_public_url,
    featured: row.featured === 1,
    bestseller: row.bestseller === 1,
    newRelease: row.new_release === 1,
    tags: row.tags,
    maxDownloads: row.max_downloads,
    downloadExpiresDays: row.download_expires_days,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    seoCanonicalUrl: row.seo_canonical_url,
    publishedAt: row.published_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

async function loadFiles(env: Env, productId: number): Promise<ProductFile[]> {
  const { results } = await env.DB.prepare(
    `SELECT pf.id, pf.asset_id, pf.media_id, pf.display_name, pf.file_type, pf.version, pf.status, pf.sort_order,
            m.storage_key, m.public_url
     FROM product_files pf
     JOIN media_assets m ON m.id = pf.media_id
     WHERE pf.product_id = ?
     ORDER BY pf.sort_order ASC, pf.id ASC`
  )
    .bind(productId)
    .all<{
      id: number;
      asset_id: string;
      media_id: number;
      display_name: string;
      file_type: string;
      version: string | null;
      status: string;
      sort_order: number;
      storage_key: string;
      public_url: string;
    }>();
  return results.map((r) => ({
    id: r.id,
    assetId: r.asset_id,
    mediaId: r.media_id,
    displayName: r.display_name,
    fileType: r.file_type,
    version: r.version,
    status: r.status as ProductFile['status'],
    sortOrder: r.sort_order,
    storageKey: r.storage_key,
    publicUrl: r.public_url,
  }));
}

async function loadGallery(env: Env, productId: number): Promise<ProductGalleryItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT pg.media_id, pg.sort_order, m.public_url, m.thumbnail_public_url
     FROM product_gallery pg
     JOIN media_assets m ON m.id = pg.media_id
     WHERE pg.product_id = ?
     ORDER BY pg.sort_order ASC, pg.id ASC`
  )
    .bind(productId)
    .all<{ media_id: number; sort_order: number; public_url: string; thumbnail_public_url: string | null }>();
  return results.map((r) => ({
    mediaId: r.media_id,
    sortOrder: r.sort_order,
    publicUrl: r.public_url,
    thumbnailPublicUrl: r.thumbnail_public_url,
  }));
}

async function loadRelations(env: Env, productId: number): Promise<ProductRelation[]> {
  const { results } = await env.DB.prepare(
    `SELECT pr.related_product_id, pr.relation_type, pr.sort_order, p.slug, p.title
     FROM product_relations pr
     JOIN products p ON p.id = pr.related_product_id
     WHERE pr.product_id = ? AND p.deleted_at IS NULL
     ORDER BY pr.relation_type ASC, pr.sort_order ASC, pr.id ASC`
  )
    .bind(productId)
    .all<{ related_product_id: number; relation_type: string; sort_order: number; slug: string; title: string }>();
  return results.map((r) => ({
    relatedProductId: r.related_product_id,
    relatedProductSlug: r.slug,
    relatedProductTitle: r.title,
    relationType: r.relation_type as ProductRelation['relationType'],
    sortOrder: r.sort_order,
  }));
}

/** Attaches files/gallery/relations to a base row — three extra queries, only ever run for a single-product read (get/edit), never in a list response (see listProducts's own, deliberately lighter shape). */
async function hydrate(env: Env, base: Omit<ProductRecord, 'files' | 'gallery' | 'relations'>): Promise<ProductRecord> {
  const [files, gallery, relations] = await Promise.all([
    loadFiles(env, base.id),
    loadGallery(env, base.id),
    loadRelations(env, base.id),
  ]);
  return { ...base, files, gallery, relations };
}

export async function getProductById(env: Env, id: number): Promise<ProductRecord | null> {
  const row = await env.DB.prepare(`SELECT ${PRODUCT_SELECT_COLUMNS} ${PRODUCT_FROM_CLAUSE} WHERE p.id = ?`).bind(id).first<ProductRow>();
  if (!row) return null;
  return hydrate(env, fromRow(row));
}

export async function getProductBySlug(env: Env, slug: string): Promise<ProductRecord | null> {
  const row = await env.DB.prepare(`SELECT ${PRODUCT_SELECT_COLUMNS} ${PRODUCT_FROM_CLAUSE} WHERE p.slug = ? AND p.deleted_at IS NULL`)
    .bind(slug)
    .first<ProductRow>();
  if (!row) return null;
  return hydrate(env, fromRow(row));
}

export async function getProductByProductId(env: Env, productId: string): Promise<ProductRecord | null> {
  const row = await env.DB.prepare(`SELECT ${PRODUCT_SELECT_COLUMNS} ${PRODUCT_FROM_CLAUSE} WHERE p.product_id = ? AND p.deleted_at IS NULL`)
    .bind(productId)
    .first<ProductRow>();
  if (!row) return null;
  return hydrate(env, fromRow(row));
}

// ============================================================
// List — server-side search, filter, sort, pagination
// ============================================================

export interface ListProductsQuery {
  search: string | null;
  status: string | null;
  /** When set, overrides `status` with an IN(...) match against multiple statuses — used by the public route to span both `active` and `coming-soon` in one query/one page, instead of issuing two separate paginated queries and merging in memory. */
  statuses?: readonly string[] | null;
  topic: string | null;
  productType: string | null;
  featured: boolean | null;
  showDeleted: boolean;
  sort: 'newest' | 'oldest' | 'title-az' | 'title-za' | 'price-asc' | 'price-desc';
  page: number;
  pageSize: number;
}

export interface ListProductsResult {
  items: Array<Omit<ProductRecord, 'files' | 'gallery' | 'relations'> & { coverPublicUrl: string | null }>;
  total: number;
  page: number;
  pageSize: number;
}

const SORT_CLAUSES: Record<ListProductsQuery['sort'], string> = {
  newest: 'p.created_at DESC',
  oldest: 'p.created_at ASC',
  'title-az': 'p.title COLLATE NOCASE ASC',
  'title-za': 'p.title COLLATE NOCASE DESC',
  'price-asc': 'p.price_pesewas ASC',
  'price-desc': 'p.price_pesewas DESC',
};

export async function listProducts(env: Env, query: ListProductsQuery): Promise<ListProductsResult> {
  const conditions: string[] = [query.showDeleted ? 'p.deleted_at IS NOT NULL' : 'p.deleted_at IS NULL'];
  const bindings: unknown[] = [];

  if (query.statuses && query.statuses.length > 0) {
    conditions.push(`p.status IN (${query.statuses.map(() => '?').join(',')})`);
    bindings.push(...query.statuses);
  } else if (query.status) {
    conditions.push('p.status = ?');
    bindings.push(query.status);
  }
  if (query.topic) {
    conditions.push('p.topic = ?');
    bindings.push(query.topic);
  }
  if (query.productType) {
    conditions.push('p.product_type = ?');
    bindings.push(query.productType);
  }
  if (query.featured !== null) {
    conditions.push('p.featured = ?');
    bindings.push(query.featured ? 1 : 0);
  }
  if (query.search) {
    // ESCAPE clause required — SQLite's LIKE has no default escape
    // character, so without it the backslashes inserted below would be
    // matched literally instead of escaping %/_ (a real defect found
    // and fixed in Media Library's own search — see mediaService.ts).
    conditions.push(
      "(p.title LIKE ? ESCAPE '\\' OR p.subtitle LIKE ? ESCAPE '\\' OR p.slug LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.tags LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')"
    );
    const pattern = `%${query.search.replace(/[%_\\]/g, '\\$&')}%`;
    bindings.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }

  const whereClause = conditions.join(' AND ');
  const orderClause = SORT_CLAUSES[query.sort];
  const offset = (query.page - 1) * query.pageSize;

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(`SELECT ${PRODUCT_SELECT_COLUMNS} ${PRODUCT_FROM_CLAUSE} WHERE ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`)
      .bind(...bindings, query.pageSize, offset)
      .all<ProductRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM products p WHERE ${whereClause}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);

  return {
    items: rows.results.map(fromRow),
    total: countRow?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ============================================================
// Validation
// ============================================================

export interface ProductValidationError {
  field: string;
  message: string;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const SEO_TITLE_MAX = 70;
const SEO_DESCRIPTION_MAX = 160;

export interface ProductInput {
  slug: string;
  title: string;
  subtitle?: string | null;
  shortDescription?: string | null;
  description?: string | null;
  topic: string;
  productType: string;
  status?: string;
  pricePesewas?: number | null;
  compareAtPricePesewas?: number | null;
  currency?: string;
  taxBehavior?: string;
  sku?: string | null;
  version?: string | null;
  language?: string;
  estimatedReadingTime?: number | null;
  author?: string | null;
  coverMediaId?: number | null;
  thumbnailMediaId?: number | null;
  previewMediaId?: number | null;
  ogMediaId?: number | null;
  featured?: boolean;
  bestseller?: boolean;
  newRelease?: boolean;
  tags?: string | null;
  maxDownloads?: number | null;
  downloadExpiresDays?: number | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoCanonicalUrl?: string | null;
}

/**
 * Validates everything the Phase 2 brief names explicitly: slug shape/
 * uniqueness, price, missing/invalid media references, SEO field
 * lengths, and required fields. Duplicate-slug and duplicate-SKU
 * uniqueness checks are separate async calls (need a DB round trip),
 * kept here rather than split into a second function so a route only
 * ever calls one validation entry point.
 */
export async function validateProductInput(
  env: Env,
  input: ProductInput,
  excludeId: number | null
): Promise<ProductValidationError[]> {
  const errors: ProductValidationError[] = [];

  if (!input.title || input.title.trim().length === 0) errors.push({ field: 'title', message: 'Title is required.' });
  if (input.title && input.title.length > 200) errors.push({ field: 'title', message: 'Title must be 200 characters or fewer.' });

  if (!input.slug || !SLUG_PATTERN.test(input.slug)) {
    errors.push({ field: 'slug', message: 'Slug must be lowercase letters, numbers, and hyphens only.' });
  }
  if (!isValidTopic(input.topic)) errors.push({ field: 'topic', message: 'A valid topic is required.' });
  if (!isValidProductType(input.productType)) errors.push({ field: 'productType', message: 'A valid product type is required.' });
  if (input.status !== undefined && !isValidStatus(input.status)) errors.push({ field: 'status', message: 'Invalid status.' });

  if (input.pricePesewas !== undefined && input.pricePesewas !== null) {
    if (!Number.isInteger(input.pricePesewas) || input.pricePesewas < 0) {
      errors.push({ field: 'pricePesewas', message: 'Price must be a non-negative whole number.' });
    }
  }
  if (input.compareAtPricePesewas !== undefined && input.compareAtPricePesewas !== null) {
    if (!Number.isInteger(input.compareAtPricePesewas) || input.compareAtPricePesewas < 0) {
      errors.push({ field: 'compareAtPricePesewas', message: 'Compare-at price must be a non-negative whole number.' });
    } else if (
      input.pricePesewas !== undefined &&
      input.pricePesewas !== null &&
      input.compareAtPricePesewas <= input.pricePesewas
    ) {
      errors.push({ field: 'compareAtPricePesewas', message: 'Compare-at price must be higher than the price.' });
    }
  }
  // A product can only genuinely be "active" (for sale) with a real price — matches the legacy JSON model's own validateProduct() rule.
  if (input.status === 'active' && (input.pricePesewas === undefined || input.pricePesewas === null)) {
    errors.push({ field: 'pricePesewas', message: 'Price is required before a product can be published as active.' });
  }

  if (input.seoTitle && input.seoTitle.length > SEO_TITLE_MAX) {
    errors.push({ field: 'seoTitle', message: `SEO title must be ${SEO_TITLE_MAX} characters or fewer.` });
  }
  if (input.seoDescription && input.seoDescription.length > SEO_DESCRIPTION_MAX) {
    errors.push({ field: 'seoDescription', message: `SEO description must be ${SEO_DESCRIPTION_MAX} characters or fewer.` });
  }

  // Media reference validation — every non-null media id must point at
  // a real, non-deleted media_assets row. Never trusts the client's
  // claim that an id is valid.
  const mediaIds = [input.coverMediaId, input.thumbnailMediaId, input.previewMediaId, input.ogMediaId].filter(
    (id): id is number => typeof id === 'number'
  );
  if (mediaIds.length > 0) {
    const placeholders = mediaIds.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id FROM media_assets WHERE id IN (${placeholders}) AND deleted_at IS NULL`
    )
      .bind(...mediaIds)
      .all<{ id: number }>();
    const foundIds = new Set(results.map((r) => r.id));
    for (const id of new Set(mediaIds)) {
      if (!foundIds.has(id)) errors.push({ field: 'media', message: `Media asset ${id} could not be found.` });
    }
  }

  if (input.slug && SLUG_PATTERN.test(input.slug)) {
    const existing = await env.DB.prepare(`SELECT id FROM products WHERE slug = ? AND deleted_at IS NULL AND id IS NOT ?`)
      .bind(input.slug, excludeId ?? -1)
      .first<{ id: number }>();
    if (existing) errors.push({ field: 'slug', message: 'This slug is already in use by another product.' });
  }

  if (input.sku) {
    const existing = await env.DB.prepare(`SELECT id FROM products WHERE sku = ? AND deleted_at IS NULL AND id IS NOT ?`)
      .bind(input.sku, excludeId ?? -1)
      .first<{ id: number }>();
    if (existing) errors.push({ field: 'sku', message: 'This SKU is already in use by another product.' });
  }

  return errors;
}

// ============================================================
// Create / Update
// ============================================================

function slugToProductId(slug: string): string {
  return `prod-${slug}`;
}

export interface CreateProductResult {
  ok: true;
  product: ProductRecord;
}

export async function createProduct(
  env: Env,
  logger: Logger,
  actorId: number,
  input: ProductInput,
  // `applyDownloadDefaults: false` is used by `duplicateProduct()` below
  // — a duplicate is explicitly carrying over the source's real,
  // already-decided download policy (even if that value is `null`,
  // i.e. the source was genuinely unlimited), not "an admin leaving a
  // new product's field blank." Every other caller (the real New
  // Product form) gets the default applied, matching the approved
  // design.
  options: { applyDownloadDefaults?: boolean } = {}
): Promise<CreateProductResult> {
  const applyDownloadDefaults = options.applyDownloadDefaults ?? true;
  const productId = slugToProductId(input.slug);
  const status = input.status && isValidStatus(input.status) ? input.status : 'draft';
  // Server-side sanitization, independent of the client editor's own
  // pass — see utils/richTextSanitizer.ts's header comment for why
  // trusting the client alone isn't enough for a value later rendered
  // as raw HTML on a public page (routes/books.ts).
  const sanitizedDescription = await sanitizeRichTextHtml(input.description ?? null);

  // Version 2.1 Phase 5 (Settings) — site-wide download defaults,
  // applied only here, at creation, never on update. The real admin
  // editor always sends `null` (not an omitted key) for a blank
  // field — see admin-product-editor.js's serialization — so `== null`
  // (matching both `null` and `undefined`) is the actual "left blank"
  // signal this substitution triggers on. A brand-new product that
  // should be genuinely unlimited despite a configured site default
  // can simply be edited immediately after creation: updateProduct()
  // is untouched by this phase and always respects an explicit `null`
  // exactly as typed, with no default substitution.
  const downloadDefaults = applyDownloadDefaults ? await getDownloadDefaults(env) : { maxDownloads: null, downloadExpiresDays: null };
  const resolvedMaxDownloads = applyDownloadDefaults && input.maxDownloads == null ? downloadDefaults.maxDownloads : input.maxDownloads ?? null;
  const resolvedDownloadExpiresDays = applyDownloadDefaults && input.downloadExpiresDays == null ? downloadDefaults.downloadExpiresDays : input.downloadExpiresDays ?? null;

  const insert = await env.DB.prepare(
    `INSERT INTO products (
       product_id, slug, title, subtitle, short_description, description, topic, product_type, status,
       price_pesewas, compare_at_price_pesewas, currency, tax_behavior, sku, version, language,
       estimated_reading_time, author, cover_media_id, thumbnail_media_id, preview_media_id, og_media_id,
       featured, bestseller, new_release, tags, max_downloads, download_expires_days,
       seo_title, seo_description, seo_canonical_url, created_by, updated_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      productId,
      input.slug,
      input.title,
      input.subtitle ?? null,
      input.shortDescription ?? null,
      sanitizedDescription,
      input.topic,
      input.productType,
      status,
      input.pricePesewas ?? null,
      input.compareAtPricePesewas ?? null,
      input.currency ?? 'GHS',
      input.taxBehavior ?? 'inclusive',
      input.sku ?? null,
      input.version ?? null,
      input.language ?? 'en',
      input.estimatedReadingTime ?? null,
      input.author ?? null,
      input.coverMediaId ?? null,
      input.thumbnailMediaId ?? null,
      input.previewMediaId ?? null,
      input.ogMediaId ?? null,
      input.featured ? 1 : 0,
      input.bestseller ? 1 : 0,
      input.newRelease ? 1 : 0,
      input.tags ?? null,
      resolvedMaxDownloads,
      resolvedDownloadExpiresDays,
      input.seoTitle ?? null,
      input.seoDescription ?? null,
      input.seoCanonicalUrl ?? null,
      actorId,
      actorId
    )
    .run();

  const id = Number(insert.meta.last_row_id);

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'product.created',
    entityType: 'product',
    entityId: id,
    metadata: { slug: input.slug, title: input.title },
  });

  const product = await getProductById(env, id);
  return { ok: true, product: product! };
}

export async function updateProduct(
  env: Env,
  logger: Logger,
  actorId: number,
  id: number,
  input: ProductInput
): Promise<ProductRecord | null> {
  const existing = await getProductById(env, id);
  if (!existing || existing.deletedAt) return null;

  const sanitizedDescription = await sanitizeRichTextHtml(input.description ?? null);
  // Preserves the existing status when the caller doesn't send one (matches
  // ProductInput.status being optional) — real bug found in final acceptance
  // audit: this UPDATE previously omitted `status` from its SET clause
  // entirely, so the edit page's own "Set status" dropdown silently had no
  // effect (the only working status-change path was the list page's bulk
  // actions, which call transitionProductStatus directly). Re-validates the
  // same "active needs a price" rule transitionProductStatus enforces,
  // since this path can also move a product into 'active'.
  const nextStatus = input.status && isValidStatus(input.status) ? input.status : existing.status;

  await env.DB.prepare(
    `UPDATE products SET
       slug = ?, title = ?, subtitle = ?, short_description = ?, description = ?, topic = ?, product_type = ?, status = ?,
       price_pesewas = ?, compare_at_price_pesewas = ?, currency = ?, tax_behavior = ?, sku = ?, version = ?,
       language = ?, estimated_reading_time = ?, author = ?, cover_media_id = ?, thumbnail_media_id = ?,
       preview_media_id = ?, og_media_id = ?, featured = ?, bestseller = ?, new_release = ?, tags = ?,
       max_downloads = ?, download_expires_days = ?, seo_title = ?, seo_description = ?, seo_canonical_url = ?,
       updated_by = ?, updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      input.slug,
      input.title,
      input.subtitle ?? null,
      input.shortDescription ?? null,
      sanitizedDescription,
      input.topic,
      input.productType,
      nextStatus,
      input.pricePesewas ?? null,
      input.compareAtPricePesewas ?? null,
      input.currency ?? 'GHS',
      input.taxBehavior ?? 'inclusive',
      input.sku ?? null,
      input.version ?? null,
      input.language ?? 'en',
      input.estimatedReadingTime ?? null,
      input.author ?? null,
      input.coverMediaId ?? null,
      input.thumbnailMediaId ?? null,
      input.previewMediaId ?? null,
      input.ogMediaId ?? null,
      input.featured ? 1 : 0,
      input.bestseller ? 1 : 0,
      input.newRelease ? 1 : 0,
      input.tags ?? null,
      input.maxDownloads ?? null,
      input.downloadExpiresDays ?? null,
      input.seoTitle ?? null,
      input.seoDescription ?? null,
      input.seoCanonicalUrl ?? null,
      actorId,
      id
    )
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'product.updated',
    entityType: 'product',
    entityId: id,
  });

  return getProductById(env, id);
}

// ============================================================
// Publish lifecycle — Draft -> Publish -> Unpublish -> Archive
// ============================================================

export type LifecycleAction = 'publish' | 'unpublish' | 'archive' | 'unarchive';

const LIFECYCLE_TARGET_STATUS: Record<LifecycleAction, ProductStatus> = {
  publish: 'active',
  unpublish: 'draft',
  archive: 'archived',
  unarchive: 'draft',
};

export type LifecycleResult = { ok: true; product: ProductRecord } | { ok: false; reason: 'not_found' | 'missing_price' };

export async function transitionProductStatus(
  env: Env,
  logger: Logger,
  actorId: number,
  id: number,
  action: LifecycleAction
): Promise<LifecycleResult> {
  const existing = await getProductById(env, id);
  if (!existing || existing.deletedAt) return { ok: false, reason: 'not_found' };

  const targetStatus = LIFECYCLE_TARGET_STATUS[action];
  if (targetStatus === 'active' && existing.pricePesewas === null) {
    return { ok: false, reason: 'missing_price' };
  }

  const publishedAtClause = targetStatus === 'active' && !existing.publishedAt ? `, published_at = datetime('now')` : '';

  await env.DB.prepare(`UPDATE products SET status = ?, updated_by = ?, updated_at = datetime('now')${publishedAtClause} WHERE id = ?`)
    .bind(targetStatus, actorId, id)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: `product.${action}`,
    entityType: 'product',
    entityId: id,
    metadata: { fromStatus: existing.status, toStatus: targetStatus },
  });

  const product = await getProductById(env, id);
  return { ok: true, product: product! };
}

// ============================================================
// Duplicate
// ============================================================

/** Generates a unique "copy" slug — `{slug}-copy`, `{slug}-copy-2`, etc. — the same incrementing-suffix pattern a real admin would type by hand. */
async function generateCopySlug(env: Env, baseSlug: string): Promise<string> {
  let candidate = `${baseSlug}-copy`;
  let suffix = 2;
  while (await env.DB.prepare(`SELECT id FROM products WHERE slug = ?`).bind(candidate).first()) {
    candidate = `${baseSlug}-copy-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function duplicateProduct(env: Env, logger: Logger, actorId: number, id: number): Promise<ProductRecord | null> {
  const source = await getProductById(env, id);
  if (!source || source.deletedAt) return null;

  const newSlug = await generateCopySlug(env, source.slug);
  const created = await createProduct(
    env,
    logger,
    actorId,
    {
    slug: newSlug,
    title: `${source.title} (Copy)`,
    subtitle: source.subtitle,
    shortDescription: source.shortDescription,
    description: source.description,
    topic: source.topic,
    productType: source.productType,
    status: 'draft', // a duplicate never inherits the source's live/published state
    pricePesewas: source.pricePesewas,
    compareAtPricePesewas: source.compareAtPricePesewas,
    currency: source.currency,
    taxBehavior: source.taxBehavior,
    sku: null, // SKU is unique — never copied
    version: source.version,
    language: source.language,
    estimatedReadingTime: source.estimatedReadingTime,
    author: source.author,
    coverMediaId: source.coverMediaId,
    thumbnailMediaId: source.thumbnailMediaId,
    previewMediaId: source.previewMediaId,
    ogMediaId: source.ogMediaId,
    featured: false, // never duplicate a featured slot onto an unreviewed draft
    bestseller: false,
    newRelease: false,
    tags: source.tags,
    maxDownloads: source.maxDownloads,
    downloadExpiresDays: source.downloadExpiresDays,
    seoTitle: null, // SEO canonical/title are page-identity fields — never copied verbatim onto a new URL
    seoDescription: source.seoDescription,
    seoCanonicalUrl: null,
    },
    // A duplicate carries over the source's real max_downloads/
    // download_expires_days verbatim (even if `null`, i.e. genuinely
    // unlimited) — never the site-wide default, which is only for a
    // brand-new product's blank field. See createProduct()'s own
    // comment on this parameter.
    { applyDownloadDefaults: false }
  );

  // Gallery references duplicate cleanly (same media, new product) —
  // downloadable files deliberately do NOT duplicate onto the copy,
  // since a draft copy meant for editing shouldn't silently grant the
  // exact same paid file under a second product without an admin
  // explicitly attaching it.
  for (const item of source.gallery) {
    await env.DB.prepare(`INSERT INTO product_gallery (product_id, media_id, sort_order) VALUES (?, ?, ?)`)
      .bind(created.product.id, item.mediaId, item.sortOrder)
      .run();
  }

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'product.duplicated',
    entityType: 'product',
    entityId: created.product.id,
    metadata: { sourceProductId: id, sourceSlug: source.slug },
  });

  return getProductById(env, created.product.id);
}

// ============================================================
// Soft delete / restore
// ============================================================

export type SoftDeleteResult = { ok: true } | { ok: false; reason: 'not_found' | 'already_deleted' };

export async function softDeleteProduct(env: Env, logger: Logger, actorId: number, id: number): Promise<SoftDeleteResult> {
  const existing = await getProductById(env, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.deletedAt) return { ok: false, reason: 'already_deleted' };

  await env.DB.prepare(`UPDATE products SET deleted_at = datetime('now'), updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(actorId, id)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'product.deleted',
    entityType: 'product',
    entityId: id,
    metadata: { slug: existing.slug, title: existing.title },
  });

  return { ok: true };
}

export type RestoreResult = { ok: true; product: ProductRecord } | { ok: false; reason: 'not_found' | 'not_deleted' };

export async function restoreProduct(env: Env, logger: Logger, actorId: number, id: number): Promise<RestoreResult> {
  const row = await env.DB.prepare(`SELECT deleted_at FROM products WHERE id = ?`).bind(id).first<{ deleted_at: string | null }>();
  if (!row) return { ok: false, reason: 'not_found' };
  if (!row.deleted_at) return { ok: false, reason: 'not_deleted' };

  await env.DB.prepare(`UPDATE products SET deleted_at = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(actorId, id)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'product.restored',
    entityType: 'product',
    entityId: id,
  });

  const product = await getProductById(env, id);
  return { ok: true, product: product! };
}

// ============================================================
// Files / gallery / relations — full-replace semantics
// ============================================================

/**
 * Replaces a product's downloadable-files list wholesale — the editor
 * always submits the complete intended list, matching how the Media
 * Library's metadata PATCH already works (simpler and less error-prone
 * than a separate add/remove/reorder API for a list that's realistically
 * a handful of items). Existing rows whose `assetId` matches an incoming
 * entry are updated in place (preserving the asset_id deliveries.asset_id
 * already reference); anything not in the new list is deleted; anything
 * new gets a freshly generated assetId.
 */
export interface ProductFileInput {
  assetId?: string | null; // present = update existing row; absent = new file
  mediaId: number;
  displayName: string;
  fileType: string;
  version?: string | null;
  status?: 'draft' | 'published' | 'archived';
}

function generateAssetId(slug: string): string {
  return `asset-${slug}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function setProductFiles(env: Env, logger: Logger, actorId: number, productId: number, slug: string, files: ProductFileInput[]): Promise<void> {
  const existing = await env.DB.prepare(`SELECT asset_id FROM product_files WHERE product_id = ?`)
    .bind(productId)
    .all<{ asset_id: string }>();
  const existingIds = new Set(existing.results.map((r) => r.asset_id));
  const keepIds = new Set(files.map((f) => f.assetId).filter((id): id is string => !!id));

  for (const staleId of existingIds) {
    if (!keepIds.has(staleId)) {
      await env.DB.prepare(`DELETE FROM product_files WHERE product_id = ? AND asset_id = ?`).bind(productId, staleId).run();
    }
  }

  for (const [index, file] of files.entries()) {
    if (file.assetId && existingIds.has(file.assetId)) {
      await env.DB.prepare(
        `UPDATE product_files SET media_id = ?, display_name = ?, file_type = ?, version = ?, status = ?, sort_order = ?, updated_at = datetime('now')
         WHERE product_id = ? AND asset_id = ?`
      )
        .bind(file.mediaId, file.displayName, file.fileType, file.version ?? null, file.status ?? 'draft', index, productId, file.assetId)
        .run();
    } else {
      const assetId = file.assetId ?? generateAssetId(slug);
      await env.DB.prepare(
        `INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, version, status, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(productId, assetId, file.mediaId, file.displayName, file.fileType, file.version ?? null, file.status ?? 'draft', index)
        .run();
    }
  }

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'product.files_updated',
    entityType: 'product',
    entityId: productId,
    metadata: { fileCount: files.length },
  });
}

export async function setProductGallery(env: Env, logger: Logger, actorId: number, productId: number, mediaIds: number[]): Promise<void> {
  await env.DB.prepare(`DELETE FROM product_gallery WHERE product_id = ?`).bind(productId).run();
  for (const [index, mediaId] of mediaIds.entries()) {
    await env.DB.prepare(`INSERT INTO product_gallery (product_id, media_id, sort_order) VALUES (?, ?, ?)`)
      .bind(productId, mediaId, index)
      .run();
  }
  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'product.gallery_updated',
    entityType: 'product',
    entityId: productId,
    metadata: { imageCount: mediaIds.length },
  });
}

export interface ProductRelationInput {
  relatedProductId: number;
  relationType: 'related' | 'cross_sell' | 'recommended';
}

export async function setProductRelations(env: Env, logger: Logger, actorId: number, productId: number, relations: ProductRelationInput[]): Promise<void> {
  await env.DB.prepare(`DELETE FROM product_relations WHERE product_id = ?`).bind(productId).run();
  for (const [index, rel] of relations.entries()) {
    if (rel.relatedProductId === productId) continue; // a product can never relate to itself
    await env.DB.prepare(`INSERT OR IGNORE INTO product_relations (product_id, related_product_id, relation_type, sort_order) VALUES (?, ?, ?, ?)`)
      .bind(productId, rel.relatedProductId, rel.relationType, index)
      .run();
  }
  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'product.relations_updated',
    entityType: 'product',
    entityId: productId,
    metadata: { relationCount: relations.length },
  });
}
