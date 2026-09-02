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

test('wireEpubControls() routes page navigation (both the toolbar buttons and arrow-key navigation) through queueEpubOperation() calling epubAdvancePage(), never epubRendition.next()/prev() directly', () => {
  const body = fnBody('wireEpubControls');
  const wrappedPrev = 'queueEpubOperation(() => epubAdvancePage(-1))';
  const wrappedNext = 'queueEpubOperation(() => epubAdvancePage(1))';
  const prevCount = body.split('epubAdvancePage(-1)').length - 1;
  const nextCount = body.split('epubAdvancePage(1)').length - 1;
  const wrappedPrevCount = body.split(wrappedPrev).length - 1;
  const wrappedNextCount = body.split(wrappedNext).length - 1;
  assert.ok(prevCount >= 2, 'expects both the toolbar button and the ArrowLeft key handler to call epubAdvancePage(-1)');
  assert.ok(nextCount >= 2, 'expects both the toolbar button and the ArrowRight key handler to call epubAdvancePage(1)');
  assert.equal(prevCount, wrappedPrevCount, 'every epubAdvancePage(-1) call must be wrapped in queueEpubOperation() — a bare one can race a concurrent display()/resize()');
  assert.equal(nextCount, wrappedNextCount, 'every epubAdvancePage(1) call must be wrapped in queueEpubOperation() — a bare one can race a concurrent display()/resize()');
  assert.doesNotMatch(body, /epubRendition\.(next|prev)\(\)/, 'the toolbar/keyboard handlers must go through epubAdvancePage(), not call epubRendition.next()/prev() directly — see epubAdvancePage()\'s own header comment for why a raw next()/prev() is too coarse a grain for a single Next/Prev press under \'scrolled-doc\' flow');
});

test('epubAdvancePage() — the \'scrolled-doc\'-flow page-turn implementation — only ever uses epub.js\'s own public manager.scrollBy()/rendition.next()/rendition.prev() APIs, never a raw scrollTop/scrollLeft assignment or any forced-repaint technique', () => {
  const body = fnBody('epubAdvancePage');
  assert.match(body, /manager\.scrollBy\(/, 'within-chapter page turns must go through epub.js\'s own public manager.scrollBy(), not a raw container.scrollTop assignment');
  assert.match(body, /epubRendition\.next\(\)/, 'reaching the bottom of a chapter must fall through to a real chapter transition via epubRendition.next()');
  assert.match(body, /epubRendition\.prev\(\)/, 'reaching the top of a chapter must fall through to a real chapter transition via epubRendition.prev()');
  assert.doesNotMatch(body, /\.scrollLeft\s*=/, 'must never manipulate scrollLeft directly — this reader no longer uses a horizontally-paginated flow');
  assert.doesNotMatch(body, /removeChild|insertBefore|appendChild/, 'must never detach/reattach the iframe — that technique was tried and rejected (it also destroys injected theme/CSS state); see openEpubReadSession()\'s own header comment on the flow choice');
  assert.doesNotMatch(body, /setTimeout|requestAnimationFrame/, 'epubAdvancePage() itself must contain no timing logic of its own — any wait for content to become visible must live in, and be bounded by, a dedicated, separately-tested function (waitForEpubChapterPaint()), not an inline delay here');
  assert.match(body, /waitForEpubChapterPaint\(\)/, 'a chapter transition (the atEdge branch) must verify the new content actually became visible before considering the navigation complete — see waitForEpubChapterPaint()\'s own header comment for why next()/prev() resolving is not by itself sufficient proof of that');
  assert.match(body, /if\s*\(!painted\)\s*throw/, 'if content never becomes visible within the bound, this must throw (so queueEpubOperation()\'s existing catch() surfaces the real render-error/Retry state), never silently return as if navigation succeeded');
});

test('waitForEpubChapterPaint() is a bounded, condition-checked wait for real painted content — never a fixed-duration delay used as the fix', () => {
  const body = fnBody('waitForEpubChapterPaint');
  assert.match(body, /EPUB_CHAPTER_PAINT_TIMEOUT_MS/, 'must be bounded by a real timeout constant, so a genuinely-failed transition can never hang the reader indefinitely');
  assert.match(body, /elementFromPoint\(/, 'must verify real paint/hit-testability (the same technique that root-caused this reader\'s original architecture bug), not just DOM/text presence — DOM text can be present while still not actually painted');
  assert.match(body, /getClientRects\(/, 'must check the real laid-out position of actual text nodes, not one fixed coordinate — a fixed point can land on whitespace/margin and produce a false "not painted" read even when real content is visible elsewhere on the page');
  assert.match(body, /resolve\(true\)/, 'must resolve true as soon as real content is confirmed');
  assert.match(body, /resolve\(false\)/, 'must resolve false (not reject, not hang) once the bound is reached with nothing ever confirmed, so the caller can surface a real error state');
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

test('openEpubReadSession() renders with the \'scrolled-doc\' flow, not the default paginated (CSS multi-column) flow — the confirmed-unsafe architecture this phase moved away from', () => {
  const body = fnBody('openEpubReadSession');
  assert.match(body, /renderTo\(canvasWrap,\s*\{[^}]*flow:\s*'scrolled-doc'/, 'must explicitly opt into scrolled-doc flow — the default paginated flow lays each chapter out as CSS multi-column content scrolled by an ancestor, which was proven (live, against the real book) to fail to paint/hit-test content beyond the first on-screen column');
  assert.doesNotMatch(body, /renderTo\(canvasWrap,\s*\{[^}]*gap:\s*0/, 'the old gap:0 renderTo() option was a fix specific to CSS multi-column pagination math and no longer applies once that flow is gone');
});

test('the AI trigger button, panel title, panel aria-label, and composer label all say "Robayer AI", never the old "WealthLab AI"', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../dashboard/read/index.html'), 'utf8');
  assert.doesNotMatch(html, /WealthLab AI/, 'no user-facing "WealthLab AI" branding should remain in the reader page');
  assert.match(html, /Ask Robayer AI/);
  assert.match(html, /Robayer AI Reading Assistant/);
  assert.match(html, />\s*<span aria-hidden="true">&#10022;<\/span> Robayer AI<\/h2>/);
});
