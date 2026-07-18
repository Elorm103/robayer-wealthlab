/**
 * Resource Service — Version 2.1 Phase 1 (Resources CMS). See
 * docs/v2.1-architecture-plan.md Section 3. The only code that writes
 * to `resources` — mirrors this codebase's established "one service
 * owns its tables" discipline (e.g. `services/productService.ts` for
 * `products`).
 *
 * Deliberately a trimmed copy of productService.ts's shape: same
 * select/hydrate/list/validate/create/update/lifecycle/soft-delete
 * pattern, minus pricing and the files/gallery/relations join tables
 * a resource has never needed (at most one file, one cover — see the
 * migration's own header comment for why).
 *
 * Every mutating action here writes its own audit_logs row, matching
 * productService.ts's convention.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import * as auditService from './admin/auditService';
import { sanitizeRichTextHtml } from '../utils/richTextSanitizer';

export const CATEGORIES = ['budgeting', 'saving', 'debt', 'investing', 'planning'] as const;
export type Category = (typeof CATEGORIES)[number];
export function isValidCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

export const FORMATS = ['template', 'checklist', 'tracker', 'worksheet', 'guide'] as const;
export type Format = (typeof FORMATS)[number];
export function isValidFormat(value: unknown): value is Format {
  return typeof value === 'string' && (FORMATS as readonly string[]).includes(value);
}

export const RESOURCE_STATUSES = ['draft', 'published', 'archived'] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];
export function isValidStatus(value: unknown): value is ResourceStatus {
  return typeof value === 'string' && (RESOURCE_STATUSES as readonly string[]).includes(value);
}

/** The only status a public listing/detail page should ever render — matches products' isPubliclyListedStatus() convention. */
export function isPubliclyVisibleStatus(status: string): boolean {
  return status === 'published';
}

