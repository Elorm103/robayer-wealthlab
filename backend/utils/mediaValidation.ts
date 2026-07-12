/**
 * Media Library upload validation — Version 2.0 Phase 1. Pure
 * computations only (no D1/R2/network dependency), per
 * backend/utils/README.md's "utilities vs. services" distinction.
 *
 * Every check here runs server-side, against the real uploaded bytes —
 * never against a client-supplied `Content-Type` header or filename
 * alone. A file claiming to be a JPEG is only trusted as one once its
 * first bytes actually match the JPEG signature (see
 * docs/v2-media-library-spec.md's original design, which this
 * implements).
 */

export type MediaKind = 'image' | 'document';

export interface MediaTypeSpec {
  kind: MediaKind;
  mimeType: string;
  extension: string;
  maxSizeBytes: number;
  /** First bytes to check against the real file — undefined means "text-based, no fixed magic number" (SVG). */
  signature?: number[];
}

/** 5MB — generous for any real image this site uses; the largest existing cover art is well under 1MB. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 25MB — the one real PDF in R2 today (the eBook) is 465KB; this is headroom, not a loophole — matches docs/v2-media-library-spec.md's original sizing. */
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * The complete allowlist — nothing outside this list is ever accepted,
 * regardless of what a client claims. `audio`/`video` are deliberately
 * absent (disabled per this phase's "future-ready architecture"
 * requirement) — adding them later means adding entries here and to
 * `ALLOWED_FOLDERS`'s consuming UI, not restructuring anything.
 */
export const SUPPORTED_TYPES: readonly MediaTypeSpec[] = [
  { kind: 'image', mimeType: 'image/jpeg', extension: 'jpg', maxSizeBytes: MAX_IMAGE_BYTES, signature: [0xff, 0xd8, 0xff] },
  { kind: 'image', mimeType: 'image/png', extension: 'png', maxSizeBytes: MAX_IMAGE_BYTES, signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { kind: 'image', mimeType: 'image/webp', extension: 'webp', maxSizeBytes: MAX_IMAGE_BYTES }, // signature checked separately — RIFF....WEBP, not one contiguous run
  { kind: 'image', mimeType: 'image/svg+xml', extension: 'svg', maxSizeBytes: MAX_IMAGE_BYTES }, // text-based; validated by content sniff below, not a byte signature
  { kind: 'document', mimeType: 'application/pdf', extension: 'pdf', maxSizeBytes: MAX_DOCUMENT_BYTES, signature: [0x25, 0x50, 0x44, 0x46] }, // "%PDF"
];

export const ALLOWED_FOLDERS = ['books', 'blog', 'resources', 'branding', 'uncategorized'] as const;
export type MediaFolder = (typeof ALLOWED_FOLDERS)[number];

export function isAllowedFolder(value: unknown): value is MediaFolder {
  return typeof value === 'string' && (ALLOWED_FOLDERS as readonly string[]).includes(value);
}

export type DetectionResult = { ok: true; spec: MediaTypeSpec } | { ok: false; reason: string };

/**
 * The real security boundary: sniffs the actual file bytes against
 * every allowed signature and, for SVG, a lightweight text-content
 * check — never trusts `request.headers.get('Content-Type')` or the
 * uploaded filename's extension. A mismatch (e.g. a `.jpg`-named file
 * that isn't really a JPEG) is rejected here regardless of what the
 * client claimed.
 */
export function detectMediaType(bytes: Uint8Array): DetectionResult {
  for (const spec of SUPPORTED_TYPES) {
    if (spec.mimeType === 'image/webp') {
      if (matchesWebp(bytes)) return { ok: true, spec };
      continue;
    }
    if (spec.mimeType === 'image/svg+xml') {
      if (matchesSvg(bytes)) return { ok: true, spec };
      continue;
    }
    if (spec.signature && startsWith(bytes, spec.signature)) return { ok: true, spec };
  }
  return { ok: false, reason: 'Unsupported or unrecognized file type.' };
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

/** RIFF container, "WEBP" at byte offset 8 — WebP has no single contiguous magic number. */
function matchesWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  return riff === 'RIFF' && webp === 'WEBP';
}

/**
 * SVG is XML text, not binary — no fixed magic number exists. A real
 * `<svg` root element (allowing for a leading BOM/XML declaration/
 * comments, which real SVG authoring tools commonly emit) within the
 * first 1KB is the practical signal used here. This is a content
 * sniff, not a full XML parse or schema validation — sufficient to
 * reject "this isn't actually SVG," not to guarantee the file is
 * well-formed (a malformed SVG simply fails to render, no different
 * from any other bad upload).
 */
function matchesSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.slice(0, 1024));
  return /<svg[\s>]/i.test(head);
}

/**
 * Strips everything that isn't a safe display character, so the
 * *stored, displayed* original filename can never itself be a vector
 * (it is never used to build the R2 key — see mediaService.ts's
 * buildStorageKey(), which only ever uses a server-generated UUID) but
 * still shouldn't render as garbage or carry control/path characters
 * into the admin UI or a future export.
 */
export function sanitizeOriginalFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? raw; // drop any path component a browser/client might send
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '') // control characters
    .replace(/[^\w.\- ]/g, '_') // keep word chars, dot, dash, space; everything else becomes _
    .trim();
  const safe = cleaned.length > 0 ? cleaned : 'file';
  return safe.length > 200 ? safe.slice(0, 200) : safe;
}

/**
 * Virus-scanning hook — genuinely not implemented, per this phase's
 * explicit "hook only" requirement. Always returns clean today; the
 * call site (mediaService.ts) awaits this exactly as it would a real
 * scan, so wiring in a real provider (e.g. an external AV API) later
 * is a change to this one function's body, not to any caller.
 */
export async function scanForThreats(_bytes: Uint8Array): Promise<{ clean: true }> {
  return { clean: true };
}

/** SHA-256 of the file bytes, hex-encoded — the real duplicate-detection key (never the filename, which two different real files can share). Uses Web Crypto (`crypto.subtle`), the same native API `passwordHash.ts` already relies on — no new dependency. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
