/**
 * Phase J.2.1 regression tests — js/components/library-ai-panel.js's
 * citation filtering/labeling logic (the P0 defect the J.1 audit found:
 * EPUB citations were silently dropped because the old filter only
 * accepted `pageNumber != null`, which is never true for EPUB).
 *
 * This project has no frontend bundler/test framework (confirmed: no
 * root package.json, no existing frontend test files) — these plain
 * <script>-loaded files are written as top-level functions/globals, not
 * ES modules. Rather than introduce a new framework for one bug fix,
 * this uses Node's built-in test runner (`node:test`, no install
 * required) plus `node:vm` to execute the REAL, unmodified source file
 * with a minimal `document` stub (the only top-level DOM call in this
 * file is `document.addEventListener(...)`, at the very bottom — it is
 * never invoked as part of loading, only registered), then exercises
 * the two functions this fix added at top level specifically so they
 * would be testable: `isRealCitation` and `formatCitationLabel`.
 *
 * Run: node --test tests/frontend/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadLibraryAiPanelGlobals() {
  const source = fs.readFileSync(path.join(__dirname, '../../js/components/library-ai-panel.js'), 'utf8');
  const sandbox = { document: { addEventListener: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'library-ai-panel.js' });
  return sandbox;
}

test('PDF citation with a chapter title: unchanged label, "Chapter · Page N"', () => {
  const { isRealCitation, formatCitationLabel } = loadLibraryAiPanelGlobals();
  const citation = { pageNumber: 42, chapterTitle: 'Chapter 2: Treasury Bills', cfi: null };
  assert.equal(isRealCitation(citation), true);
  assert.equal(formatCitationLabel(citation), 'Chapter 2: Treasury Bills · Page 42');
});

test('PDF citation with no chapter title: unchanged label, "Page N"', () => {
  const { isRealCitation, formatCitationLabel } = loadLibraryAiPanelGlobals();
  const citation = { pageNumber: 7, chapterTitle: null, cfi: null };
  assert.equal(isRealCitation(citation), true);
  assert.equal(formatCitationLabel(citation), 'Page 7');
});

test('EPUB citation with a real chapter title: retained (was silently dropped before the fix), labeled with that title, never a fabricated page number', () => {
  const { isRealCitation, formatCitationLabel } = loadLibraryAiPanelGlobals();
  const citation = { pageNumber: null, chapterTitle: 'Chapter 1: Treasury Bills Explained', cfi: 'ch1.xhtml' };
  assert.equal(isRealCitation(citation), true);
  assert.equal(formatCitationLabel(citation), 'Chapter 1: Treasury Bills Explained');
  assert.doesNotMatch(formatCitationLabel(citation), /Page \d/, 'must never fabricate a page number for EPUB');
});

test('EPUB citation with no chapter title: retained, falls back to the honest "This section" label, never a fabricated chapter name', () => {
  const { isRealCitation, formatCitationLabel } = loadLibraryAiPanelGlobals();
  const citation = { pageNumber: null, chapterTitle: null, cfi: 'ch3.xhtml' };
  assert.equal(isRealCitation(citation), true);
  assert.equal(formatCitationLabel(citation), 'This section');
});

test('a citation with neither a page number nor a cfi is not real (defensive — should not occur from the server, but must not render as a broken/blank button)', () => {
  const { isRealCitation } = loadLibraryAiPanelGlobals();
  assert.equal(isRealCitation({ pageNumber: null, chapterTitle: null, cfi: null }), false);
});

test('a mixed citation list (PDF book + EPUB book across two answers) keeps every citation with a real location — the exact regression this fix addresses', () => {
  const { isRealCitation } = loadLibraryAiPanelGlobals();
  const pdfCitations = [
    { pageNumber: 1, chapterTitle: null, cfi: null },
    { pageNumber: 5, chapterTitle: 'Intro', cfi: null },
  ];
  const epubCitations = [
    { pageNumber: null, chapterTitle: 'Chapter 1', cfi: 'ch1.xhtml' },
    { pageNumber: null, chapterTitle: null, cfi: 'ch2.xhtml' },
  ];
  assert.equal(pdfCitations.filter(isRealCitation).length, 2, 'PDF citations must be unaffected by this fix');
  assert.equal(epubCitations.filter(isRealCitation).length, 2, 'EPUB citations must no longer be dropped — this was the P0 defect');
});
