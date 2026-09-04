/**
 * Unit tests: epubChapterService.ts - Controlled Library Reader, Phase 5.
 * Proves the chapter endpoint's core security property: the returned
 * HTML is a strict subset of the archive (one chapter only, never the
 * whole ZIP), the CSP is preserved, and the watermark is genuinely
 * present.
 */
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { getEpubManifest, renderProtectedEpubChapter } from '../../services/epubChapterService';

function buildTestEpub(chapterCount: number): ArrayBuffer {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
  };
  const manifestItems: string[] = [];
  const spineItems: string[] = [];
  for (let i = 1; i <= chapterCount; i++) {
    manifestItems.push(`<item id="ch${i}" href="chapter${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="ch${i}"/>`);
    files[`OEBPS/chapter${i}.xhtml`] = strToU8(
      `<html><head><title>Chapter ${i}</title></head><body><h1>Chapter ${i}</h1><p>Real, distinct content for chapter ${i}, not shared with any other chapter.</p></body></html>`
    );
  }
  files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0"?><package><manifest>${manifestItems.join('')}</manifest><spine>${spineItems.join('')}</spine></package>`);

  const zipped = zipSync(files);
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);
}

describe('getEpubManifest()', () => {
  it('resolves the real spine order with correct hrefs from a genuine EPUB archive', async () => {
    const epub = buildTestEpub(4);
    const result = await getEpubManifest(epub);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spine.map((s) => s.href)).toEqual(['OEBPS/chapter1.xhtml', 'OEBPS/chapter2.xhtml', 'OEBPS/chapter3.xhtml', 'OEBPS/chapter4.xhtml']);
  });

  it('reports invalid_archive for genuinely corrupt zip bytes, never throwing', async () => {
    const result = await getEpubManifest(new TextEncoder().encode('not a zip').buffer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_archive');
  });

  it('reports container_not_found when META-INF/container.xml is missing', async () => {
    const zipped = zipSync({ 'OEBPS/content.opf': strToU8('<package/>') });
    const bytes = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);
    const result = await getEpubManifest(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('container_not_found');
  });
});

describe('renderProtectedEpubChapter() - the core security property', () => {
  it('returns HTML that is genuinely SMALLER than the complete archive - proof this is a real single-chapter extraction, not the whole book relabeled', async () => {
    const epub = buildTestEpub(10);
    const result = await renderProtectedEpubChapter(epub, 'OEBPS/chapter5.xhtml', { customerEmail: 'reader@example.com', watermarkId: 'RWL-TEST0003', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new TextEncoder().encode(result.html).byteLength).toBeLessThan(epub.byteLength);
  });

  it('the returned HTML contains ONLY the requested chapter\'s content, never any other chapter\'s text', async () => {
    const epub = buildTestEpub(5);
    const result = await renderProtectedEpubChapter(epub, 'OEBPS/chapter3.xhtml', { customerEmail: 'reader@example.com', watermarkId: 'RWL-TEST0004', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('Real, distinct content for chapter 3');
    for (const other of [1, 2, 4, 5]) {
      expect(result.html).not.toContain(`Real, distinct content for chapter ${other}`);
    }
  });

  it('preserves the exact strict EPUB CSP, including script-src \'none\' - never weakened for the controlled path', async () => {
    const epub = buildTestEpub(2);
    const result = await renderProtectedEpubChapter(epub, 'OEBPS/chapter1.xhtml', { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: 'now' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toMatch(/http-equiv=["']Content-Security-Policy["']/i);
    expect(result.html).toContain("script-src 'none'");
    expect(result.html).toContain("object-src 'none'");
    expect(result.html).toContain("frame-src 'none'");
  });

  it('an author-supplied CSP meta tag inside the chapter is stripped, never trusted, before this reader\'s own is inserted', async () => {
    const files: Record<string, Uint8Array> = {
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
      'OEBPS/content.opf': strToU8('<?xml version="1.0"?><package><manifest><item id="ch1" href="chapter1.xhtml"/></manifest><spine><itemref idref="ch1"/></spine></package>'),
      'OEBPS/chapter1.xhtml': strToU8(
        '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'unsafe-inline\'"></head><body><p>Hostile chapter content.</p></body></html>'
      ),
    };
    const zipped = zipSync(files);
    const epub = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);

    const result = await renderProtectedEpubChapter(epub, 'OEBPS/chapter1.xhtml', { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: 'now' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The hostile author-supplied meta tag tried to relax script-src to
    // 'unsafe-inline' - it must be gone, replaced by this reader's own
    // fixed CSP, which keeps script-src 'none' unconditionally. (The
    // reader's own CSP legitimately allows style-src 'unsafe-inline'
    // for chapter styling; only script-src is the security boundary
    // here, so this deliberately checks the specific hostile directive
    // rather than the substring everywhere.)
    expect(result.html).not.toContain("script-src 'unsafe-inline'");
    expect(result.html).toContain("script-src 'none'");
  });

  it('the watermark (customer email, watermark id) is genuinely present in the returned HTML', async () => {
    const epub = buildTestEpub(2);
    const result = await renderProtectedEpubChapter(epub, 'OEBPS/chapter2.xhtml', {
      customerEmail: 'traceable-owner@example.com',
      watermarkId: 'RWL-DEADBEEF',
      timestamp: '2026-06-15T10:30:00.000Z',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('traceable-owner@example.com');
    expect(result.html).toContain('RWL-DEADBEEF');
    expect(result.html).toContain('Robayer WealthLab');
  });

  it('rejects a chapterRef that is not a real entry in this book\'s own spine - never falls back to reading an arbitrary zip path', async () => {
    const epub = buildTestEpub(3);
    const result = await renderProtectedEpubChapter(epub, 'OEBPS/chapter99.xhtml', { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: 'now' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('chapter_not_found');
  });

  it('rejects a path-traversal-shaped chapterRef (e.g. targeting META-INF/container.xml or an out-of-book path) - never matches anything outside the real spine', async () => {
    const epub = buildTestEpub(2);
    const traversal = await renderProtectedEpubChapter(epub, '../../../etc/passwd', { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: 'now' });
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.reason).toBe('chapter_not_found');

    const containerAttempt = await renderProtectedEpubChapter(epub, 'META-INF/container.xml', { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: 'now' });
    expect(containerAttempt.ok).toBe(false);
    if (!containerAttempt.ok) expect(containerAttempt.reason).toBe('chapter_not_found');
  });
});
