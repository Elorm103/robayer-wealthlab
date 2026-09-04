/**
 * EPUB Chapter Service - Controlled Library Reader, Phase 2.
 *
 * Extracts exactly ONE chapter out of the master EPUB (a real ZIP
 * archive) into its own watermarked, CSP-hardened HTML document -
 * never the whole archive. Unzip/rezip via `fflate` (pure JS, zero
 * native/WASM dependencies), proven to run cleanly in this project's
 * real workerd runtime.
 *
 * Scope note, disclosed deliberately rather than silently: this parses
 * container.xml + the OPF manifest/spine with small, targeted regexes
 * (this codebase's own established pattern for known-shape markup -
 * see library-reader.js's injectReaderCsp()), not a general XML
 * parser. Chapter navigation is built from the OPF spine's own reading
 * order (a real, correct next/prev sequence), labeled by each item's
 * manifest id where no richer title is available - this is NOT full
 * feature parity with epub.js's own nav.toc parsing (EPUB3 nav
 * documents / NCX navLabels are not parsed in this phase), a
 * conscious, disclosed scope reduction for the controlled reader path
 * only. The existing, unmodified epub.js-based reader (used whenever
 * controlled_reader_enabled is off, or for a book/product not yet
 * using this path) is completely unaffected and keeps its full TOC
 * fidelity.
 *
 * Phase 4 (production readiness) fix — inlineChapterResources() below.
 * Confirmed by direct inspection of the real production EPUB (see
 * docs/v6.1-phase3-pilot-and-ai-audit.html): every chapter links its
 * ONE real stylesheet (EPUB/style/main.css) via
 * `<link rel="stylesheet">`, which this endpoint was serving only the
 * bare chapter HTML for — the link 404'd client-side (no route ever
 * served it), so the chapter rendered entirely unstyled. The fix
 * inlines the chapter's own actually-referenced CSS (and, for
 * generality beyond this specific book, any `<img>`/`@font-face`
 * dependency that CSS or the chapter markup references) directly into
 * the single HTML document this endpoint already returns — NOT a new
 * route: every resource this pulls in is looked up from the SAME
 * in-memory `entries` this function already unzipped for the one
 * requested chapter, so nothing beyond what that one chapter's own real
 * dependency graph references is ever read from the archive, and
 * nothing is ever exposed at a URL of its own. This is exactly what the
 * EPUB reader's own CSP (EPUB_READER_CSP below) already anticipated —
 * `img-src ... data:` and `font-src ... data:` were already present
 * before this phase, the natural policy for inlined data: URIs, not a
 * new relaxation added to accommodate this fix.
 */

import { unzipSync, strToU8, strFromU8 } from 'fflate';

const EPUB_READER_CSP =
  "default-src 'none'; img-src 'self' data: blob:; style-src 'self' blob: 'unsafe-inline'; " +
  "font-src 'self' data: blob:; media-src 'self' data: blob:; script-src 'none'; " +
  "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";

export interface EpubSpineItem {
  /** The manifest href, relative to the OPF's own directory - this IS the `chapterRef` the client uses in GET /api/reader/:token/chapter/:chapterReference. */
  href: string;
  /** Manifest item id - used as a fallback human-readable label; see this file's own header comment on why richer nav.toc/NCX titles aren't extracted in this phase. */
  id: string;
}

export type EpubManifestDenialReason = 'invalid_archive' | 'container_not_found' | 'opf_not_found' | 'no_spine';

export type GetEpubManifestResult = { ok: true; spine: EpubSpineItem[] } | { ok: false; reason: EpubManifestDenialReason };

