/**
 * PDF text extraction — Digital Library Phase 7C (AI Reading
 * Assistant).
 *
 * `pdf-parse` (an installed, previously-unused dependency this phase
 * was specifically asked to investigate) was tried first and crashes
 * the Workers runtime hard, on import, before any extraction code
 * runs — confirmed directly against the real workerd runtime (this
 * project's Vitest Workers pool), not assumed. It pulls in
 * `@napi-rs/canvas`, a native (N-API) binding with no equivalent in
 * `workerd`. Left alone, unused, in package.json rather than force-fit.
 *
 * `pdfjs-dist` — the engine pdf-parse itself wraps, and the exact
 * library already vendored client-side for the reader
 * (js/vendor/pdfjs/) — is the working alternative, confirmed by the
 * same direct testing: its non-legacy (browser-targeted) build fails
 * with `ReferenceError: DOMMatrix is not defined` the moment its
 * display/canvas module evaluates. Its `legacy` build (Node-oriented,
 * needs `nodejs_compat` — now enabled in wrangler.jsonc, per this
 * project's own "add it if/when a real need exists" policy) has the
 * same DOMMatrix requirement but no unresolvable Node built-in beneath
 * it.
 *
 * DOMMatrix polyfill, and WHY the pdfjs-dist import below is dynamic,
 * not static: `canvas.js` constructs `new DOMMatrix()` at MODULE LOAD
 * time (confirmed by direct source inspection — `const SCALE_MATRIX =
 * new DOMMatrix();` sits at that module's top level, not inside a
 * function), so `globalThis.DOMMatrix` must already exist before
 * pdf.js's module graph is evaluated at all — even though this file
 * only ever calls `getTextContent()`, never anything canvas-related.
 * A STATIC `import { getDocument } from 'pdfjs-dist/...'` at this
 * file's top level does not work for that ordering: ES modules
 * evaluate every top-level import's target module fully before this
 * file's own top-level statements run, so a polyfill assignment
 * written as a plain statement here — even textually above the
 * pdfjs-dist import — still executes AFTER pdf.js's own module body
 * (confirmed directly: that ordering was tried first and still hit
 * "DOMMatrix is not defined"). A dynamic `await import(...)`, run
 * inside a function body, is genuinely deferred until this line
 * actually executes — after the polyfill assignment below has already
 * run as ordinary synchronous code.
 *
 * `dommatrix` is a small, dependency-free, MIT-licensed 2D/3D affine-
 * matrix shim — pdf.js's own attempted fallback (`@napi-rs/canvas`) is
 * a native binding that cannot load in workerd at all. This file never
 * renders anything, so the shim's real-world accuracy for canvas
 * drawing was never a concern — only that the standard operations
 * pdf.js's own transform math calls (multiply/translate/scale/invert)
 * behave correctly, which is exactly what an established shim package,
 * not a hand-rolled one, is for.
 *
 * Extracts PER-PAGE text so citation page numbers are real and
 * substantiated, never inferred.
 */
import DOMMatrixPolyfill from 'dommatrix';
const globalWithDOMMatrix = globalThis as unknown as { DOMMatrix?: unknown };
if (typeof globalWithDOMMatrix.DOMMatrix === 'undefined') {
  globalWithDOMMatrix.DOMMatrix = DOMMatrixPolyfill;
}

export interface ExtractedPdfPage {
  pageNumber: number;
  text: string;
}

export interface ExtractedPdf {
  totalPages: number;
  pages: ExtractedPdfPage[];
}

/**
 * `bytes` is the whole file, already fetched from R2 by the caller —
 * this function does no I/O of its own, matching this codebase's
 * "routes/services stay thin, one clear job" convention.
 */
export async function extractPdfText(bytes: ArrayBuffer): Promise<ExtractedPdf> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // Found and fixed during real-infrastructure verification (Phase 7C
  // production readiness pass) — this worked fine under the Vitest
  // Workers pool but failed under the REAL wrangler dev/deploy bundler
  // with "Setting up fake worker failed: No such module pdf.worker.mjs."
  // pdf.js's own no-real-worker-thread fallback (workerd has no Web
  // Worker constructor pdf.js can use) tries a DYNAMIC
  // `import(GlobalWorkerOptions.workerSrc)` against a relative path
  // ("./pdf.worker.mjs") that esbuild's single-file bundle (wrangler's
  // actual build) cannot resolve, even though Vitest's own bundler
  // tolerated it. Rather than depend on that dynamic resolution at all,
  // this statically imports the worker module (which esbuild CAN
  // discover and bundle, being a real top-level import) and hands it to
  // pdf.js directly via the exact global it already checks for before
  // ever attempting its own dynamic import — confirmed by source
  // inspection of PDFWorker's `#mainThreadWorkerMessageHandler` getter.
  if (typeof (globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker === 'undefined') {
    const pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    (globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker;
  }

  const doc = await getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false }).promise;
  try {
    const pages: ExtractedPdfPage[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      // items[].str is pdf.js's own per-glyph-run text — joined with a
      // space, matching the same "real extracted text, no fabricated
      // structure" approach the existing public knowledge base's own
      // htmlExtraction.ts takes with DOM text nodes.
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pages.push({ pageNumber, text });
      page.cleanup();
    }
    return { totalPages: doc.numPages, pages };
  } finally {
    await doc.destroy();
  }
}
