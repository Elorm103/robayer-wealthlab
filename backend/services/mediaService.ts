/**
 * Media Library Service — Version 2.0 Phase 1. The only code that
 * writes to `media_assets` or the `media/` prefix in R2 (`STORAGE`
 * binding) — mirrors this codebase's established "one service owns one
 * table" discipline (e.g. `services/admin/sessionService.ts` for
 * `admin_sessions`).
 *
 * Every mutating action here writes its own audit_logs row, matching
 * `services/admin/authService.ts`'s convention (the service calls
 * `auditService.record()` itself, not the route) — so an action is
 * audited even if a future second call site is ever added.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { detectMediaType, sanitizeOriginalFilename, hashBytes, scanForThreats, isAllowedFolder, type MediaFolder } from '../utils/mediaValidation';
import { extractDimensions } from '../utils/imageDimensions';
import { buildStorageKey, buildThumbnailStorageKey, publicUrlForKey } from '../utils/mediaKey';
import * as auditService from './admin/auditService';

export interface MediaRecord {
  id: number;
  filename: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  storageKey: string;
  publicUrl: string;
  thumbnailStorageKey: string | null;
  thumbnailPublicUrl: string | null;
  mediaType: 'image' | 'document';
  folder: string;
  altText: string | null;
  title: string | null;
  description: string | null;
  tags: string | null;
  status: string;
  uploadedBy: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface MediaRow {
  id: number;
  filename: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  storage_key: string;
  public_url: string;
  thumbnail_storage_key: string | null;
  thumbnail_public_url: string | null;
  media_type: 'image' | 'document';
  folder: string;
  alt_text: string | null;
  title: string | null;
  description: string | null;
  tags: string | null;
  status: string;
  uploaded_by: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function fromRow(row: MediaRow): MediaRecord {
  return {
    id: row.id,
    filename: row.filename,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    storageKey: row.storage_key,
    publicUrl: row.public_url,
    thumbnailStorageKey: row.thumbnail_storage_key,
    thumbnailPublicUrl: row.thumbnail_public_url,
    mediaType: row.media_type,
    folder: row.folder,
    altText: row.alt_text,
    title: row.title,
    description: row.description,
    tags: row.tags,
    status: row.status,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

const SELECT_COLUMNS = `
  id, filename, original_filename, mime_type, size_bytes, width, height,
  storage_key, public_url, thumbnail_storage_key, thumbnail_public_url,
  media_type, folder, alt_text, title, description, tags, status,
  uploaded_by, created_at, updated_at, deleted_at
`;

export type UploadDenialReason = 'unsupported_file_type' | 'file_rejected' | 'duplicate';

export type UploadResult =
  | { ok: true; media: MediaRecord }
  | { ok: false; reason: UploadDenialReason; message: string; duplicateOf?: MediaRecord };

export interface UploadParams {
  fileBytes: Uint8Array;
  originalFilename: string;
  folder: MediaFolder;
  altText: string | null;
  title: string | null;
  description: string | null;
  tags: string | null;
  uploadedBy: number;
  /** Client-generated downscaled copy (canvas-rendered WebP) — see js/components/admin/admin-media.js. Images only; undefined for documents or when the browser couldn't produce one (thumbnail is optional, never blocks the upload). */
  thumbnailBytes?: Uint8Array;
}

/**
 * The full upload pipeline: sniff the real bytes → size check → hash →
 * duplicate check → (hook) threat scan → R2 put (original + optional
 * thumbnail) → D1 insert → audit. Every step before the R2 write is a
 * pure/read-only check, so a rejected upload never touches storage.
 */