/** Resolves a relative path against a base directory the same way a browser would resolve a relative URL - `../` segments included - since OPF hrefs are always relative to the OPF file's own directory, which itself can be nested (e.g. `OEBPS/content.opf`). */
function resolveRelativePath(baseDir: string, relativePath: string): string {
  const stripped = relativePath.split('#')[0]; // fragment identifiers (chapter.xhtml#section2) never affect which zip entry holds the content
  if (!baseDir) return stripped;
  const parts = [...baseDir.split('/'), ...stripped.split('/')];
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return resolved.join('/');
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

const MIME_BY_EXTENSION: Record<string, string> = {
  css: 'text/css',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

function inferMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

/** Web-standard `btoa()` operates on a JS string of code units, not raw bytes, and chokes on/mangles anything above 0x7F unless fed one code unit per byte — chunked to avoid `String.fromCharCode(...bytes)`'s call-stack blowup on a real image-sized Uint8Array. */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

function toDataUri(bytes: Uint8Array, path: string): string {
  return `data:${inferMimeType(path)};base64,${bytesToBase64(bytes)}`;
}

/**
 * Replaces every `url(...)` reference inside a chapter's own CSS
 * (fonts, background images — an `@font-face src` or a `background:`
 * declaration) with an inlined data: URI, when that path resolves to a
 * real entry in THIS chapter's already-unzipped archive. A reference
 * that doesn't resolve (already a data:/http(s): URL, or a path this
 * archive genuinely doesn't contain) is left exactly as-is — a book
 * with no such dependency (confirmed true of the real production book's
 * own style/main.css, which uses only web-safe font names and zero
 * url() references) is completely unaffected by this function; it
 * exists for the books that DO reference one, not as a no-op.
 */
function inlineCssUrls(cssText: string, cssDir: string, entries: Record<string, Uint8Array>): string {
  return cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, _quote: string, ref: string) => {
    if (/^(data:|https?:|\/\/)/i.test(ref)) return match; // already inline or external — never fetched, never rewritten
    const resolved = resolveRelativePath(cssDir, ref);
    const bytes = entries[resolved];
    if (!bytes) return match; // genuinely missing from this archive — left as a dead reference rather than fabricated, matching this file's "skipped, not fabricated" convention elsewhere
    return `url("${toDataUri(bytes, resolved)}")`;
  });
}

/**
 * Inlines exactly the resources THIS chapter's own HTML/CSS actually
 * reference — never anything else in the archive. `<link
 * rel="stylesheet">` is replaced with an inline `<style>` block (its own
 * url() references resolved the same way, via inlineCssUrls above);
 * `<img src="...">` gets its src rewritten to a data: URI. Any
 * reference that doesn't resolve to a real archive entry degrades
 * gracefully — a missing stylesheet's `<link>` tag is simply dropped
 * (never left pointing at a route that would 404) and a missing image's
 * `src` is left as-is (a broken-image icon, not a crash) — this must
 * never throw regardless of how a chapter's markup is shaped.
 */
function inlineChapterResources(html: string, entries: Record<string, Uint8Array>, chapterDir: string): string {
  let out = html.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
    const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch) return '';
    const resolved = resolveRelativePath(chapterDir, hrefMatch[1]);
    const cssBytes = entries[resolved];
    if (!cssBytes) return ''; // never leave a <link> pointing at a resource this endpoint doesn't serve
    const cssText = inlineCssUrls(strFromU8(cssBytes), dirname(resolved), entries);
    return `<style>${cssText}</style>`;
  });

  out = out.replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (match, prefix: string, src: string, suffix: string) => {
    if (/^(data:|https?:|\/\/)/i.test(src)) return match;
    const resolved = resolveRelativePath(chapterDir, src);
    const bytes = entries[resolved];
    if (!bytes) return match; // left as-is — a broken image icon, never a crash, never a route the client could probe for other archive contents
    return `${prefix}${toDataUri(bytes, resolved)}${suffix}`;
  });

  return out;
}

export async function getEpubManifest(masterBytes: ArrayBuffer): Promise<GetEpubManifestResult> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(masterBytes));
  } catch {
    return { ok: false, reason: 'invalid_archive' };
  }

  const containerXml = entries['META-INF/container.xml'];
  if (!containerXml) return { ok: false, reason: 'container_not_found' };
  const containerMatch = strFromU8(containerXml).match(/full-path=["']([^"']+)["']/i);
  const opfPath = containerMatch?.[1];
  if (!opfPath || !entries[opfPath]) return { ok: false, reason: 'opf_not_found' };

  const opfXml = strFromU8(entries[opfPath]);
  const opfDir = dirname(opfPath);

  // Manifest: id -> href, from every <item id="..." href="..." .../> tag.
  const manifest = new Map<string, string>();
  const itemPattern = /<item\b[^>]*\/?>/gi;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemPattern.exec(opfXml)) !== null) {
    const tag = itemMatch[0];
    const id = tag.match(/\bid=["']([^"']+)["']/i)?.[1];
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (id && href) manifest.set(id, href);
  }

  // Spine: the real, authoritative reading order, from every
  // <itemref idref="..." .../> tag inside <spine>...</spine>.
  const spineBlockMatch = opfXml.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
  if (!spineBlockMatch) return { ok: false, reason: 'no_spine' };
  const spine: EpubSpineItem[] = [];
  const itemrefPattern = /<itemref\b[^>]*\/?>/gi;
  let refMatch: RegExpExecArray | null;
  while ((refMatch = itemrefPattern.exec(spineBlockMatch[1])) !== null) {
    const idref = refMatch[0].match(/\bidref=["']([^"']+)["']/i)?.[1];
    const href = idref ? manifest.get(idref) : undefined;
    if (idref && href) spine.push({ id: idref, href: resolveRelativePath(opfDir, href) });
  }
  if (spine.length === 0) return { ok: false, reason: 'no_spine' };

  return { ok: true, spine };
}

