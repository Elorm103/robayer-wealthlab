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

/**
 * Content-fidelity regression suite - Controlled Library Reader,
 * Phase 3 pilot audit. Every prior test proves the response is a
 * strict SUBSET of the archive (smaller, one chapter only) - none of
 * them prove the chapter's OWN content survives completely intact.
 * This fixture deliberately mirrors the shape of a real production
 * EPUB (11 paragraphs, a linked external stylesheet, front matter
 * before the numbered chapters) - the exact structure empirically
 * verified against a real, live production book during this audit
 * (11 paragraphs in, 11 paragraphs out, full original text confirmed
 * as a literal substring of the extracted output, for 3 separate
 * chapters) - so this synthetic version is a permanent, committable
 * regression test for that same property, without embedding real
 * book text in the test suite.
 */
function buildRealisticChapterHtml(chapterNumber: number, paragraphCount: number): string {
  const paragraphs = Array.from(
    { length: paragraphCount },
    (_, i) => `<p>Paragraph ${i + 1} of chapter ${chapterNumber}. This is real, substantial prose content - not a placeholder - covering a distinct point the chapter makes, long enough to resemble genuine reading material rather than a one-line test fixture.</p>`
  ).join('\n    ');
  return (
    `<?xml version='1.0' encoding='utf-8'?>\n` +
    `<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" lang="en">\n` +
    `  <head>\n` +
    `    <link href="style/main.css" rel="stylesheet" type="text/css"/>\n` +
    `    <title>Chapter ${chapterNumber}: A Realistic Title</title>\n` +
    `  </head>\n` +
    `  <body>\n` +
    `    <h1>Chapter ${chapterNumber}</h1>\n` +
    `    ${paragraphs}\n` +
    `  </body>\n` +
    `</html>`
  );
}

function buildRealisticTestEpub(chapterCount: number, paragraphsPerChapter: number): ArrayBuffer {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    ),
    'EPUB/style/main.css': strToU8('body { font-family: Georgia, serif; line-height: 1.6; } h1 { color: #1B2430; }'),
  };
  const manifestItems: string[] = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>', '<item id="title_page" href="title_page.xhtml" media-type="application/xhtml+xml"/>'];
  const spineItems: string[] = ['<itemref idref="nav"/>', '<itemref idref="title_page"/>'];
  files['EPUB/nav.xhtml'] = strToU8('<html><body><nav epub:type="toc"><ol><li>Front matter</li></ol></nav></body></html>');
  files['EPUB/title_page.xhtml'] = strToU8('<html><body><h1>A Realistic Book Title</h1></body></html>');

  for (let i = 1; i <= chapterCount; i++) {
    manifestItems.push(`<item id="chapter_${i}" href="chapter_${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="chapter_${i}"/>`);
    files[`EPUB/chapter_${i}.xhtml`] = strToU8(buildRealisticChapterHtml(i, paragraphsPerChapter));
  }
  files['EPUB/content.opf'] = strToU8(`<?xml version="1.0"?><package><manifest>${manifestItems.join('')}</manifest><spine>${spineItems.join('')}</spine></package>`);

  const zipped = zipSync(files);
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);
}

