/**
 * GET /api/media/file/:key — Version 2.0 Phase 1 (Media Library). The
 * public-facing counterpart to routes/admin/media.ts: serves a
 * published, non-deleted media asset's real bytes from R2, with no
 * authentication — these are meant to become embeddable/linkable
 * public site assets (book covers, blog images, branding), exactly
 * the same trust model `assets/covers/*.png` already has today as
 * plain static files. See docs/v2-media-library-spec.md's "Serving
 * uploaded media."
 *
 * Deliberately distinct from GET /api/download/:token
 * (routes/downloads.ts) — that route gates access to *paid* product
 * files behind purchase verification; this one has no such gate
 * because Media Library assets were never paid content, they're CMS
 * media. A soft-deleted or nonexistent key gets the same generic 404,
 * matching this codebase's "identical outcome regardless of why" habit
 * for public lookup endpoints.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import type { RouteParams } from '../worker/index';
import { jsonError } from '../utils/responses';
import { getMediaByStorageKey } from '../services/mediaService';

export async function handleMediaFile(_request: Request, env: Env, _logger: Logger, params: RouteParams): Promise<Response> {
  const storageKey = params.key;
  if (!storageKey) return jsonError('MEDIA_NOT_FOUND', 'This file could not be found.');

  const media = await getMediaByStorageKey(env, storageKey);
  let contentType: string;

  if (media) {
    contentType = media.mimeType;
  } else {
    // A thumbnail's own key isn't a row's primary `storage_key` (that's
    // the original's) — check it belongs to a real, non-deleted row's
    // `thumbnail_storage_key` before serving it.
    const thumbnailOwner = await env.DB.prepare(`SELECT id FROM media_assets WHERE thumbnail_storage_key = ? AND deleted_at IS NULL`)
      .bind(storageKey)
      .first<{ id: number }>();
    if (!thumbnailOwner) return jsonError('MEDIA_NOT_FOUND', 'This file could not be found.');
    contentType = 'image/webp';
  }

  const object = await env.STORAGE.get(storageKey);
  if (!object) return jsonError('MEDIA_NOT_FOUND', 'This file could not be found.');
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      // Public, cacheable, immutable — every real key is a fresh UUID
      // per upload (see utils/mediaKey.ts), so the same URL never
      // points at different bytes; a long cache lifetime is safe here
      // in a way it explicitly is NOT for routes/downloads.ts's
      // per-purchase tokens.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
