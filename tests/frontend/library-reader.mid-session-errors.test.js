/**
 * Secure Digital Library - mid-session PDF error handling regression
 * tests. Real bug found during the pre-commit security review: the
 * secure reader's per-page shim (createSecurePdfDocShim) throws when a
 * page fetch fails - an expired/revoked reader session, or the
 * secure_reader_enabled kill switch being turned off mid-session (see
 * routes/reader.ts's new flag check) - but renderPage() only cleared
 * its `rendering` guard on the SUCCESS path, and none of its three
 * callers (goToPage, setScale, refitAndRerender) caught the rejection.
 * The result: `rendering` stayed stuck `true` forever, which silently
 * disabled every further page turn/zoom/resize - no error shown, no
 * console message a customer would ever see, just a reader that
 * stopped responding. This is exactly the "unhandled promise rejection
 * or silent stall" the fix targets.
 *
 * These are structural/source tests for the same reason
 * library-reader.drawer-timing.test.js's are - this file's functions
 * are closure-scoped and not exposed for direct unit testing.
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

test('renderPage() clears the `rendering` guard in a finally block, not a bare mid-function assignment - so it clears even when pdfDoc.getPage()/page.render() throws', () => {
  const body = fnBody('renderPage');
  assert.match(body, /finally\s*\{\s*rendering\s*=\s*false;\s*\}/, 'rendering = false must be the last thing that runs, in a finally block, so a thrown error still clears it');
  // The old bug: a bare `rendering = false;` line outside any
  // try/finally, reached only on the success path.
  assert.doesNotMatch(body.replace(/finally\s*\{[^}]*\}/, ''), /rendering\s*=\s*false/, 'there must be no OTHER rendering = false assignment outside the finally block');
});

test('goToPage() catches a renderPage() failure and shows a visible error, instead of letting it reject unhandled', () => {
  const body = fnBody('goToPage');
  assert.match(body, /try\s*\{[\s\S]*await renderPage\(currentPage\)[\s\S]*\}\s*catch\s*\(error\)\s*\{[\s\S]*showError\(/, 'goToPage must await renderPage() inside a try/catch that calls showError() on failure');
});

test('setScale() catches a renderPage() failure and shows a visible error, instead of letting it reject unhandled', () => {
  const body = fnBody('setScale');
  assert.match(body, /try\s*\{[\s\S]*await renderPage\(currentPage\)[\s\S]*\}\s*catch\s*\(error\)\s*\{[\s\S]*showError\(/, 'setScale must await renderPage() inside a try/catch that calls showError() on failure');
});

test('refitAndRerender() catches a getPage()/renderPage() failure and shows a visible error, instead of letting it reject unhandled', () => {
  const body = fnBody('refitAndRerender');
  assert.match(body, /try\s*\{[\s\S]*await pdfDoc\.getPage\(currentPage\)[\s\S]*await renderPage\(currentPage\)[\s\S]*\}\s*catch\s*\(error\)\s*\{[\s\S]*showError\(/, 'refitAndRerender must wrap both awaited calls in a try/catch that calls showError() on failure');
});
