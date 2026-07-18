/**
 * Blog Service — Version 2.1 Phase 2 (Blog CMS). See
 * docs/v2.1-architecture-plan.md Section 4 and
 * docs/v2.1-phase2-implementation.md. The only code that writes to
 * `blog_posts` — mirrors this codebase's established "one service
 * owns its tables" discipline (e.g. `services/resourceService.ts` for
 * `resources`).
 *
 * A trimmed, field-renamed copy of resourceService.ts's exact shape,
 * with the two genuinely new pieces this content type needs: real
 * author attribution (resolved from `admin_users`, not a free-text
 * field) and a reading-time estimate derived from the stored body's
 * word count at read time (not an admin-editable field — see the
 * implementation log for why this was judged worth the small
 * derived-value cost rather than dropped outright).
 *
 * Every mutating action here writes its own audit_logs row, matching
 * resourceService.ts's convention.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import * as auditService from './admin/auditService';
import { sanitizeRichTextHtml } from '../utils/richTextSanitizer';

export const CATEGORIES = ['saving', 'investing', 'budgeting'] as const;
export type Category = (typeof CATEGORIES)[number];
export function isValidCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

export const BLOG_STATUSES = ['draft', 'published'] as const;
export type BlogStatus = (typeof BLOG_STATUSES)[number];
export function isValidStatus(value: unknown): value is BlogStatus {
  return typeof value === 'string' && (BLOG_STATUSES as readonly string[]).includes(value);
}

/** The only status a public listing/detail page should ever render without an authenticated preview session — matches resources' isPubliclyVisibleStatus() convention. */
export function isPubliclyVisibleStatus(status: string): boolean {
  return status === 'published';
}

const WORDS_PER_MINUTE = 200;