export async function uploadMedia(env: Env, logger: Logger, params: UploadParams): Promise<UploadResult> {
  const detection = detectMediaType(params.fileBytes);
  if (!detection.ok) {
    return { ok: false, reason: 'unsupported_file_type', message: detection.reason };
  }
  const spec = detection.spec;

  if (params.fileBytes.byteLength > spec.maxSizeBytes) {
    const maxMb = Math.round(spec.maxSizeBytes / (1024 * 1024));
    return { ok: false, reason: 'file_rejected', message: `File exceeds the ${maxMb}MB limit for ${spec.kind}s.` };
  }

  const contentHash = await hashBytes(params.fileBytes);
  const existing = await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM media_assets WHERE content_hash = ? AND deleted_at IS NULL LIMIT 1`)
    .bind(contentHash)
    .first<MediaRow>();
  if (existing) {
    return {
      ok: false,
      reason: 'duplicate',
      message: 'This exact file has already been uploaded.',
      duplicateOf: fromRow(existing),
    };
  }

  const scan = await scanForThreats(params.fileBytes);
  if (!scan.clean) {
    return { ok: false, reason: 'file_rejected', message: 'This file could not be accepted.' };
  }

  const storageKey = buildStorageKey(spec.kind, params.folder, spec.extension);
  await env.STORAGE.put(storageKey, params.fileBytes, { httpMetadata: { contentType: spec.mimeType } });

  let thumbnailStorageKey: string | null = null;
  if (spec.kind === 'image' && params.thumbnailBytes && params.thumbnailBytes.byteLength > 0) {
    thumbnailStorageKey = buildThumbnailStorageKey(params.folder);
    await env.STORAGE.put(thumbnailStorageKey, params.thumbnailBytes, { httpMetadata: { contentType: 'image/webp' } });
  }

  const dimensions = spec.kind === 'image' ? extractDimensions(params.fileBytes, spec.mimeType) : null;
  const safeOriginalName = sanitizeOriginalFilename(params.originalFilename);
  const publicUrl = publicUrlForKey(storageKey);
  const thumbnailPublicUrl = thumbnailStorageKey ? publicUrlForKey(thumbnailStorageKey) : null;
  const filename = storageKey.split('/').pop() ?? safeOriginalName;

  const insert = await env.DB.prepare(
    `INSERT INTO media_assets
       (filename, original_filename, mime_type, size_bytes, width, height, content_hash,
        storage_key, public_url, thumbnail_storage_key, thumbnail_public_url,
        media_type, folder, alt_text, title, description, tags, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      filename,
      safeOriginalName,
      spec.mimeType,
      params.fileBytes.byteLength,
      dimensions?.width ?? null,
      dimensions?.height ?? null,
      contentHash,
      storageKey,
      publicUrl,
      thumbnailStorageKey,
      thumbnailPublicUrl,
      spec.kind,
      params.folder,
      params.altText,
      params.title,
      params.description,
      params.tags,
      params.uploadedBy
    )
    .run();

  const id = insert.meta.last_row_id;
  const row = await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM media_assets WHERE id = ?`).bind(id).first<MediaRow>();
  const media = fromRow(row!);

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId: params.uploadedBy,
    action: 'media.uploaded',
    entityType: 'media_asset',
    entityId: id,
    metadata: { filename: media.originalFilename, folder: media.folder, mediaType: media.mediaType },
  });

  return { ok: true, media };
}

export interface ListMediaQuery {
  search: string | null;
  mediaType: 'image' | 'document' | null;
  folder: string | null;
  showDeleted: boolean;
  sort: 'newest' | 'oldest' | 'largest' | 'smallest' | 'az' | 'za';
  page: number;
  pageSize: number;
}

export interface ListMediaResult {
  items: MediaRecord[];
  total: number;
  page: number;
  pageSize: number;
}

const SORT_CLAUSES: Record<ListMediaQuery['sort'], string> = {
  newest: 'created_at DESC',
  oldest: 'created_at ASC',
  largest: 'size_bytes DESC',
  smallest: 'size_bytes ASC',
  az: 'COALESCE(title, original_filename) COLLATE NOCASE ASC',
  za: 'COALESCE(title, original_filename) COLLATE NOCASE DESC',
};

/** Server-side filter, search, sort, and pagination — the list view never fetches more than one page's worth of rows. */
export async function listMedia(env: Env, query: ListMediaQuery): Promise<ListMediaResult> {
  const conditions: string[] = [query.showDeleted ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
  const bindings: unknown[] = [];

  if (query.mediaType) {
    conditions.push('media_type = ?');
    bindings.push(query.mediaType);
  }
  if (query.folder) {
    conditions.push('folder = ?');
    bindings.push(query.folder);
  }
  if (query.search) {
    // SQLite's LIKE has no default escape character — without an explicit
    // ESCAPE clause, the backslashes inserted below are matched literally
    // instead of escaping the following %/_, so a search term containing
    // % or _ would silently act as a wildcard against unrelated rows.
    conditions.push("(filename LIKE ? ESCAPE '\\' OR original_filename LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
    const pattern = `%${query.search.replace(/[%_\\]/g, '\\$&')}%`;
    bindings.push(pattern, pattern, pattern, pattern);
  }

  const whereClause = conditions.join(' AND ');
  const orderClause = SORT_CLAUSES[query.sort];
  const offset = (query.page - 1) * query.pageSize;

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM media_assets WHERE ${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?`)
      .bind(...bindings, query.pageSize, offset)
      .all<MediaRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM media_assets WHERE ${whereClause}`)
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

export async function getMediaById(env: Env, id: number): Promise<MediaRecord | null> {
  const row = await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM media_assets WHERE id = ?`).bind(id).first<MediaRow>();
  return row ? fromRow(row) : null;
}

