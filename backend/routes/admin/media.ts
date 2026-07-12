/**
 * /api/admin/media/* — Version 2.0 Phase 1 (Media Library). See
 * docs/v2-media-library-spec.md and services/mediaService.ts (all real
 * logic lives there; this file is the thin HTTP layer only, per this
 * project's established routes/ convention).
 *
 * Role gating: viewing (list/get) is open to every authenticated role
 * (matches dashboard.ts's "read-only, all three roles" precedent).
 * Every mutation (upload/update/replace/delete/restore) requires
 * `editor` or `super_admin` — `support` is view-only here, the first
 * real consumer of `requireRole()` in this codebase (it existed since
 * Phase 0.1 but nothing had used it until now).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import { isAllowedFolder } from '../../utils/mediaValidation';
import * as mediaService from '../../services/mediaService';
import type { MediaRecord } from '../../services/mediaService';

const EDITOR_ROLES = ['super_admin', 'editor'] as const;

const UPLOAD_RATE_LIMIT = { endpoint: 'media-upload', limit: 30, windowSeconds: 15 * 60 };

/**
 * A duplicate-upload rejection still needs to hand the frontend enough
 * to say "already uploaded — view it" — the shared `ApiErrorResponse`
 * type only carries `code`/`message`, so this attaches one extra
 * `duplicate` field alongside it directly, rather than widening the
 * envelope every other endpoint in this codebase relies on staying
 * exactly `{code, message}`.
 */
function duplicateAssetResponse(message: string, existing: MediaRecord | undefined): Response {
  const body = {
    success: false,
    error: { code: 'DUPLICATE_ASSET', message },
    duplicate: existing ? toApiShape(existing) : null,
  };
  return new Response(JSON.stringify(body), { status: 409, headers: { 'Content-Type': 'application/json' } });
}

/** Every response shape the frontend actually consumes — camelCase, matching every other admin endpoint's envelope. */
function toApiShape(media: MediaRecord) {
  return {
    id: media.id,
    filename: media.filename,
    originalFilename: media.originalFilename,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    width: media.width,
    height: media.height,
    publicUrl: media.publicUrl,
    thumbnailPublicUrl: media.thumbnailPublicUrl,
    mediaType: media.mediaType,
    folder: media.folder,
    altText: media.altText,
    title: media.title,
    description: media.description,
    tags: media.tags,
    status: media.status,
    uploadedBy: media.uploadedBy,
    createdAt: media.createdAt,
    updatedAt: media.updatedAt,
    deletedAt: media.deletedAt,
    storageKey: media.storageKey,
  };
}

function isUploadedFile(value: unknown): value is File {
  return typeof value === 'object' && value !== null && typeof (value as File).arrayBuffer === 'function';
}

async function readFileField(form: FormData, field: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
  const value = form.get(field);
  if (!isUploadedFile(value)) return null;
  const buffer = await value.arrayBuffer();
  return { bytes: new Uint8Array(buffer), filename: value.name || 'file' };
}