export interface EpubWatermarkInput {
  customerEmail: string;
  watermarkId: string;
  timestamp: string;
}

export type RenderEpubChapterDenialReason = EpubManifestDenialReason | 'chapter_not_found';
export type RenderEpubChapterResult = { ok: true; html: string; spine: EpubSpineItem[] } | { ok: false; reason: RenderEpubChapterDenialReason };

/**
 * `chapterRef` must be exactly one of the hrefs getEpubManifest()
 * returned for this same book - never a raw client-supplied path
 * trusted directly against the zip: it's matched against the real
 * spine list resolved fresh from the master archive on every call, so
 * a request for a path that isn't a real chapter in this book's own
 * manifest is rejected before any zip entry is ever read.
 */
export async function renderProtectedEpubChapter(masterBytes: ArrayBuffer, chapterRef: string, watermark: EpubWatermarkInput): Promise<RenderEpubChapterResult> {
  const manifestResult = await getEpubManifest(masterBytes);
  if (!manifestResult.ok) return manifestResult;

  const spineItem = manifestResult.spine.find((item) => item.href === chapterRef);
  if (!spineItem) return { ok: false, reason: 'chapter_not_found' };

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(masterBytes));
  } catch {
    return { ok: false, reason: 'invalid_archive' };
  }
  const chapterBytes = entries[spineItem.href];
  if (!chapterBytes) return { ok: false, reason: 'chapter_not_found' };

  let html = strFromU8(chapterBytes);
  html = inlineChapterResources(html, entries, dirname(spineItem.href));
  html = injectReaderCsp(html);
  html = injectWatermark(html, watermark);

  return { ok: true, html, spine: manifestResult.spine };
}

/** Server-side mirror of library-reader.js's own injectReaderCsp(): strips any author-supplied CSP and inserts this reader's own, script-src 'none' always included - the exact same policy string, so a book delivered through the controlled path is no less hardened against hostile EPUB content than the existing reader already is. */
function injectReaderCsp(html: string): string {
  let out = html.replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, '');
  const cspTag = `<meta http-equiv="Content-Security-Policy" content="${EPUB_READER_CSP}">`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, (_match, attrs: string) => `<head${attrs}>${cspTag}`);
  } else {
    out = out.replace(/<html[^>]*>/i, (match) => `${match}<head>${cspTag}</head>`);
  }
  return out;
}

/** Appended just before </body> as its own inline-styled element - deliberately not relying on any external stylesheet, so the watermark renders identically regardless of the reader's own light/dark theme or the book's own CSS. Visible and legible on inspection, low-opacity so it doesn't disrupt reading - the same deterrence/traceability posture as the PDF watermark, and the same explicit acknowledgement that it can be edited out of a saved copy of this HTML by a sufficiently motivated actor. */
function injectWatermark(html: string, watermark: EpubWatermarkInput): string {
  const escaped = escapeHtml(`Robayer WealthLab · ${watermark.customerEmail} · ${watermark.watermarkId} · ${watermark.timestamp}`);
  const watermarkTag = `<div style="margin-top:2em;padding-top:0.5em;border-top:1px solid rgba(128,128,128,0.3);font-size:0.65em;color:rgba(128,128,128,0.75);font-family:sans-serif;">${escaped}</div>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${watermarkTag}</body>`);
  }
  return `${html}${watermarkTag}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