/** Fetches by storage key for the public file-serving route — deliberately does not distinguish "not found" from "deleted" in its return (both mean "don't serve this"), matching every other public token/lookup endpoint's "identical outcome regardless of why" posture in this codebase. */
export async function getMediaByStorageKey(env: Env, storageKey: string): Promise<MediaRecord | null> {
  const row = await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM media_assets WHERE storage_key = ? AND deleted_at IS NULL`).bind(storageKey).first<MediaRow>();
  return row ? fromRow(row) : null;
}

export interface MetadataPatch {
  altText?: string | null;
  title?: string | null;
  description?: string | null;
  tags?: string | null;
  folder?: MediaFolder;
}

export async function updateMetadata(env: Env, logger: Logger, id: number, actorId: number, patch: MetadataPatch): Promise<MediaRecord | null> {
  const existing = await getMediaById(env, id);
  if (!existing || existing.deletedAt) return null;

  const folder = patch.folder && isAllowedFolder(patch.folder) ? patch.folder : existing.folder;

  await env.DB.prepare(
    `UPDATE media_assets SET alt_text = ?, title = ?, description = ?, tags = ?, folder = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(
      patch.altText !== undefined ? patch.altText : existing.altText,
      patch.title !== undefined ? patch.title : existing.title,
      patch.description !== undefined ? patch.description : existing.description,
      patch.tags !== undefined ? patch.tags : existing.tags,
      folder,
      id
    )
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'media.updated',
    entityType: 'media_asset',
    entityId: id,
  });

  return getMediaById(env, id);
}

export type ReplaceResult = UploadResult;

/**
 * Replaces an existing record's file content in place — the `id` and
 * every editorial field (alt_text/title/description/tags) are
 * preserved; only the storage-derived fields change. A new R2 object
 * is always written (never an overwrite of the existing key) — see
 * docs/v2-media-library-spec.md's "Replace" reasoning: avoids any risk
 * of a CDN/browser cache serving stale content at a URL that's
 * supposed to now point at different bytes. The previous R2 object is
 * deliberately NOT deleted here — see this file's "Known limitation"
 * note in docs/v2-media-library-spec.md.
 */
