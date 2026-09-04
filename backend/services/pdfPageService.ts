/**
 * PDF Page Service - Controlled Library Reader, Phase 2.
 *
 * Extracts exactly ONE page out of the master PDF (fetched fresh from
 * R2 for every request, never cached across requests, never written
 * back) into its own minimal, watermarked, single-page PDF document.
 * Uses `pdf-lib`'s `PDFDocument.load()` + `copyPages()` + `drawText()`
 * - proven to run cleanly in this project's real workerd runtime, and
 * the exact same drawing primitives services/orders/receiptPdfService.ts
 * already uses in production today. Deliberately NOT pixel rasterization:
 * no canvas backend exists in workerd (confirmed separately by
 * services/libraryKnowledge/pdfExtraction.ts's own investigation -
 * `@napi-rs/canvas` crashes on import), and a real single-page PDF
 * keeps vector text crisp and is smaller than a bitmap would be. The
 * client renders it with the exact same vendored PDF.js this reader
 * already uses for the whole file today - only the input is now one
 * page, never the whole book.
 *
 * The original R2 object is never modified - every call reads it
 * fresh and produces a new, disposable in-memory document.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export type PdfPageDenialReason = 'asset_unavailable' | 'invalid_page' | 'render_failed';

export type GetPdfPageCountResult = { ok: true; totalPages: number } | { ok: false; reason: PdfPageDenialReason };

export async function getPdfPageCount(masterBytes: ArrayBuffer): Promise<GetPdfPageCountResult> {
  try {
    const doc = await PDFDocument.load(masterBytes);
    return { ok: true, totalPages: doc.getPageCount() };
  } catch {
    return { ok: false, reason: 'render_failed' };
  }
}

export interface WatermarkInput {
  customerEmail: string;
  watermarkId: string;
  timestamp: string;
}

export type RenderPdfPageResult = { ok: true; bytes: Uint8Array; totalPages: number } | { ok: false; reason: PdfPageDenialReason };

/**
 * `pageNumber` is 1-indexed, matching the reader's own existing
 * page-numbering convention throughout library-reader.js/library_progress.
 */
export async function renderProtectedPdfPage(masterBytes: ArrayBuffer, pageNumber: number, watermark: WatermarkInput): Promise<RenderPdfPageResult> {
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(masterBytes);
  } catch {
    return { ok: false, reason: 'asset_unavailable' };
  }

  const totalPages = source.getPageCount();
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > totalPages) {
    return { ok: false, reason: 'invalid_page' };
  }

  try {
    const output = await PDFDocument.create();
    const [copiedPage] = await output.copyPages(source, [pageNumber - 1]);
    output.addPage(copiedPage);

    const font = await output.embedFont(StandardFonts.Helvetica);
    const { width } = copiedPage.getSize();
    const watermarkText = `Robayer WealthLab · ${watermark.customerEmail} · ${watermark.watermarkId} · ${watermark.timestamp}`;
    // Deliberately low-opacity, small, and positioned across the
    // bottom margin rather than centered/large: visible and legible on
    // close inspection (so it can't be dismissed as absent evidence of
    // origin), but not disruptive to reading. Removing it cleanly would
    // require re-authoring the page's own content stream around it -
    // real friction, not a one-click crop, though a sufficiently
    // motivated actor can still crop or paint over a visible watermark;
    // this is deterrence and traceability, not unbreakable protection.
    copiedPage.drawText(watermarkText, {
      x: 12,
      y: 10,
      size: 7,
      font,
      color: rgb(0.55, 0.55, 0.55),
      opacity: 0.55,
      maxWidth: width - 24,
    });

    const bytes = await output.save();
    return { ok: true, bytes, totalPages };
  } catch {
    return { ok: false, reason: 'render_failed' };
  }
}
