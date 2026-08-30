/**
 * Mobile EPUB reader regression tests.
 *
 * Originally (mobile overflow fix): `epubRendition.themes.fontSize()`
 * changes the font but never re-runs epub.js's own paginated-layout
 * measurement, and EPUB mode had no resize/orientation listener at all
 * (unlike the PDF path). Confirmed live against a real, isolated
 * epub.js + real minimal EPUB fixture: the rendered iframe stayed
 * exactly within its 375px-wide mobile container (iframeWidth ===
 * iframeContentScrollWidth, no internal overflow) both at 100% and
 * 150% font size, with that fix in place.
 *
 * Blank-canvas fix (this phase) — that same manual `window.resize`
 * listener turned out to be the deeper problem: confirmed directly in
 * the vendored epub.js source that DefaultViewManager already installs
 * its OWN automatic, internally-debounced `window.resize` listener
 * whenever the rendition isn't given fixed numeric width/height (this
 * reader's own configuration). Keeping both meant two independent,
 * differently-timed resize-triggered clear()+relayout cycles could fire
 * off the same physical resize event and race each other — the actual
 * root cause of EPUB content intermittently disappearing. The tests
 * below now assert that listener is GONE, and that every epub.js-
 * mutating call this file makes (display/next/prev/resize) is routed
 * through queueEpubOperation()'s serialization queue instead, so none
 * of them can ever run concurrently with each other or with epub.js's
 * own remaining internal automatic resize handling.
 *
 * library-reader.js's EPUB logic lives entirely inside closure-scoped
 * functions (setEpubFontSize, wireEpubControls, queueEpubOperation)
 * that aren't exposed for direct unit testing, and extracting them
 * purely for testability would be a larger refactor than this fix
 * calls for. These are therefore structural/contract tests — they
 * assert the actual fix is present in the shipped source, which is
 * exactly what would silently regress if someone touched this code
 * later without knowing why it's there. The real, empirical
 * verification (does the real "Understanding the Ghana Stock Exchange"
 * EPUB actually stay visible through navigation/font-size/resize) is
 * the live QA in this phase's report, not these tests.
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

test('setEpubFontSize() calls queueEpubResize() after themes.fontSize() — the actual fix for "Font +/- zooms the whole page", now serialized', () => {
  const body = fnBody('setEpubFontSize');
  const fontSizeCallIndex = body.indexOf('themes.fontSize(');
  const resizeCallIndex = body.indexOf('queueEpubResize()');
  assert.ok(fontSizeCallIndex !== -1, 'must still call themes.fontSize() to change the text size');
  assert.ok(resizeCallIndex !== -1, 'must call queueEpubResize() — without it epub.js keeps a stale paginated-layout width after the font changes');
  assert.ok(resizeCallIndex > fontSizeCallIndex, 'resize must happen AFTER fontSize(), so it re-measures against the new font, not the old one');
});

test('wireEpubControls() does NOT register its own window resize listener — the blank-canvas root cause was TWO uncoordinated ones (this file\'s manual listener duplicating epub.js\'s own internal automatic one)', () => {
  const body = fnBody('wireEpubControls');
  assert.doesNotMatch(body, /window\.addEventListener\('resize',/, 'a manual window resize listener here would duplicate epub.js\'s own internal DefaultViewManager resize handling (confirmed in the vendored source) and race it — see this function\'s own comment for the full evidence');
});

test('wireEpubControls() routes prev()/next() (both the toolbar buttons and arrow-key navigation) through queueEpubOperation(), never called directly', () => {
  const body = fnBody('wireEpubControls');
  const wrappedPrev = 'queueEpubOperation(() => epubRendition.prev())';
  const wrappedNext = 'queueEpubOperation(() => epubRendition.next())';
  const prevCount = body.split('epubRendition.prev()').length - 1;
  const nextCount = body.split('epubRendition.next()').length - 1;
  const wrappedPrevCount = body.split(wrappedPrev).length - 1;
  const wrappedNextCount = body.split(wrappedNext).length - 1;
  assert.ok(prevCount >= 2, 'expects both the toolbar button and the ArrowLeft key handler to call prev()');
  assert.ok(nextCount >= 2, 'expects both the toolbar button and the ArrowRight key handler to call next()');
  assert.equal(prevCount, wrappedPrevCount, 'every epubRendition.prev() call must be wrapped in queueEpubOperation() — a bare one can race a concurrent display()/resize()');
  assert.equal(nextCount, wrappedNextCount, 'every epubRendition.next() call must be wrapped in queueEpubOperation() — a bare one can race a concurrent display()/resize()');
});

test('wireEpubControls() wires the render-error Retry button through queueEpubOperation(), targeting lastKnownGoodCfi', () => {
  const body = fnBody('wireEpubControls');
  assert.match(body, /epubRenderRetryBtn/, 'must reference the retry button');
  assert.match(body, /queueEpubOperation\(\(\) => epubRendition\.display\(lastKnownGoodCfi/, 'retry must re-attempt display() at the last known-good position, through the same serialization queue as everything else');
});

test('queueEpubOperation() serializes calls through one chained promise and surfaces a real render-error state on rejection, rather than swallowing it silently', () => {
  const body = fnBody('queueEpubOperation');
  assert.match(body, /epubOperationChain\s*=\s*epubOperationChain\.then\(run,\s*run\)/, 'must chain onto the shared operation queue so two operations can never run concurrently');
  assert.match(body, /\.catch\(/, 'a rejected operation must be caught, not left to crash the chain');
  assert.match(body, /showEpubRenderError\(\)/, 'a genuine failure must surface the visible render-error state, never fail silently');
  assert.match(body, /hideEpubRenderError\(\)/, 'a successful operation must clear any previously-shown render-error state');
});

test('queueEpubOperation() races its operation against a bounded safety timeout, so the shared queue can never deadlock even if the operation\'s own promise never settles', () => {
  const body = fnBody('queueEpubOperation');
  assert.match(body, /Promise\.race\(\[attempt,\s*safetyTimeout\]\)/, 'must race the operation against an independent timeout — a pathological epub.js-internal failure found live can leave the operation\'s own promise never settling, which would otherwise block every operation queued after it forever, not just look stuck');
  assert.match(body, /setTimeout\(\(\) => \{/, 'the timeout must be a plain setTimeout, not itself chained to the (possibly permanently pending) operation promise');
});

test('queueEpubResize() passes the current CFI as resize()\'s own third argument — epub.js\'s native position-preserving redisplay path, not a bespoke one', () => {
  const body = fnBody('queueEpubResize');
  assert.match(body, /epubRendition\.resize\(undefined,\s*undefined,\s*cfi/, 'must pass the captured cfi through to resize(), so epub.js\'s own onResized() redisplays exactly that position after the relayout');
  assert.match(body, /clientWidth === 0 \|\| .*clientHeight === 0/, 'must skip resizing against an unmeasurable (0-size) container rather than laying out against bogus dimensions');
});

test('openEpubReadSession() wires the toolbar (wireEpubControls/wireEpubDrawers) only AFTER the initial display() has resolved, and calls queueEpubResize() as its post-load safety net', () => {
  const body = fnBody('openEpubReadSession');
  const removeLoadingIndex = body.lastIndexOf('removeLoadingNotice()');
  const wireControlsIndex = body.indexOf('wireEpubControls()', removeLoadingIndex);
  const resizeIndex = body.indexOf('queueEpubResize()', removeLoadingIndex);
  assert.ok(removeLoadingIndex !== -1, 'removeLoadingNotice() must still be called');
  assert.ok(
    wireControlsIndex !== -1 && wireControlsIndex > removeLoadingIndex,
    'wireEpubControls() must be called after the loading notice is removed — otherwise a customer could tap Next/Zoom while the very first display() is still in flight, racing it'
  );
  assert.ok(resizeIndex !== -1 && resizeIndex > removeLoadingIndex, 'the post-load safety-net resize must be called after the loading notice is removed and the reader is actually ready');
});

test('handleEpubRelocated() records lastKnownGoodCfi and clears any render-error state on every real relocation — the self-healing half of the render-error fallback', () => {
  const body = fnBody('handleEpubRelocated');
  assert.match(body, /lastKnownGoodCfi = cfi/);
  assert.match(body, /hideEpubRenderError\(\)/);
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