export async function replaceMedia(env: Env, logger: Logger, id: number, actorId: number, params: Omit<UploadParams, 'folder' | 'uploadedBy'>): Promise<ReplaceResult> {
  const existing = await getMediaById(env, id);
  if (!existing || existing.deletedAt) {
    return { ok: false, reason: 'file_rejected', message: 'This media item no longer exists.' };
  }

  const detection = detectMediaType(params.fileBytes);
  if (!detection.ok) return { ok: false, reason: 'unsupported_file_type', message: detection.reason };
  const spec = detection.spec;

  if (params.fileBytes.byteLength > spec.maxSizeBytes) {
    const maxMb = Math.round(spec.maxSizeBytes / (1024 * 1024));
    return { ok: false, reason: 'file_rejected', message: `File exceeds the ${maxMb}MB limit for ${spec.kind}s.` };
  }

  const contentHash = await hashBytes(params.fileBytes);
  const scan = await scanForThreats(params.fileBytes);
  if (!scan.clean) return { ok: false, reason: 'file_rejected', message: 'This file could not be accepted.' };

  const folder = existing.folder as MediaFolder;
  const storageKey = buildStorageKey(spec.kind, folder, spec.extension);
  await env.STORAGE.put(storageKey, params.fileBytes, { httpMetadata: { contentType: spec.mimeType } });

  let thumbnailStorageKey: string | null = null;
  let thumbnailPublicUrl: string | null = null;
  if (spec.kind === 'image' && params.thumbnailBytes && params.thumbnailBytes.byteLength > 0) {
    thumbnailStorageKey = buildThumbnailStorageKey(folder);
    await env.STORAGE.put(thumbnailStorageKey, params.thumbnailBytes, { httpMetadata: { contentType: 'image/webp' } });
    thumbnailPublicUrl = publicUrlForKey(thumbnailStorageKey);
  }

  const dimensions = spec.kind === 'image' ? extractDimensions(params.fileBytes, spec.mimeType) : null;
  const safeOriginalName = sanitizeOriginalFilename(params.originalFilename);
  const publicUrl = publicUrlForKey(storageKey);
  const filename = storageKey.split('/').pop() ?? safeOriginalName;

  await env.DB.prepare(
    `UPDATE media_assets SET
       filename = ?, original_filename = ?, mime_type = ?, size_bytes = ?, width = ?, height = ?,
       content_hash = ?, storage_key = ?, public_url = ?, thumbnail_storage_key = ?, thumbnail_public_url = ?,
       media_type = ?, updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      filename,
      safeOriginalName,
      spec.mimeType,
      params.fileBytes.byteLength,
      dimensions?.width ?? null,
      dimensions?.height ?? null,
      contentHash,
      storageKey,
      publicUrl,
      thumbnailStorageKey,
      thumbnailPublicUrl,
      spec.kind,
      id
    )
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'media.replaced',
    entityType: 'media_asset',
    entityId: id,
    metadata: { filename: safeOriginalName },
  });

  const record = await getMediaById(env, id);
  return { ok: true, media: record! };
}

export type SoftDeleteResult = { ok: true } | { ok: false; reason: 'not_found' | 'already_deleted' };

export async function softDeleteMedia(env: Env, logger: Logger, id: number, actorId: number): Promise<SoftDeleteResult> {
  const existing = await getMediaById(env, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.deletedAt) return { ok: false, reason: 'already_deleted' };

  await env.DB.prepare(`UPDATE media_assets SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(id).run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'media.deleted',
    entityType: 'media_asset',
    entityId: id,
    metadata: { filename: existing.originalFilename },
  });

  return { ok: true };
}

export type RestoreResult = { ok: true; media: MediaRecord } | { ok: false; reason: 'not_found' | 'not_deleted' };

export async function restoreMedia(env: Env, logger: Logger, id: number, actorId: number): Promise<RestoreResult> {
  const row = await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM media_assets WHERE id = ?`).bind(id).first<MediaRow>();
  if (!row) return { ok: false, reason: 'not_found' };
  if (!row.deleted_at) return { ok: false, reason: 'not_deleted' };

  await env.DB.prepare(`UPDATE media_assets SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?`).bind(id).run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'media.restored',
    entityType: 'media_asset',
    entityId: id,
    metadata: { filename: row.original_filename },
  });

  const restored = await getMediaById(env, id);
  return { ok: true, media: restored! };
}