function stringField(form: FormData, field: string): string | null {
  const value = form.get(field);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function handleMediaUpload(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  if (await isRateLimited(request, env, UPLOAD_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many uploads. Please try again in a few minutes.');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Could not read the upload.');
  }

  const file = await readFileField(form, 'file');
  if (!file || file.bytes.byteLength === 0) {
    return jsonError('VALIDATION_ERROR', 'No file was provided.');
  }

  const folderInput = stringField(form, 'folder') ?? 'uncategorized';
  if (!isAllowedFolder(folderInput)) {
    return jsonError('VALIDATION_ERROR', 'Invalid folder.');
  }

  const thumbnail = await readFileField(form, 'thumbnail');

  const result = await mediaService.uploadMedia(env, logger, {
    fileBytes: file.bytes,
    originalFilename: file.filename,
    folder: folderInput,
    altText: stringField(form, 'altText'),
    title: stringField(form, 'title'),
    description: stringField(form, 'description'),
    tags: stringField(form, 'tags'),
    uploadedBy: auth.auth.adminId,
    thumbnailBytes: thumbnail?.bytes,
  });

  if (!result.ok) {
    if (result.reason === 'duplicate') return duplicateAssetResponse(result.message, result.duplicateOf);
    if (result.reason === 'unsupported_file_type') return jsonError('UNSUPPORTED_FILE_TYPE', result.message);
    return jsonError('FILE_REJECTED', result.message);
  }

  return jsonSuccess(toApiShape(result.media), 201);
}

export async function handleMediaList(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const params = url.searchParams;

  const mediaTypeRaw = params.get('type');
  const mediaType = mediaTypeRaw === 'image' || mediaTypeRaw === 'document' ? mediaTypeRaw : null;

  const folderRaw = params.get('folder');
  const folder = folderRaw && isAllowedFolder(folderRaw) ? folderRaw : null;

  const sortRaw = params.get('sort');
  const validSorts = ['newest', 'oldest', 'largest', 'smallest', 'az', 'za'] as const;
  const sort = (validSorts as readonly string[]).includes(sortRaw ?? '') ? (sortRaw as (typeof validSorts)[number]) : 'newest';

  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('pageSize') ?? '24', 10) || 24));

  const result = await mediaService.listMedia(env, {
    search: params.get('search'),
    mediaType,
    folder,
    showDeleted: params.get('deleted') === 'true',
    sort,
    page,
    pageSize,
  });

  return jsonSuccess({
    items: result.items.map(toApiShape),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
}

export async function handleMediaGet(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const id = parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return jsonError('MEDIA_NOT_FOUND', 'This media item could not be found.');

  const media = await mediaService.getMediaById(env, id);
  if (!media) return jsonError('MEDIA_NOT_FOUND', 'This media item could not be found.');

  return jsonSuccess(toApiShape(media));
}

export async function handleMediaUpdate(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return jsonError('MEDIA_NOT_FOUND', 'This media item could not be found.');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Invalid request body.');
  }
  const patch = (body as Record<string, unknown>) ?? {};

  const folder = typeof patch.folder === 'string' && isAllowedFolder(patch.folder) ? patch.folder : undefined;

  const updated = await mediaService.updateMetadata(env, logger, id, auth.auth.adminId, {
    altText: typeof patch.altText === 'string' ? patch.altText : patch.altText === null ? null : undefined,
    title: typeof patch.title === 'string' ? patch.title : patch.title === null ? null : undefined,
    description: typeof patch.description === 'string' ? patch.description : patch.description === null ? null : undefined,
    tags: typeof patch.tags === 'string' ? patch.tags : patch.tags === null ? null : undefined,
    folder,
  });

  if (!updated) return jsonError('MEDIA_NOT_FOUND', 'This media item could not be found.');
  return jsonSuccess(toApiShape(updated));
}

export async function handleMediaReplace(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  if (await isRateLimited(request, env, UPLOAD_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many uploads. Please try again in a few minutes.');
  }

  const id = parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return jsonError('MEDIA_NOT_FOUND', 'This media item could not be found.');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Could not read the upload.');
  }

  const file = await readFileField(form, 'file');
  if (!file || file.bytes.byteLength === 0) return jsonError('VALIDATION_ERROR', 'No file was provided.');
  const thumbnail = await readFileField(form, 'thumbnail');

  const result = await mediaService.replaceMedia(env, logger, id, auth.auth.adminId, {
    fileBytes: file.bytes,
    originalFilename: file.filename,
    altText: null,
    title: null,
    description: null,
    tags: null,
    thumbnailBytes: thumbnail?.bytes,
  });

  if (!result.ok) {
    if (result.reason === 'unsupported_file_type') return jsonError('UNSUPPORTED_FILE_TYPE', result.message);
    return jsonError('FILE_REJECTED', result.message);
  }

  return jsonSuccess(toApiShape(result.media));
}

export async function handleMediaDelete(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return jsonError('MEDIA_NOT_FOUND', 'This media item could not be found.');

  const result = await mediaService.softDeleteMedia(env, logger, id, auth.auth.adminId);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('MEDIA_NOT_FOUND', 'This media item could not be found.');
    return jsonError('ALREADY_DELETED', 'This media item has already been deleted.');
  }

  return jsonSuccess({ deleted: true });
}

export async function handleMediaRestore(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = parseInt(params.id ?? '', 10);
  if (!Number.isInteger(id)) return jsonError('MEDIA_NOT_FOUND', 'This media item could not be found.');

  const result = await mediaService.restoreMedia(env, logger, id, auth.auth.adminId);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('MEDIA_NOT_FOUND', 'This media item could not be found.');
    return jsonError('NOT_DELETED', 'This media item is not deleted.');
  }

  return jsonSuccess(toApiShape(result.media));
}