/** Strips HTML tags before counting words — a rough but honest estimate, matching the real "~6 min read" figure the one migrated article already carried. */
export function estimateReadingTimeMinutes(bodyHtml: string | null): number {
  if (!bodyHtml) return 0;
  const text = bodyHtml.replace(/<[^>]+>/g, ' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export interface BlogPostRecord {
  id: number;
  postId: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body: string | null;
  category: string;
  tags: string | null;
  status: string;
  featured: boolean;
  coverMediaId: number | null;
  coverPublicUrl: string | null;
  authorId: number | null;
  authorName: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  seoCanonicalUrl: string | null;
  publishedAt: string | null;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface BlogPostRow {
  id: number;
  post_id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body: string | null;
  category: string;
  tags: string | null;
  status: string;
  featured: number;
  cover_media_id: number | null;
  cover_public_url: string | null;
  author_id: number | null;
  author_name: string | null;
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

const BLOG_SELECT_COLUMNS = `
  b.id, b.post_id, b.slug, b.title, b.excerpt, b.body,
  b.category, b.tags, b.status, b.featured,
  b.cover_media_id, cover.public_url AS cover_public_url,
  b.author_id, author.name AS author_name,
  b.seo_title, b.seo_description, b.seo_canonical_url, b.published_at,
  b.created_by, b.updated_by, b.created_at, b.updated_at, b.deleted_at
`;

const BLOG_FROM_CLAUSE = `
  FROM blog_posts b
  LEFT JOIN media_assets cover ON cover.id = b.cover_media_id
  LEFT JOIN admin_users author ON author.id = b.author_id
`;

function fromRow(row: BlogPostRow): BlogPostRecord {
  return {
    id: row.id,
    postId: row.post_id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    body: row.body,
    category: row.category,
    tags: row.tags,
    status: row.status,
    featured: row.featured === 1,
    coverMediaId: row.cover_media_id,
    coverPublicUrl: row.cover_public_url,
    authorId: row.author_id,
    authorName: row.author_name,
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

export async function getPostById(env: Env, id: number): Promise<BlogPostRecord | null> {
  const row = await env.DB.prepare(`SELECT ${BLOG_SELECT_COLUMNS} ${BLOG_FROM_CLAUSE} WHERE b.id = ?`).bind(id).first<BlogPostRow>();
  return row ? fromRow(row) : null;
}

export async function getPostBySlug(env: Env, slug: string): Promise<BlogPostRecord | null> {
  const row = await env.DB.prepare(`SELECT ${BLOG_SELECT_COLUMNS} ${BLOG_FROM_CLAUSE} WHERE b.slug = ? AND b.deleted_at IS NULL`)
    .bind(slug)
    .first<BlogPostRow>();
  return row ? fromRow(row) : null;
}

// ============================================================
// List — server-side search, filter, sort, pagination
// ============================================================

export interface ListPostsQuery {
  search: string | null;
  status: string | null;
  category: string | null;
  featured: boolean | null;
  showDeleted: boolean;
  sort: 'newest' | 'oldest' | 'title-az' | 'title-za';
  page: number;
  pageSize: number;
}

export interface ListPostsResult {
  items: BlogPostRecord[];
  total: number;
  page: number;
  pageSize: number;
}

const SORT_CLAUSES: Record<ListPostsQuery['sort'], string> = {
  newest: 'b.created_at DESC',
  oldest: 'b.created_at ASC',
  'title-az': 'b.title COLLATE NOCASE ASC',
  'title-za': 'b.title COLLATE NOCASE DESC',
};

export async function listPosts(env: Env, query: ListPostsQuery): Promise<ListPostsResult> {
  const conditions: string[] = [query.showDeleted ? 'b.deleted_at IS NOT NULL' : 'b.deleted_at IS NULL'];
  const bindings: unknown[] = [];

  if (query.status) {
    conditions.push('b.status = ?');
    bindings.push(query.status);
  }
  if (query.category) {
    conditions.push('b.category = ?');
    bindings.push(query.category);
  }
  if (query.featured !== null) {
    conditions.push('b.featured = ?');
    bindings.push(query.featured ? 1 : 0);
  }
  if (query.search) {
    // ESCAPE clause required — see productService.ts's own comment on
    // this exact SQLite LIKE-escaping requirement.
    conditions.push("(b.title LIKE ? ESCAPE '\\' OR b.slug LIKE ? ESCAPE '\\' OR b.excerpt LIKE ? ESCAPE '\\' OR b.tags LIKE ? ESCAPE '\\')");
    const pattern = `%${query.search.replace(/[%_\\]/g, '\\$&')}%`;
    bindings.push(pattern, pattern, pattern, pattern);
  }

  const whereClause = conditions.join(' AND ');
  const orderClause = SORT_CLAUSES[query.sort];
  const offset = (query.page - 1) * query.pageSize;

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(`SELECT ${BLOG_SELECT_COLUMNS} ${BLOG_FROM_CLAUSE} WHERE ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`)
      .bind(...bindings, query.pageSize, offset)
      .all<BlogPostRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM blog_posts b WHERE ${whereClause}`)
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

export interface BlogValidationError {
  field: string;
  message: string;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const SEO_TITLE_MAX = 70;
const SEO_DESCRIPTION_MAX = 160;

export interface BlogPostInput {
  slug: string;
  title: string;
  excerpt?: string | null;
  body?: string | null;
  category: string;
  tags?: string | null;
  status?: string;
  featured?: boolean;
  coverMediaId?: number | null;
  authorId?: number | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoCanonicalUrl?: string | null;
}

export async function validatePostInput(env: Env, input: BlogPostInput, excludeId: number | null): Promise<BlogValidationError[]> {
  const errors: BlogValidationError[] = [];

  if (!input.title || input.title.trim().length === 0) errors.push({ field: 'title', message: 'Title is required.' });
  if (input.title && input.title.length > 200) errors.push({ field: 'title', message: 'Title must be 200 characters or fewer.' });

  if (!input.slug || !SLUG_PATTERN.test(input.slug)) {
    errors.push({ field: 'slug', message: 'Slug must be lowercase letters, numbers, and hyphens only.' });
  }
  if (!isValidCategory(input.category)) errors.push({ field: 'category', message: 'A valid category is required.' });
  if (input.status !== undefined && !isValidStatus(input.status)) errors.push({ field: 'status', message: 'Invalid status.' });

  // A post can only genuinely be "published" with real body content —
  // the equivalent of products' "active needs a price" / resources'
  // "published needs a file" real-content requirement for this type.
  if (input.status === 'published' && (!input.body || input.body.trim().length === 0)) {
    errors.push({ field: 'body', message: 'A post needs body content before it can be published.' });
  }

  if (input.seoTitle && input.seoTitle.length > SEO_TITLE_MAX) {
    errors.push({ field: 'seoTitle', message: `SEO title must be ${SEO_TITLE_MAX} characters or fewer.` });
  }
  if (input.seoDescription && input.seoDescription.length > SEO_DESCRIPTION_MAX) {
    errors.push({ field: 'seoDescription', message: `SEO description must be ${SEO_DESCRIPTION_MAX} characters or fewer.` });
  }

  if (typeof input.coverMediaId === 'number') {
    const found = await env.DB.prepare(`SELECT id FROM media_assets WHERE id = ? AND deleted_at IS NULL`).bind(input.coverMediaId).first<{ id: number }>();
    if (!found) errors.push({ field: 'coverMediaId', message: `Media asset ${input.coverMediaId} could not be found.` });
  }

  if (typeof input.authorId === 'number') {
    const found = await env.DB.prepare(`SELECT id FROM admin_users WHERE id = ? AND is_active = 1 AND deleted_at IS NULL`).bind(input.authorId).first<{ id: number }>();
    if (!found) errors.push({ field: 'authorId', message: 'The selected author could not be found.' });
  }

  if (input.slug && SLUG_PATTERN.test(input.slug)) {
    const existing = await env.DB.prepare(`SELECT id FROM blog_posts WHERE slug = ? AND deleted_at IS NULL AND id IS NOT ?`)
      .bind(input.slug, excludeId ?? -1)
      .first<{ id: number }>();
    if (existing) errors.push({ field: 'slug', message: 'This slug is already in use by another post.' });
  }

  return errors;
}

// ============================================================
// Create / Update
// ============================================================

function slugToPostId(slug: string): string {
  return `post-${slug}`;
}

export async function createPost(env: Env, logger: Logger, actorId: number, input: BlogPostInput): Promise<BlogPostRecord> {
  const postId = slugToPostId(input.slug);
  const status = input.status && isValidStatus(input.status) ? input.status : 'draft';
  const sanitizedBody = await sanitizeRichTextHtml(input.body ?? null);
  const publishedAtClause = status === 'published' ? `datetime('now')` : 'NULL';

  const insert = await env.DB.prepare(
    `INSERT INTO blog_posts (
       post_id, slug, title, excerpt, body, category, tags, status, featured,
       cover_media_id, author_id, seo_title, seo_description, seo_canonical_url,
       published_at, created_by, updated_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${publishedAtClause}, ?, ?)`
  )
    .bind(
      postId,
      input.slug,
      input.title,
      input.excerpt ?? null,
      sanitizedBody,
      input.category,
      input.tags ?? null,
      status,
      input.featured ? 1 : 0,
      input.coverMediaId ?? null,
      input.authorId ?? actorId,
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
    action: 'blog.created',
    entityType: 'blog_post',
    entityId: id,
    metadata: { slug: input.slug, title: input.title },
  });

  const post = await getPostById(env, id);
  return post!;
}

export async function updatePost(env: Env, logger: Logger, actorId: number, id: number, input: BlogPostInput): Promise<BlogPostRecord | null> {
  const existing = await getPostById(env, id);
  if (!existing || existing.deletedAt) return null;

  const sanitizedBody = await sanitizeRichTextHtml(input.body ?? null);
  const nextStatus = input.status && isValidStatus(input.status) ? input.status : existing.status;
  // A post transitioning into 'published' for the first time gets a
  // real published_at timestamp; one already published keeps its
  // original timestamp — matches resources' own publishedAtClause reasoning.
  const publishedAtClause = nextStatus === 'published' && !existing.publishedAt ? `, published_at = datetime('now')` : '';

  await env.DB.prepare(
    `UPDATE blog_posts SET
       slug = ?, title = ?, excerpt = ?, body = ?, category = ?, tags = ?, status = ?, featured = ?,
       cover_media_id = ?, author_id = ?, seo_title = ?, seo_description = ?, seo_canonical_url = ?,
       updated_by = ?, updated_at = datetime('now')${publishedAtClause}
     WHERE id = ?`
  )
    .bind(
      input.slug,
      input.title,
      input.excerpt ?? null,
      sanitizedBody,
      input.category,
      input.tags ?? null,
      nextStatus,
      input.featured ? 1 : 0,
      input.coverMediaId ?? null,
      input.authorId ?? existing.authorId,
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
    action: 'blog.updated',
    entityType: 'blog_post',
    entityId: id,
  });

  return getPostById(env, id);
}

// ============================================================
// Publish lifecycle — Draft <-> Published (2 states, see migration's own header comment)
// ============================================================

export type LifecycleAction = 'publish' | 'unpublish';

const LIFECYCLE_TARGET_STATUS: Record<LifecycleAction, BlogStatus> = {
  publish: 'published',
  unpublish: 'draft',
};

export type LifecycleResult = { ok: true; post: BlogPostRecord } | { ok: false; reason: 'not_found' | 'missing_body' };

export async function transitionPostStatus(env: Env, logger: Logger, actorId: number, id: number, action: LifecycleAction): Promise<LifecycleResult> {
  const existing = await getPostById(env, id);
  if (!existing || existing.deletedAt) return { ok: false, reason: 'not_found' };

  const targetStatus = LIFECYCLE_TARGET_STATUS[action];
  if (targetStatus === 'published' && (!existing.body || existing.body.trim().length === 0)) {
    return { ok: false, reason: 'missing_body' };
  }

  const publishedAtClause = targetStatus === 'published' && !existing.publishedAt ? `, published_at = datetime('now')` : '';

  await env.DB.prepare(`UPDATE blog_posts SET status = ?, updated_by = ?, updated_at = datetime('now')${publishedAtClause} WHERE id = ?`)
    .bind(targetStatus, actorId, id)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: `blog.${action}`,
    entityType: 'blog_post',
    entityId: id,
    metadata: { fromStatus: existing.status, toStatus: targetStatus },
  });

  const post = await getPostById(env, id);
  return { ok: true, post: post! };
}

// ============================================================
// Duplicate
// ============================================================

async function generateCopySlug(env: Env, baseSlug: string): Promise<string> {
  let candidate = `${baseSlug}-copy`;
  let suffix = 2;
  while (await env.DB.prepare(`SELECT id FROM blog_posts WHERE slug = ?`).bind(candidate).first()) {
    candidate = `${baseSlug}-copy-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function duplicatePost(env: Env, logger: Logger, actorId: number, id: number): Promise<BlogPostRecord | null> {
  const source = await getPostById(env, id);
  if (!source || source.deletedAt) return null;

  const newSlug = await generateCopySlug(env, source.slug);
  const created = await createPost(env, logger, actorId, {
    slug: newSlug,
    title: `${source.title} (Copy)`,
    excerpt: source.excerpt,
    body: source.body,
    category: source.category,
    tags: source.tags,
    status: 'draft', // a duplicate never inherits the source's live/published state
    featured: false, // never duplicate a featured slot onto an unreviewed draft
    coverMediaId: source.coverMediaId,
    authorId: source.authorId,
    seoTitle: null, // page-identity fields — never copied verbatim onto a new URL, matches duplicateResource's own reasoning
    seoDescription: source.seoDescription,
    seoCanonicalUrl: null,
  });

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'blog.duplicated',
    entityType: 'blog_post',
    entityId: created.id,
    metadata: { sourcePostId: id, sourceSlug: source.slug },
  });

  return getPostById(env, created.id);
}

// ============================================================
// Soft delete / restore
// ============================================================

export type SoftDeleteResult = { ok: true } | { ok: false; reason: 'not_found' | 'already_deleted' };

export async function softDeletePost(env: Env, logger: Logger, actorId: number, id: number): Promise<SoftDeleteResult> {
  const existing = await getPostById(env, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.deletedAt) return { ok: false, reason: 'already_deleted' };

  await env.DB.prepare(`UPDATE blog_posts SET deleted_at = datetime('now'), updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(actorId, id)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'blog.deleted',
    entityType: 'blog_post',
    entityId: id,
    metadata: { slug: existing.slug, title: existing.title },
  });

  return { ok: true };
}

export type RestoreResult = { ok: true; post: BlogPostRecord } | { ok: false; reason: 'not_found' | 'not_deleted' };

export async function restorePost(env: Env, logger: Logger, actorId: number, id: number): Promise<RestoreResult> {
  const row = await env.DB.prepare(`SELECT deleted_at FROM blog_posts WHERE id = ?`).bind(id).first<{ deleted_at: string | null }>();
  if (!row) return { ok: false, reason: 'not_found' };
  if (!row.deleted_at) return { ok: false, reason: 'not_deleted' };

  await env.DB.prepare(`UPDATE blog_posts SET deleted_at = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(actorId, id)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'blog.restored',
    entityType: 'blog_post',
    entityId: id,
  });

  const post = await getPostById(env, id);
  return { ok: true, post: post! };
}
