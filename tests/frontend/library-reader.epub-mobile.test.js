/**
 * Mobile EPUB reader regression tests — the mobile overflow fix's root
 * cause: `epubRendition.themes.fontSize()` changes the font but never
 * re-runs epub.js's own paginated-layout measurement, and EPUB mode had
 * no resize/orientation listener at all (unlike the PDF path). Confirmed
 * live against a real, isolated epub.js + real minimal EPUB fixture:
 * the rendered iframe stayed exactly within its 375px-wide mobile
 * container (iframeWidth === iframeContentScrollWidth, no internal
 * overflow) both at 100% and 150% font size, with the fix in place.
 *
 * library-reader.js's EPUB logic lives entirely inside closure-scoped
 * functions (setEpubFontSize, wireEpubControls) that aren't exposed for
 * direct unit testing, and extracting them purely for testability would
 * be a larger refactor than this fix calls for. These are therefore
 * structural/contract tests — they assert the actual fix (the specific
 * resize() call sequence) is present in the shipped source, which is
 * exactly what would silently regress if someone touched this code
 * later without knowing why it's there. The real, empirical "does it
 * actually not overflow" verification is the live fixture result above,
 * not these tests.
 *
 * Run: node --test tests/frontend/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../js/components/library-reader.js'), 'utf8');

function fnBody(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} must exist in library-reader.js`);
  let depth = 0;
  let i = SOURCE.indexOf('{', start);
  const bodyStart = i;
  for (; i < SOURCE.length; i++) {
    if (SOURCE[i] === '{') depth++;
    if (SOURCE[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return SOURCE.slice(bodyStart, i + 1);
}

test('setEpubFontSize() calls epubRendition.resize() after themes.fontSize() — the actual fix for "Font +/- zooms the whole page"', () => {
  const body = fnBody('setEpubFontSize');
  const fontSizeCallIndex = body.indexOf('themes.fontSize(');
  const resizeCallIndex = body.indexOf('epubRendition.resize()');
  assert.ok(fontSizeCallIndex !== -1, 'must still call themes.fontSize() to change the text size');
  assert.ok(resizeCallIndex !== -1, 'must call epubRendition.resize() — without it epub.js keeps a stale paginated-layout width after the font changes');
  assert.ok(resizeCallIndex > fontSizeCallIndex, 'resize() must happen AFTER fontSize(), so it re-measures against the new font, not the old one');
});

test('wireEpubControls() registers a window resize listener that calls epubRendition.resize() — EPUB mode previously had none at all (unlike the PDF path)', () => {
  const body = fnBody('wireEpubControls');
  assert.match(body, /window\.addEventListener\('resize',/, 'must listen for viewport/orientation changes, mirroring wireControls()\'s own PDF-path resize listener');
  const resizeListenerIndex = body.indexOf("window.addEventListener('resize',");
  const afterListener = body.slice(resizeListenerIndex);
  assert.match(afterListener, /epubRendition\.resize\(\)/, 'the resize listener must actually call epubRendition.resize(), not just exist');
});

test('openEpubReadSession() calls epubRendition.resize() once after the initial display settles — a safety net against a stale first-load measurement', () => {
  const body = fnBody('openEpubReadSession');
  const removeLoadingIndex = body.lastIndexOf('removeLoadingNotice()');
  const resizeIndex = body.indexOf('epubRendition.resize()', removeLoadingIndex);
  assert.ok(removeLoadingIndex !== -1, 'removeLoadingNotice() must still be called');
  assert.ok(resizeIndex !== -1 && resizeIndex > removeLoadingIndex, 'resize() must be called after the loading notice is removed and the reader is actually ready');
});

test('openEpubReadSession() injects a content-reflow theme via epub.js\'s own theming API before the EPUB is displayed — images/tables/text must not be able to force horizontal overflow regardless of how a book was authored', () => {
  const body = fnBody('openEpubReadSession');
  assert.match(body, /epubRendition\.themes\.default\(/, 'must use Rendition.themes.default() to inject reflow-safety CSS into every chapter');
  const themeCallIndex = body.indexOf('epubRendition.themes.default(');
  const displayCallIndex = body.indexOf('epubRendition.display(');
  assert.ok(themeCallIndex !== -1 && displayCallIndex !== -1 && themeCallIndex < displayCallIndex, 'the theme must be registered BEFORE display() ever runs, so even the first-shown chapter gets it');
});

test('the AI trigger button, panel title, panel aria-label, and composer label all say "Robayer AI", never the old "WealthLab AI"', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../dashboard/read/index.html'), 'utf8');
  assert.doesNotMatch(html, /WealthLab AI/, 'no user-facing "WealthLab AI" branding should remain in the reader page');
  assert.match(html, /Ask Robayer AI/);
  assert.match(html, /Robayer AI Reading Assistant/);
  assert.match(html, />\s*<span aria-hidden="true">&#10022;<\/span> Robayer AI<\/h2>/);
});
