/**
 * R2 storage key generation — Version 2.0 Phase 1 (Media Library). Pure
 * computation, no R2/D1 dependency, matching backend/utils/README.md's
 * "utilities vs. services" distinction.
 *
 * Every key is built server-side from validated inputs only — a
 * `MediaFolder` enum value (see mediaValidation.ts's `ALLOWED_FOLDERS`)
 * and `crypto.randomUUID()` (a native Workers API) — never from the
 * client-supplied filename. This makes path traversal structurally
 * impossible (there is no code path where user input reaches the key
 * string) and makes filename collisions structurally impossible (a
 * UUID collision is a cryptographic non-event, not something this
 * code needs to detect or retry for).
 */

import type { MediaKind } from './mediaValidation';

/**
 * Deliberately under a `media/` prefix, distinct from the existing
 * `ebooks/`/`covers/`/etc. prefixes storage/README.md plans for the
 * separate, pre-existing paid-download system — see
 * database/migrations/0007_media_library.sql's header comment.
 */
export function buildStorageKey(kind: MediaKind, folder: string, extension: string): string {
  const typeSegment = kind === 'image' ? 'images' : 'documents';
  const uuid = crypto.randomUUID();
  return `media/${typeSegment}/${folder}/${uuid}.${extension}`;
}

/** The thumbnail's key mirrors the original's, in the same folder, so the two are always trivially findable as a pair — never guessed from the original's key by string manipulation elsewhere, always carried explicitly on the media_assets row. */
export function buildThumbnailStorageKey(folder: string): string {
  const uuid = crypto.randomUUID();
  return `media/images/${folder}/thumb-${uuid}.webp`;
}

/**
 * The public URL a storage key resolves to — the one place this
 * mapping is defined, so mediaService.ts and the public file-serving
 * route (routes/media.ts) can never drift apart on it. The key is used
 * as-is (not URI-encoded) — every character in a server-generated key
 * (`media/images/books/<uuid>.jpg`) is already URL-safe, and encoding
 * the slashes would turn a natural path into an ugly, harder-to-cache
 * query-like string for no benefit.
 */
export function publicUrlForKey(storageKey: string): string {
  return `/api/media/file/${storageKey}`;
}
