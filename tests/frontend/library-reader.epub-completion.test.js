/**
 * EPUB completion-tracking fix.
 *
 * Root cause (confirmed by direct reproduction against a real EPUB —
 * docs/book-treasury-bills-made-simple/production/epub/treasury-bills-made-simple.epub
 * — loaded through the real vendored epub.js, js/vendor/epubjs/epub.min.js,
 * in an isolated browser harness, not against any live customer session):
 * handleEpubRelocated() computed the progress percentage ONLY from
 * epubBook.locations.percentageFromCfi(cfi) — a location-bucket
 * approximation (as few as ~77 buckets for a book this length, i.e.
 * roughly 1.3% granularity per bucket) — and never consulted epub.js's
 * own 'relocated' event's `atEnd` flag, the library's purpose-built,
 * authoritative signal for "there is no more content past this
 * position." backend/services/customer/libraryProgressService.ts's
 * deriveStatus() requires `percentComplete >= 100` exactly to mark a
 * reading 'completed' (confirmed already correct and already tested in
 * backend/tests/unit/libraryProgressService.test.ts — passing
 * percentComplete: 100 or higher for EPUB already produces
 * status: 'completed'; the bug was entirely upstream of that, in what
 * the client ever actually sent). A customer who has genuinely reached
 * the true end of the book could therefore report 99% forever, with no
 * further action ever able to close that last ~1% gap, because
 * percentageFromCfi() at that exact CFI does not always round up to
 * exactly 100 depending on the book's own location-bucket boundaries.
 *
 * The fix reuses scheduleEpubProgressSave()'s existing `explicitPercent`
 * override parameter (already built for, and used by, the controlled-
 * reader chapter-index path below) rather than inventing a second
 * mechanism — when epub.js's own `location.atEnd` is true, that
 * overrides the location-bucket percentage to exactly 100, both for the
 * live progress indicator/bar and for what is sent to the server.
 * flushEpubProgressOnUnload() (the "customer closed the tab" safety net)
 * gets the identical override, so a completion reached right before
 * closing the tab is not lost to computeEpubPercent()'s own recomputation.
 *
 * library-reader.js's EPUB logic lives entirely inside closure-scoped
 * functions not exposed for direct unit testing (see
 * library-reader.epub-mobile.test.js's own header comment on why) —
 * these are therefore structural/contract tests, matching that file's
 * established convention: they assert the actual fix is present in the
 * shipped source, so it cannot silently regress later.
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

test('handleEpubRelocated() checks location.atEnd, not only percentageFromCfi(), before deciding the displayed/saved percentage', () => {
  const body = fnBody('handleEpubRelocated');
  assert.match(body, /percentageFromCfi\(/, 'must still compute the location-bucket percentage for the normal, not-yet-at-the-end case');
  assert.match(body, /location\.atEnd/, 'must read epub.js\'s own atEnd flag from the relocated event — the authoritative "no more content" signal percentageFromCfi() alone cannot always reach exactly 100 for');
});

test('handleEpubRelocated() forces the displayed percentage to exactly 100 when location.atEnd is true, overriding whatever percentageFromCfi() computed', () => {
  const body = fnBody('handleEpubRelocated');
  assert.match(body, /if\s*\(location\.atEnd\)\s*roundedPct\s*=\s*100/, 'atEnd must unconditionally set the percentage shown to the customer to 100, regardless of the location-bucket value');
});

test('handleEpubRelocated() passes the atEnd override into scheduleEpubProgressSave() via its existing explicitPercent parameter, not a second save mechanism', () => {
  const body = fnBody('handleEpubRelocated');
  assert.match(
    body,
    /scheduleEpubProgressSave\(cfi,\s*location\.atEnd\s*\?\s*100\s*:\s*undefined\)/,
    'must reuse the existing explicitPercent parameter (already built for, and used by, the controlled-reader chapter-index path) — inventing a parallel completion-save mechanism here would be exactly the kind of change the fix should avoid'
  );
});

test('flushEpubProgressOnUnload() (the tab-close safety net) applies the same atEnd override as handleEpubRelocated(), so a completion reached right before closing the tab is not lost to computeEpubPercent()\'s own recomputation', () => {
  const body = fnBody('flushEpubProgressOnUnload');
  assert.match(body, /loc\.atEnd/, 'must read the atEnd flag off the current location, mirroring handleEpubRelocated()\'s own check');
  assert.match(
    body,
    /percentComplete:\s*loc\.atEnd\s*\?\s*100\s*:\s*computeEpubPercent\(cfi\)/,
    'must send exactly 100 when atEnd is true, falling back to the normal computeEpubPercent(cfi) call otherwise — never silently dropping the override on this code path'
  );
});

test('the controlled-reader chapter-index completion path is untouched by this fix — reaching the last chapter there already computes exactly 100 from (chapterIndex + 1) / spineLength, a different and already-correct mechanism', () => {
  const controlledChapterFnStart = SOURCE.indexOf('function renderControlledEpubChapter');
  assert.ok(controlledChapterFnStart !== -1, 'renderControlledEpubChapter must still exist, unmodified in shape');
  const nearby = SOURCE.slice(controlledChapterFnStart, controlledChapterFnStart + 4000);
  assert.match(nearby, /chapterPercent\s*=\s*Math\.round\(\(\(index \+ 1\) \/ controlledEpubSpine\.length\) \* 100\)/, 'the controlled path\'s own chapter-granularity percentage formula must be unchanged — this fix is scoped to the legacy epub.js locations-based path only');
  assert.match(nearby, /scheduleEpubProgressSave\(`spine:\$\{href\}`,\s*chapterPercent\)/, 'the controlled path must still pass its own already-computed chapterPercent through scheduleEpubProgressSave()\'s explicitPercent parameter, unchanged by this fix');
});
