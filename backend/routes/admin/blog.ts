/**
 * /api/admin/blog/* — Version 2.1 Phase 2 (Blog CMS). See
 * docs/v2.1-architecture-plan.md Section 4 and services/blogService.ts
 * (all real logic lives there; this file is the thin HTTP layer only,
 * per this project's established routes/ convention — see
 * routes/admin/resources.ts).
 *
 * Role gating: viewing (list/get/meta) is open to every authenticated
 * role. Every mutation requires `editor` or `super_admin` — matches
 * Products'/Resources' content-management role convention.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import * as blogService from '../../services/blogService';
import type { BlogPostInput, BlogPostRecord, LifecycleAction } from '../../services/blogService';
import { CATEGORIES, BLOG_STATUSES, estimateReadingTimeMinutes } from '../../services/blogService';
import { listAssignableAdmins } from '../../services/admin/consultationService';

const EDITOR_ROLES = ['super_admin', 'editor'] as const;

const WRITE_RATE_LIMIT = { endpoint: 'blog-write', limit: 60, windowSeconds: 15 * 60 };

function toApiShape(post: BlogPostRecord) {
  return {
    id: post.id,
    postId: post.postId,
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    body: post.body,
    category: post.category,
    tags: post.tags,
    status: post.status,
    featured: post.featured,
    coverMediaId: post.coverMediaId,
    coverPublicUrl: post.coverPublicUrl,
    authorId: post.authorId,
    authorName: post.authorName,
    seoTitle: post.seoTitle,
    seoDescription: post.seoDescription,
    seoCanonicalUrl: post.seoCanonicalUrl,
    publishedAt: post.publishedAt,
    readingTimeMinutes: estimateReadingTimeMinutes(post.body),
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    deletedAt: post.deletedAt,
  };
}

function toApiListShape(post: BlogPostRecord) {
  return {
    id: post.id,
    postId: post.postId,
    slug: post.slug,
    title: post.title,
    category: post.category,
    status: post.status,
    featured: post.featured,
    authorName: post.authorName,
    coverPublicUrl: post.coverPublicUrl,
    publishedAt: post.publishedAt,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    deletedAt: post.deletedAt,
  };
}

function parsePostInput(body: Record<string, unknown>): BlogPostInput {
  return {
    slug: typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '',
    title: typeof body.title === 'string' ? body.title.trim() : '',
    excerpt: typeof body.excerpt === 'string' ? body.excerpt : body.excerpt === null ? null : undefined,
    body: typeof body.body === 'string' ? body.body : body.body === null ? null : undefined,
    category: typeof body.category === 'string' ? body.category : '',
    tags: typeof body.tags === 'string' ? body.tags : body.tags === null ? null : undefined,
    status: typeof body.status === 'string' ? body.status : undefined,
    featured: typeof body.featured === 'boolean' ? body.featured : undefined,
    coverMediaId: typeof body.coverMediaId === 'number' ? body.coverMediaId : body.coverMediaId === null ? null : undefined,
    authorId: typeof body.authorId === 'number' ? body.authorId : body.authorId === null ? null : undefined,
    seoTitle: typeof body.seoTitle === 'string' ? body.seoTitle : body.seoTitle === null ? null : undefined,
    seoDescription: typeof body.seoDescription === 'string' ? body.seoDescription : body.seoDescription === null ? null : undefined,
    seoCanonicalUrl: typeof body.seoCanonicalUrl === 'string' ? body.seoCanonicalUrl : body.seoCanonicalUrl === null ? null : undefined,
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

function parseId(params: RouteParams): number | null {
  const id = parseInt(params.id ?? '', 10);
  return Number.isInteger(id) ? id : null;
}

function validationErrorResponse(errors: blogService.BlogValidationError[]): Response {
  const body = {
    success: false,
    error: { code: 'VALIDATION_ERROR', message: errors[0]?.message ?? 'Validation failed.' },
    fields: errors,
  };
  return new Response(JSON.stringify(body), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================
// Meta — fixed taxonomies + assignable authors the editor's dropdowns need
// ============================================================

export async function handleBlogMeta(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const authors = await listAssignableAdmins(env);
  return jsonSuccess({ categories: CATEGORIES, statuses: BLOG_STATUSES, authors });
}

// ============================================================
// List
// ============================================================

export async function handleBlogList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;

  const sortRaw = params.get('sort');
  const validSorts = ['newest', 'oldest', 'title-az', 'title-za'] as const;
  const sort = (validSorts as readonly string[]).includes(sortRaw ?? '') ? (sortRaw as (typeof validSorts)[number]) : 'newest';

  const statusRaw = params.get('status');
  const status = statusRaw && (BLOG_STATUSES as readonly string[]).includes(statusRaw) ? statusRaw : null;

  const categoryRaw = params.get('category');
  const category = categoryRaw && (CATEGORIES as readonly string[]).includes(categoryRaw) ? categoryRaw : null;

  const featuredRaw = params.get('featured');
  const featured = featuredRaw === 'true' ? true : featuredRaw === 'false' ? false : null;

  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '20', 10) || 20));

  const result = await blogService.listPosts(env, {
    search: params.get('search'),
    status,
    category,
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

export async function handleBlogGet(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This post could not be found.');

  const post = await blogService.getPostById(env, id);
  if (!post) return jsonError('NOT_FOUND', 'This post could not be found.');

  return jsonSuccess(toApiShape(post));
}

// ============================================================
// Create
// ============================================================

export async function handleBlogCreate(request: Request, env: Env, logger: Logger): Promise<Response> {
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

  const input = parsePostInput(body);
  const errors = await blogService.validatePostInput(env, input, null);
  if (errors.length > 0) return validationErrorResponse(errors);

  const post = await blogService.createPost(env, logger, auth.auth.adminId, input);
  return jsonSuccess(toApiShape(post), 201);
}

// ============================================================
// Update
// ============================================================

export async function handleBlogUpdate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This post could not be found.');

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  const input = parsePostInput(body);
  const errors = await blogService.validatePostInput(env, input, id);
  if (errors.length > 0) return validationErrorResponse(errors);

  const updated = await blogService.updatePost(env, logger, auth.auth.adminId, id, input);
  if (!updated) return jsonError('NOT_FOUND', 'This post could not be found.');

  return jsonSuccess(toApiShape(updated));
}

// ============================================================
// Status transitions
// ============================================================

const LIFECYCLE_ACTIONS: readonly LifecycleAction[] = ['publish', 'unpublish'];

export async function handleBlogStatusTransition(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This post could not be found.');

  const body = await readJsonBody(request);
  const action = body?.action;
  if (typeof action !== 'string' || !(LIFECYCLE_ACTIONS as readonly string[]).includes(action)) {
    return jsonError('VALIDATION_ERROR', 'A valid action is required.');
  }

  const result = await blogService.transitionPostStatus(env, logger, auth.auth.adminId, id, action as LifecycleAction);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This post could not be found.');
    return jsonError('INVALID_STATUS_TRANSITION', 'This post needs body content before it can be published.');
  }

  return jsonSuccess(toApiShape(result.post));
}

// ============================================================
// Duplicate
// ============================================================

export async function handleBlogDuplicate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This post could not be found.');

  const duplicate = await blogService.duplicatePost(env, logger, auth.auth.adminId, id);
  if (!duplicate) return jsonError('NOT_FOUND', 'This post could not be found.');

  return jsonSuccess(toApiShape(duplicate), 201);
}

// ============================================================
// Soft delete / restore
// ============================================================

export async function handleBlogDelete(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This post could not be found.');

  const result = await blogService.softDeletePost(env, logger, auth.auth.adminId, id);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This post could not be found.');
    return jsonError('ALREADY_DELETED', 'This post has already been deleted.');
  }

  return jsonSuccess({ deleted: true });
}

export async function handleBlogRestore(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This post could not be found.');

  const result = await blogService.restorePost(env, logger, auth.auth.adminId, id);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This post could not be found.');
    return jsonError('NOT_DELETED', 'This post is not deleted.');
  }

  return jsonSuccess(toApiShape(result.post));
}

// ============================================================
// Bulk actions
// ============================================================

type BulkAction = 'delete' | 'restore' | 'publish' | 'unpublish';
const BULK_ACTIONS: readonly BulkAction[] = ['delete', 'restore', 'publish', 'unpublish'];
const BULK_LIFECYCLE_ACTIONS = new Set<BulkAction>(['publish', 'unpublish']);

export async function handleBlogBulkAction(request: Request, env: Env, logger: Logger): Promise<Response> {
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
  if (ids.length === 0) return jsonError('VALIDATION_ERROR', 'At least one post id is required.');
  if (typeof action !== 'string' || !(BULK_ACTIONS as readonly string[]).includes(action)) {
    return jsonError('VALIDATION_ERROR', 'A valid bulk action is required.');
  }

  const results: Array<{ id: number; ok: boolean; reason?: string }> = [];
  for (const id of ids) {
    if (action === 'delete') {
      const r = await blogService.softDeletePost(env, logger, auth.auth.adminId, id);
      results.push({ id, ok: r.ok, reason: r.ok ? undefined : r.reason });
    } else if (action === 'restore') {
      const r = await blogService.restorePost(env, logger, auth.auth.adminId, id);
      results.push({ id, ok: r.ok, reason: r.ok ? undefined : r.reason });
    } else if ((BULK_LIFECYCLE_ACTIONS as Set<string>).has(action)) {
      const r = await blogService.transitionPostStatus(env, logger, auth.auth.adminId, id, action as LifecycleAction);
      results.push({ id, ok: r.ok, reason: r.ok ? undefined : r.reason });
    }
  }

  return jsonSuccess({ results });
}
