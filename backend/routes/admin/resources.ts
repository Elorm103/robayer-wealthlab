/**
 * /api/admin/resources/* — Version 2.1 Phase 1 (Resources CMS). See
 * docs/v2.1-architecture-plan.md Section 3 and services/resourceService.ts
 * (all real logic lives there; this file is the thin HTTP layer only,
 * per this project's established routes/ convention — see
 * routes/admin/products.ts).
 *
 * Role gating: viewing (list/get/meta) is open to every authenticated
 * role. Every mutation requires `editor` or `super_admin` — Resources
 * is content management (like Products), not a support-triage
 * workflow (unlike Consultation/Contact Manager's all-roles-write
 * pattern). No endpoint here ever hard-deletes a resource — soft
 * delete/restore only, mirroring Products/Media Library.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import * as resourceService from '../../services/resourceService';
import type { ResourceInput, ResourceRecord, LifecycleAction } from '../../services/resourceService';
import { CATEGORIES, FORMATS, RESOURCE_STATUSES } from '../../services/resourceService';

const EDITOR_ROLES = ['super_admin', 'editor'] as const;

const WRITE_RATE_LIMIT = { endpoint: 'resources-write', limit: 60, windowSeconds: 15 * 60 };

function toApiShape(resource: ResourceRecord) {
  return {
    id: resource.id,
    resourceId: resource.resourceId,
    slug: resource.slug,
    title: resource.title,
    shortDescription: resource.shortDescription,
    description: resource.description,
    category: resource.category,
    format: resource.format,
    status: resource.status,
    tags: resource.tags,
    fileMediaId: resource.fileMediaId,
    filePublicUrl: resource.filePublicUrl,
    fileOriginalFilename: resource.fileOriginalFilename,
    coverMediaId: resource.coverMediaId,
    coverPublicUrl: resource.coverPublicUrl,
    thumbnailMediaId: resource.thumbnailMediaId,
    thumbnailPublicUrl: resource.thumbnailPublicUrl,
    seoTitle: resource.seoTitle,
    seoDescription: resource.seoDescription,
    seoCanonicalUrl: resource.seoCanonicalUrl,
    featured: resource.featured,
    downloadCount: resource.downloadCount,
    publishedAt: resource.publishedAt,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
    deletedAt: resource.deletedAt,
  };
}

function toApiListShape(resource: ResourceRecord) {
  return {
    id: resource.id,
    resourceId: resource.resourceId,
    slug: resource.slug,
    title: resource.title,
    category: resource.category,
    format: resource.format,
    status: resource.status,
    featured: resource.featured,
    downloadCount: resource.downloadCount,
    thumbnailPublicUrl: resource.thumbnailPublicUrl,
    coverPublicUrl: resource.coverPublicUrl,
    publishedAt: resource.publishedAt,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
    deletedAt: resource.deletedAt,
  };
}

function parseResourceInput(body: Record<string, unknown>): ResourceInput {
  return {
    slug: typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '',
    title: typeof body.title === 'string' ? body.title.trim() : '',
    shortDescription: typeof body.shortDescription === 'string' ? body.shortDescription : body.shortDescription === null ? null : undefined,
    description: typeof body.description === 'string' ? body.description : body.description === null ? null : undefined,
    category: typeof body.category === 'string' ? body.category : '',
    format: typeof body.format === 'string' ? body.format : '',
    status: typeof body.status === 'string' ? body.status : undefined,
    tags: typeof body.tags === 'string' ? body.tags : body.tags === null ? null : undefined,
    fileMediaId: typeof body.fileMediaId === 'number' ? body.fileMediaId : body.fileMediaId === null ? null : undefined,
    coverMediaId: typeof body.coverMediaId === 'number' ? body.coverMediaId : body.coverMediaId === null ? null : undefined,
    thumbnailMediaId: typeof body.thumbnailMediaId === 'number' ? body.thumbnailMediaId : body.thumbnailMediaId === null ? null : undefined,
    seoTitle: typeof body.seoTitle === 'string' ? body.seoTitle : body.seoTitle === null ? null : undefined,
    seoDescription: typeof body.seoDescription === 'string' ? body.seoDescription : body.seoDescription === null ? null : undefined,
    seoCanonicalUrl: typeof body.seoCanonicalUrl === 'string' ? body.seoCanonicalUrl : body.seoCanonicalUrl === null ? null : undefined,
    featured: typeof body.featured === 'boolean' ? body.featured : undefined,
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

function validationErrorResponse(errors: resourceService.ResourceValidationError[]): Response {
  const body = {
    success: false,
    error: { code: 'VALIDATION_ERROR', message: errors[0]?.message ?? 'Validation failed.' },
    fields: errors,
  };
  return new Response(JSON.stringify(body), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================
// Meta
// ============================================================

export async function handleResourcesMeta(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  return jsonSuccess({ categories: CATEGORIES, formats: FORMATS, statuses: RESOURCE_STATUSES });
}

// ============================================================
// List
// ============================================================

export async function handleResourcesList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;

  const sortRaw = params.get('sort');
  const validSorts = ['newest', 'oldest', 'title-az', 'title-za'] as const;
  const sort = (validSorts as readonly string[]).includes(sortRaw ?? '') ? (sortRaw as (typeof validSorts)[number]) : 'newest';

  const statusRaw = params.get('status');
  const status = statusRaw && (RESOURCE_STATUSES as readonly string[]).includes(statusRaw) ? statusRaw : null;

  const categoryRaw = params.get('category');
  const category = categoryRaw && (CATEGORIES as readonly string[]).includes(categoryRaw) ? categoryRaw : null;

  const formatRaw = params.get('format');
  const format = formatRaw && (FORMATS as readonly string[]).includes(formatRaw) ? formatRaw : null;

  const featuredRaw = params.get('featured');
  const featured = featuredRaw === 'true' ? true : featuredRaw === 'false' ? false : null;

  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '20', 10) || 20));

  const result = await resourceService.listResources(env, {
    search: params.get('search'),
    status,
    category,
    format,
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

export async function handleResourceGet(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This resource could not be found.');

  const resource = await resourceService.getResourceById(env, id);
  if (!resource) return jsonError('NOT_FOUND', 'This resource could not be found.');

  return jsonSuccess(toApiShape(resource));
}

// ============================================================
// Create
// ============================================================

export async function handleResourceCreate(request: Request, env: Env, logger: Logger): Promise<Response> {
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

  const input = parseResourceInput(body);
  const errors = await resourceService.validateResourceInput(env, input, null);
  if (errors.length > 0) return validationErrorResponse(errors);

  const resource = await resourceService.createResource(env, logger, auth.auth.adminId, input);
  return jsonSuccess(toApiShape(resource), 201);
}

// ============================================================
// Update
// ============================================================

export async function handleResourceUpdate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This resource could not be found.');

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  const input = parseResourceInput(body);
  const errors = await resourceService.validateResourceInput(env, input, id);
  if (errors.length > 0) return validationErrorResponse(errors);

  const updated = await resourceService.updateResource(env, logger, auth.auth.adminId, id, input);
  if (!updated) return jsonError('NOT_FOUND', 'This resource could not be found.');

  return jsonSuccess(toApiShape(updated));
}

// ============================================================
// Status transitions
// ============================================================

const LIFECYCLE_ACTIONS: readonly LifecycleAction[] = ['publish', 'unpublish', 'archive', 'unarchive'];

export async function handleResourceStatusTransition(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This resource could not be found.');

  const body = await readJsonBody(request);
  const action = body?.action;
  if (typeof action !== 'string' || !(LIFECYCLE_ACTIONS as readonly string[]).includes(action)) {
    return jsonError('VALIDATION_ERROR', 'A valid action is required.');
  }

  const result = await resourceService.transitionResourceStatus(env, logger, auth.auth.adminId, id, action as LifecycleAction);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This resource could not be found.');
    return jsonError('INVALID_STATUS_TRANSITION', 'This resource needs a file before it can be published.');
  }

  return jsonSuccess(toApiShape(result.resource));
}

// ============================================================
// Duplicate
// ============================================================

export async function handleResourceDuplicate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This resource could not be found.');

  const duplicate = await resourceService.duplicateResource(env, logger, auth.auth.adminId, id);
  if (!duplicate) return jsonError('NOT_FOUND', 'This resource could not be found.');

  return jsonSuccess(toApiShape(duplicate), 201);
}

// ============================================================
// Soft delete / restore
// ============================================================

export async function handleResourceDelete(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This resource could not be found.');

  const result = await resourceService.softDeleteResource(env, logger, auth.auth.adminId, id);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This resource could not be found.');
    return jsonError('ALREADY_DELETED', 'This resource has already been deleted.');
  }

  return jsonSuccess({ deleted: true });
}

export async function handleResourceRestore(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseId(params);
  if (id === null) return jsonError('NOT_FOUND', 'This resource could not be found.');

  const result = await resourceService.restoreResource(env, logger, auth.auth.adminId, id);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This resource could not be found.');
    return jsonError('NOT_DELETED', 'This resource is not deleted.');
  }

  return jsonSuccess(toApiShape(result.resource));
}

// ============================================================
// Bulk actions
// ============================================================

type BulkAction = 'delete' | 'restore' | 'publish' | 'unpublish' | 'archive' | 'unarchive';
const BULK_ACTIONS: readonly BulkAction[] = ['delete', 'restore', 'publish', 'unpublish', 'archive', 'unarchive'];
const BULK_LIFECYCLE_ACTIONS = new Set<BulkAction>(['publish', 'unpublish', 'archive', 'unarchive']);

export async function handleResourcesBulkAction(request: Request, env: Env, logger: Logger): Promise<Response> {
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
  if (ids.length === 0) return jsonError('VALIDATION_ERROR', 'At least one resource id is required.');
  if (typeof action !== 'string' || !(BULK_ACTIONS as readonly string[]).includes(action)) {
    return jsonError('VALIDATION_ERROR', 'A valid bulk action is required.');
  }

  const results: Array<{ id: number; ok: boolean; reason?: string }> = [];
  for (const id of ids) {
    if (action === 'delete') {
      const r = await resourceService.softDeleteResource(env, logger, auth.auth.adminId, id);
      results.push({ id, ok: r.ok, reason: r.ok ? undefined : r.reason });
    } else if (action === 'restore') {
      const r = await resourceService.restoreResource(env, logger, auth.auth.adminId, id);
      results.push({ id, ok: r.ok, reason: r.ok ? undefined : r.reason });
    } else if ((BULK_LIFECYCLE_ACTIONS as Set<string>).has(action)) {
      const r = await resourceService.transitionResourceStatus(env, logger, auth.auth.adminId, id, action as LifecycleAction);
      results.push({ id, ok: r.ok, reason: r.ok ? undefined : r.reason });
    }
  }

  return jsonSuccess({ results });
}