describe('Content fidelity - the extracted chapter must lose nothing from the original', () => {
  it('preserves every paragraph, in full, for the first, a middle, and the final chapter - matching the exact shape (11 paragraphs, linked stylesheet) empirically verified against a real production book', async () => {
    const chapterCount = 14;
    const paragraphsPerChapter = 11;
    const epub = buildRealisticTestEpub(chapterCount, paragraphsPerChapter);

    for (const chapterNumber of [1, 7, 14]) {
      const originalHtml = buildRealisticChapterHtml(chapterNumber, paragraphsPerChapter);
      const originalBody = originalHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)![1];
      const originalParagraphCount = (originalBody.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || []).length;
      const originalText = originalBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      const result = await renderProtectedEpubChapter(epub, `EPUB/chapter_${chapterNumber}.xhtml`, {
        customerEmail: 'fidelity-check@example.com',
        watermarkId: 'RWL-FIDELITY',
        timestamp: '2026-01-01T00:00:00.000Z',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const extractedBody = result.html.match(/<body[^>]*>([\s\S]*)<\/body>/i)![1];
      const extractedParagraphCount = (extractedBody.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || []).length;
      const extractedText = extractedBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      // The one and only permitted difference is the appended
      // watermark div - paragraph count and the complete original
      // text (as a literal substring) must both survive exactly.
      expect(extractedParagraphCount).toBe(originalParagraphCount);
      expect(extractedText).toContain(originalText);
    }
  });

  it('Phase 4 fix: the chapter\'s own linked stylesheet is inlined as a real <style> block, never left as a dead, unservable <link> - preserves the book\'s intended typography without a new download route', async () => {
    const epub = buildRealisticTestEpub(3, 5);
    const result = await renderProtectedEpubChapter(epub, 'EPUB/chapter_1.xhtml', { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: 'now' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The dead <link> is gone (nothing in this response could ever make
    // it resolve in a browser - the CSP's own connect-src/style-src
    // don't permit a same-origin CSS request from inside a srcdoc
    // iframe anyway) and the book's REAL, actual CSS content now
    // arrives inline - checked against the book's own specific
    // declaration, not just any "font-family" substring, since the
    // watermark div this same response adds also sets an inline
    // font-family for itself.
    expect(result.html).not.toMatch(/<link\b[^>]*rel=["']stylesheet["']/i);
    expect(result.html).toContain('<style>');
    expect(result.html).toContain('Georgia, serif');
    expect(result.html).toContain('color: #1B2430');
  });

  it('inlines a chapter image as a data: URI, byte-for-byte, without exposing a new endpoint for it', async () => {
    const pixelPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]); // not a real decodable PNG - only its bytes round-tripping through base64 is under test here
    const files: Record<string, Uint8Array> = {
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/content.opf"/></rootfiles></container>'),
      'EPUB/content.opf': strToU8(
        '<?xml version="1.0"?><package><manifest><item id="ch1" href="chapter1.xhtml"/><item id="img1" href="images/diagram.png"/></manifest><spine><itemref idref="ch1"/></spine></package>'
      ),
      'EPUB/chapter1.xhtml': strToU8('<html><body><p>A chapter with a real diagram:</p><img src="images/diagram.png" alt="Diagram"/></body></html>'),
      'EPUB/images/diagram.png': pixelPng,
    };
    const zipped = zipSync(files);
    const epub = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);

    const result = await renderProtectedEpubChapter(epub, 'EPUB/chapter1.xhtml', { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: 'now' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toContain('src="images/diagram.png"');
    const dataUriMatch = result.html.match(/src="(data:image\/png;base64,[^"]+)"/);
    expect(dataUriMatch).not.toBeNull();
    const base64Payload = dataUriMatch![1].split(',')[1];
    const decoded = Uint8Array.from(atob(base64Payload), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(pixelPng));
  });

  it('inlines a @font-face url() reference inside the chapter\'s own CSS as a data: URI', async () => {
    const fontBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const files: Record<string, Uint8Array> = {
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/content.opf"/></rootfiles></container>'),
      'EPUB/content.opf': strToU8(
        '<?xml version="1.0"?><package><manifest><item id="ch1" href="chapter1.xhtml"/><item id="css1" href="style/main.css"/><item id="font1" href="fonts/body.woff2"/></manifest><spine><itemref idref="ch1"/></spine></package>'
      ),
      'EPUB/chapter1.xhtml': strToU8('<html><head><link href="style/main.css" rel="stylesheet"/></head><body><p>Custom-font chapter.</p></body></html>'),
      'EPUB/style/main.css': strToU8('@font-face { font-family: "BookFont"; src: url("../fonts/body.woff2") format("woff2"); }'),
      'EPUB/fonts/body.woff2': fontBytes,
    };
    const zipped = zipSync(files);
    const epub = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);

    const result = await renderProtectedEpubChapter(epub, 'EPUB/chapter1.xhtml', { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: 'now' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('data:font/woff2;base64,');
    expect(result.html).not.toContain('../fonts/body.woff2');
  });

  it('degrades gracefully - never throws - when a linked stylesheet or image genuinely does not exist in the archive', async () => {
    const files: Record<string, Uint8Array> = {
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/content.opf"/></rootfiles></container>'),
      'EPUB/content.opf': strToU8('<?xml version="1.0"?><package><manifest><item id="ch1" href="chapter1.xhtml"/></manifest><spine><itemref idref="ch1"/></spine></package>'),
      'EPUB/chapter1.xhtml': strToU8(
        '<html><head><link href="style/missing.css" rel="stylesheet"/></head><body><img src="images/missing.png" alt="gone"/><p>Text survives regardless.</p></body></html>'
      ),
    };
    const zipped = zipSync(files);
    const epub = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);

    const result = await renderProtectedEpubChapter(epub, 'EPUB/chapter1.xhtml', { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: 'now' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('Text survives regardless.');
    expect(result.html).not.toMatch(/<link\b[^>]*rel=["']stylesheet["']/i); // dropped, never left dangling at a route that would 404
    expect(result.html).toContain('src="images/missing.png"'); // left as-is - a broken-image icon, not a crash
  });

  it('never exposes the complete EPUB archive - the response never contains the ZIP local/central-directory signatures or another chapter\'s own text', async () => {
    const epub = buildRealisticTestEpub(4, 6);
    const result = await renderProtectedEpubChapter(epub, 'EPUB/chapter_2.xhtml', { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: 'now' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toContain('PK\x03\x04'); // the ZIP local file header signature - would only appear if raw archive bytes leaked through
    for (const other of [1, 3, 4]) {
      expect(result.html).not.toContain(`Paragraph 1 of chapter ${other}.`);
    }
  });
});
