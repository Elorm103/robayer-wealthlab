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