export interface ResourceRecord {
  id: number;
  resourceId: string;
  slug: string;
  title: string;
  shortDescription: string | null;
  description: string | null;
  category: string;
  format: string;
  status: string;
  tags: string | null;
  fileMediaId: number | null;
  filePublicUrl: string | null;
  fileOriginalFilename: string | null;
  coverMediaId: number | null;
  coverPublicUrl: string | null;
  thumbnailMediaId: number | null;
  thumbnailPublicUrl: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  seoCanonicalUrl: string | null;
  featured: boolean;
  downloadCount: number;
  publishedAt: string | null;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface ResourceRow {
  id: number;
  resource_id: string;
  slug: string;
  title: string;
  short_description: string | null;
  description: string | null;
  category: string;
  format: string;
  status: string;
  tags: string | null;
  file_media_id: number | null;
  file_public_url: string | null;
  file_original_filename: string | null;
  cover_media_id: number | null;
  cover_public_url: string | null;
  thumbnail_media_id: number | null;
  thumbnail_public_url: string | null;
  seo_title: string | null;
  seo_description: string | null;
  seo_canonical_url: string | null;
  featured: number;
  download_count: number;
  published_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const RESOURCE_SELECT_COLUMNS = `
  r.id, r.resource_id, r.slug, r.title, r.short_description, r.description,
  r.category, r.format, r.status, r.tags,
  r.file_media_id, file.public_url AS file_public_url, file.original_filename AS file_original_filename,
  r.cover_media_id, cover.public_url AS cover_public_url,
  r.thumbnail_media_id, thumb.public_url AS thumbnail_public_url,
  r.seo_title, r.seo_description, r.seo_canonical_url,
  r.featured, r.download_count, r.published_at,
  r.created_by, r.updated_by, r.created_at, r.updated_at, r.deleted_at
`;

const RESOURCE_FROM_CLAUSE = `
  FROM resources r
  LEFT JOIN media_assets file ON file.id = r.file_media_id
  LEFT JOIN media_assets cover ON cover.id = r.cover_media_id
  LEFT JOIN media_assets thumb ON thumb.id = r.thumbnail_media_id
`;

function fromRow(row: ResourceRow): ResourceRecord {
  return {
    id: row.id,
    resourceId: row.resource_id,
    slug: row.slug,
    title: row.title,
    shortDescription: row.short_description,
    description: row.description,
    category: row.category,
    format: row.format,
    status: row.status,
    tags: row.tags,
    fileMediaId: row.file_media_id,
    filePublicUrl: row.file_public_url,
    fileOriginalFilename: row.file_original_filename,
    coverMediaId: row.cover_media_id,
    coverPublicUrl: row.cover_public_url,
    thumbnailMediaId: row.thumbnail_media_id,
    thumbnailPublicUrl: row.thumbnail_public_url,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    seoCanonicalUrl: row.seo_canonical_url,
    featured: row.featured === 1,
    downloadCount: row.download_count,
    publishedAt: row.published_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export async function getResourceById(env: Env, id: number): Promise<ResourceRecord | null> {
  const row = await env.DB.prepare(`SELECT ${RESOURCE_SELECT_COLUMNS} ${RESOURCE_FROM_CLAUSE} WHERE r.id = ?`).bind(id).first<ResourceRow>();
  return row ? fromRow(row) : null;
}

export async function getResourceBySlug(env: Env, slug: string): Promise<ResourceRecord | null> {
  const row = await env.DB.prepare(`SELECT ${RESOURCE_SELECT_COLUMNS} ${RESOURCE_FROM_CLAUSE} WHERE r.slug = ? AND r.deleted_at IS NULL`)
    .bind(slug)
    .first<ResourceRow>();
  return row ? fromRow(row) : null;
}

// ============================================================
// List — server-side search, filter, sort, pagination
// ============================================================

export interface ListResourcesQuery {
  search: string | null;
  status: string | null;
  statuses?: readonly string[] | null;
  category: string | null;
  format: string | null;
  featured: boolean | null;
  showDeleted: boolean;
  sort: 'newest' | 'oldest' | 'title-az' | 'title-za';
  page: number;
  pageSize: number;
}

export interface ListResourcesResult {
  items: ResourceRecord[];
  total: number;
  page: number;
  pageSize: number;
}

const SORT_CLAUSES: Record<ListResourcesQuery['sort'], string> = {
  newest: 'r.created_at DESC',
  oldest: 'r.created_at ASC',
  'title-az': 'r.title COLLATE NOCASE ASC',
  'title-za': 'r.title COLLATE NOCASE DESC',
};

export async function listResources(env: Env, query: ListResourcesQuery): Promise<ListResourcesResult> {
  const conditions: string[] = [query.showDeleted ? 'r.deleted_at IS NOT NULL' : 'r.deleted_at IS NULL'];
  const bindings: unknown[] = [];

  if (query.statuses && query.statuses.length > 0) {
    conditions.push(`r.status IN (${query.statuses.map(() => '?').join(',')})`);
    bindings.push(...query.statuses);
  } else if (query.status) {
    conditions.push('r.status = ?');
    bindings.push(query.status);
  }
  if (query.category) {
    conditions.push('r.category = ?');
    bindings.push(query.category);
  }
  if (query.format) {
    conditions.push('r.format = ?');
    bindings.push(query.format);
  }
  if (query.featured !== null) {
    conditions.push('r.featured = ?');
    bindings.push(query.featured ? 1 : 0);
  }
  if (query.search) {
    // ESCAPE clause required — see productService.ts's own comment on
    // this exact SQLite LIKE-escaping requirement.
    conditions.push("(r.title LIKE ? ESCAPE '\\' OR r.slug LIKE ? ESCAPE '\\' OR r.tags LIKE ? ESCAPE '\\' OR r.short_description LIKE ? ESCAPE '\\')");
    const pattern = `%${query.search.replace(/[%_\\]/g, '\\$&')}%`;
    bindings.push(pattern, pattern, pattern, pattern);
  }

  const whereClause = conditions.join(' AND ');
  const orderClause = SORT_CLAUSES[query.sort];
  const offset = (query.page - 1) * query.pageSize;

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(`SELECT ${RESOURCE_SELECT_COLUMNS} ${RESOURCE_FROM_CLAUSE} WHERE ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`)
      .bind(...bindings, query.pageSize, offset)
      .all<ResourceRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM resources r WHERE ${whereClause}`)
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

export interface ResourceValidationError {
  field: string;
  message: string;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const SEO_TITLE_MAX = 70;
const SEO_DESCRIPTION_MAX = 160;

export interface ResourceInput {
  slug: string;
  title: string;
  shortDescription?: string | null;
  description?: string | null;
  category: string;
  format: string;
  status?: string;
  tags?: string | null;
  fileMediaId?: number | null;
  coverMediaId?: number | null;
  thumbnailMediaId?: number | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoCanonicalUrl?: string | null;
  featured?: boolean;
}

export async function validateResourceInput(env: Env, input: ResourceInput, excludeId: number | null): Promise<ResourceValidationError[]> {
  const errors: ResourceValidationError[] = [];

  if (!input.title || input.title.trim().length === 0) errors.push({ field: 'title', message: 'Title is required.' });
  if (input.title && input.title.length > 200) errors.push({ field: 'title', message: 'Title must be 200 characters or fewer.' });

  if (!input.slug || !SLUG_PATTERN.test(input.slug)) {
    errors.push({ field: 'slug', message: 'Slug must be lowercase letters, numbers, and hyphens only.' });
  }
  if (!isValidCategory(input.category)) errors.push({ field: 'category', message: 'A valid category is required.' });
  if (!isValidFormat(input.format)) errors.push({ field: 'format', message: 'A valid format is required.' });
  if (input.status !== undefined && !isValidStatus(input.status)) errors.push({ field: 'status', message: 'Invalid status.' });

  // A resource can only genuinely be "published" with a real downloadable
  // file — mirrors products' "active needs a price" rule (the equivalent
  // real-content requirement for this content type).
  if (input.status === 'published' && (input.fileMediaId === undefined || input.fileMediaId === null)) {
    errors.push({ field: 'fileMediaId', message: 'A file is required before a resource can be published.' });
  }

  if (input.seoTitle && input.seoTitle.length > SEO_TITLE_MAX) {
    errors.push({ field: 'seoTitle', message: `SEO title must be ${SEO_TITLE_MAX} characters or fewer.` });
  }
  if (input.seoDescription && input.seoDescription.length > SEO_DESCRIPTION_MAX) {
    errors.push({ field: 'seoDescription', message: `SEO description must be ${SEO_DESCRIPTION_MAX} characters or fewer.` });
  }

  const mediaIds = [input.fileMediaId, input.coverMediaId, input.thumbnailMediaId].filter((id): id is number => typeof id === 'number');
  if (mediaIds.length > 0) {
    const placeholders = mediaIds.map(() => '?').join(',');
    const { results } = await env.DB.prepare(`SELECT id FROM media_assets WHERE id IN (${placeholders}) AND deleted_at IS NULL`)
      .bind(...mediaIds)
      .all<{ id: number }>();
    const foundIds = new Set(results.map((r) => r.id));
    for (const id of new Set(mediaIds)) {
      if (!foundIds.has(id)) errors.push({ field: 'media', message: `Media asset ${id} could not be found.` });
    }
  }

  if (input.slug && SLUG_PATTERN.test(input.slug)) {
    const existing = await env.DB.prepare(`SELECT id FROM resources WHERE slug = ? AND deleted_at IS NULL AND id IS NOT ?`)
      .bind(input.slug, excludeId ?? -1)
      .first<{ id: number }>();
    if (existing) errors.push({ field: 'slug', message: 'This slug is already in use by another resource.' });
  }

  return errors;
}

// ============================================================
// Create / Update
// ============================================================

function slugToResourceId(slug: string): string {
  return `res-${slug}`;
}

export async function createResource(env: Env, logger: Logger, actorId: number, input: ResourceInput): Promise<ResourceRecord> {
  const resourceId = slugToResourceId(input.slug);
  const status = input.status && isValidStatus(input.status) ? input.status : 'draft';
  const sanitizedDescription = await sanitizeRichTextHtml(input.description ?? null);
  const publishedAtClause = status === 'published' ? `datetime('now')` : 'NULL';

  const insert = await env.DB.prepare(
    `INSERT INTO resources (
       resource_id, slug, title, short_description, description, category, format, status, tags,
       file_media_id, cover_media_id, thumbnail_media_id, seo_title, seo_description, seo_canonical_url,
       featured, published_at, created_by, updated_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${publishedAtClause}, ?, ?)`
  )
    .bind(
      resourceId,
      input.slug,
      input.title,
      input.shortDescription ?? null,
      sanitizedDescription,
      input.category,
      input.format,
      status,
      input.tags ?? null,
      input.fileMediaId ?? null,
      input.coverMediaId ?? null,
      input.thumbnailMediaId ?? null,
      input.seoTitle ?? null,
      input.seoDescription ?? null,
      input.seoCanonicalUrl ?? null,
      input.featured ? 1 : 0,
      actorId,
      actorId
    )
    .run();

  const id = Number(insert.meta.last_row_id);

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'resource.created',
    entityType: 'resource',
    entityId: id,
    metadata: { slug: input.slug, title: input.title },
  });

  const resource = await getResourceById(env, id);
  return resource!;
}

export async function updateResource(env: Env, logger: Logger, actorId: number, id: number, input: ResourceInput): Promise<ResourceRecord | null> {
  const existing = await getResourceById(env, id);
  if (!existing || existing.deletedAt) return null;

  const sanitizedDescription = await sanitizeRichTextHtml(input.description ?? null);
  const nextStatus = input.status && isValidStatus(input.status) ? input.status : existing.status;
  // A resource transitioning into 'published' for the first time gets a
  // real published_at timestamp; one already published keeps its
  // original timestamp (never overwritten by a later, unrelated edit) —
  // matches transitionProductStatus's own publishedAtClause reasoning.
  const publishedAtClause = nextStatus === 'published' && !existing.publishedAt ? `, published_at = datetime('now')` : '';

  await env.DB.prepare(
    `UPDATE resources SET
       slug = ?, title = ?, short_description = ?, description = ?, category = ?, format = ?, status = ?, tags = ?,
       file_media_id = ?, cover_media_id = ?, thumbnail_media_id = ?, seo_title = ?, seo_description = ?, seo_canonical_url = ?,
       featured = ?, updated_by = ?, updated_at = datetime('now')${publishedAtClause}
     WHERE id = ?`
  )
    .bind(
      input.slug,
      input.title,
      input.shortDescription ?? null,
      sanitizedDescription,
      input.category,
      input.format,
      nextStatus,
      input.tags ?? null,
      input.fileMediaId ?? null,
      input.coverMediaId ?? null,
      input.thumbnailMediaId ?? null,
      input.seoTitle ?? null,
      input.seoDescription ?? null,
      input.seoCanonicalUrl ?? null,
      input.featured ? 1 : 0,
      actorId,
      id
    )
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'resource.updated',
    entityType: 'resource',
    entityId: id,
  });

  return getResourceById(env, id);
}

// ============================================================
// Publish lifecycle — Draft -> Published -> Archived
// ============================================================

export type LifecycleAction = 'publish' | 'unpublish' | 'archive' | 'unarchive';

const LIFECYCLE_TARGET_STATUS: Record<LifecycleAction, ResourceStatus> = {
  publish: 'published',
  unpublish: 'draft',
  archive: 'archived',
  unarchive: 'draft',
};

export type LifecycleResult = { ok: true; resource: ResourceRecord } | { ok: false; reason: 'not_found' | 'missing_file' };

export async function transitionResourceStatus(env: Env, logger: Logger, actorId: number, id: number, action: LifecycleAction): Promise<LifecycleResult> {
  const existing = await getResourceById(env, id);
  if (!existing || existing.deletedAt) return { ok: false, reason: 'not_found' };

  const targetStatus = LIFECYCLE_TARGET_STATUS[action];
  if (targetStatus === 'published' && existing.fileMediaId === null) {
    return { ok: false, reason: 'missing_file' };
  }

  const publishedAtClause = targetStatus === 'published' && !existing.publishedAt ? `, published_at = datetime('now')` : '';

  await env.DB.prepare(`UPDATE resources SET status = ?, updated_by = ?, updated_at = datetime('now')${publishedAtClause} WHERE id = ?`)
    .bind(targetStatus, actorId, id)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: `resource.${action}`,
    entityType: 'resource',
    entityId: id,
    metadata: { fromStatus: existing.status, toStatus: targetStatus },
  });

  const resource = await getResourceById(env, id);
  return { ok: true, resource: resource! };
}

// ============================================================
// Soft delete / restore
// ============================================================

export type SoftDeleteResult = { ok: true } | { ok: false; reason: 'not_found' | 'already_deleted' };

export async function softDeleteResource(env: Env, logger: Logger, actorId: number, id: number): Promise<SoftDeleteResult> {
  const existing = await getResourceById(env, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.deletedAt) return { ok: false, reason: 'already_deleted' };

  await env.DB.prepare(`UPDATE resources SET deleted_at = datetime('now'), updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(actorId, id)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'resource.deleted',
    entityType: 'resource',
    entityId: id,
    metadata: { slug: existing.slug, title: existing.title },
  });

  return { ok: true };
}

export type RestoreResult = { ok: true; resource: ResourceRecord } | { ok: false; reason: 'not_found' | 'not_deleted' };

export async function restoreResource(env: Env, logger: Logger, actorId: number, id: number): Promise<RestoreResult> {
  const row = await env.DB.prepare(`SELECT deleted_at FROM resources WHERE id = ?`).bind(id).first<{ deleted_at: string | null }>();
  if (!row) return { ok: false, reason: 'not_found' };
  if (!row.deleted_at) return { ok: false, reason: 'not_deleted' };

  await env.DB.prepare(`UPDATE resources SET deleted_at = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(actorId, id)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'resource.restored',
    entityType: 'resource',
    entityId: id,
  });

  const resource = await getResourceById(env, id);
  return { ok: true, resource: resource! };
}

// ============================================================
// Duplicate
// ============================================================

async function generateCopySlug(env: Env, baseSlug: string): Promise<string> {
  let candidate = `${baseSlug}-copy`;
  let suffix = 2;
  while (await env.DB.prepare(`SELECT id FROM resources WHERE slug = ?`).bind(candidate).first()) {
    candidate = `${baseSlug}-copy-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function duplicateResource(env: Env, logger: Logger, actorId: number, id: number): Promise<ResourceRecord | null> {
  const source = await getResourceById(env, id);
  if (!source || source.deletedAt) return null;

  const newSlug = await generateCopySlug(env, source.slug);
  const created = await createResource(env, logger, actorId, {
    slug: newSlug,
    title: `${source.title} (Copy)`,
    shortDescription: source.shortDescription,
    description: source.description,
    category: source.category,
    format: source.format,
    status: 'draft', // a duplicate never inherits the source's live/published state
    tags: source.tags,
    fileMediaId: source.fileMediaId,
    coverMediaId: source.coverMediaId,
    thumbnailMediaId: source.thumbnailMediaId,
    seoTitle: null, // page-identity fields — never copied verbatim onto a new URL, matches duplicateProduct's own reasoning
    seoDescription: source.seoDescription,
    seoCanonicalUrl: null,
    featured: false, // never duplicate a featured slot onto an unreviewed draft
  });

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'resource.duplicated',
    entityType: 'resource',
    entityId: created.id,
    metadata: { sourceResourceId: id, sourceSlug: source.slug },
  });

  return getResourceById(env, created.id);
}

// ============================================================
// Downloads — server-side counter, never client-trusted
// ============================================================

export async function incrementDownloadCount(env: Env, id: number): Promise<void> {
  await env.DB.prepare(`UPDATE resources SET download_count = download_count + 1 WHERE id = ?`).bind(id).run();
}
