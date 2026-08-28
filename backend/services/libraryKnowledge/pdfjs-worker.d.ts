/**
 * pdfjs-dist ships no type declarations for its worker entry point
 * (it's meant to be loaded as a side-effecting script/module, not a
 * typed API surface) — see pdfExtraction.ts's own header comment on
 * why this file is imported directly rather than left to pdf.js's own
 * dynamic-import fallback.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs';
