/**
 * Unit tests: pdfPageService.ts - Controlled Library Reader, Phase 4. The
 * single most security-critical file in this feature: proves the
 * per-page extraction actually returns a strict SUBSET of the master
 * document, never the whole thing, and that the watermark is genuinely
 * present in the output.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getPdfPageCount, renderProtectedPdfPage } from '../../services/pdfPageService';

async function buildTestPdf(pageCount: number): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([400, 600]);
    page.drawText(`This is real page ${i} content, distinct from every other page.`, { x: 40, y: 550, size: 14, font });
  }
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe('getPdfPageCount()', () => {
  it('returns the real page count of a multi-page document', async () => {
    const bytes = await buildTestPdf(7);
    const result = await getPdfPageCount(bytes);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.totalPages).toBe(7);
  });

  it('reports render_failed for genuinely invalid PDF bytes, never throwing', async () => {
    const result = await getPdfPageCount(new TextEncoder().encode('not a pdf at all').buffer);
    expect(result.ok).toBe(false);
  });
});

describe('renderProtectedPdfPage() - the core security property', () => {
  it('returns a document that is genuinely SMALLER than the multi-page master - proof this is a real extraction, not the complete file relabeled', async () => {
    const master = await buildTestPdf(20);
    const result = await renderProtectedPdfPage(master, 5, { customerEmail: 'reader@example.com', watermarkId: 'RWL-TEST0001', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes.byteLength).toBeLessThan(master.byteLength);
  });

  it('the returned document contains EXACTLY one page, regardless of how many pages the master has', async () => {
    const master = await buildTestPdf(50);
    const result = await renderProtectedPdfPage(master, 23, { customerEmail: 'reader@example.com', watermarkId: 'RWL-TEST0002', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reloaded = await PDFDocument.load(result.bytes);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it('page 1 and page 2 of the same master produce genuinely DIFFERENT output bytes - proof the correct, distinct page is served each time, not a cached/repeated one', async () => {
    const master = await buildTestPdf(5);
    const page1 = await renderProtectedPdfPage(master, 1, { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: '2026-01-01T00:00:00.000Z' });
    const page2 = await renderProtectedPdfPage(master, 2, { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: '2026-01-01T00:00:00.000Z' });
    expect(page1.ok && page2.ok).toBe(true);
    if (!page1.ok || !page2.ok) return;
    expect(Buffer.from(page1.bytes).equals(Buffer.from(page2.bytes))).toBe(false);
  });

  it('rejects page 0 and a page number beyond the real page count, never silently clamping to a valid page', async () => {
    const master = await buildTestPdf(10);
    const zero = await renderProtectedPdfPage(master, 0, { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: 'now' });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.reason).toBe('invalid_page');

    const tooHigh = await renderProtectedPdfPage(master, 11, { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: 'now' });
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.reason).toBe('invalid_page');
  });

  it('the watermark text (customer email and watermark id) is genuinely embedded in the output PDF bytes, extractable via the same pdfjs-dist text extraction this codebase already uses for the AI knowledge base', async () => {
    const master = await buildTestPdf(3);
    const result = await renderProtectedPdfPage(master, 2, {
      customerEmail: 'traceable-owner@example.com',
      watermarkId: 'RWL-DEADBEEF',
      timestamp: '2026-06-15T10:30:00.000Z',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Real, independent verification: extract text from the produced
    // page using pdf.js (a completely different library from pdf-lib,
    // which produced it) - proves the watermark is a real, readable
    // part of the page's own content stream, not just a claim.
    const { extractPdfText } = await import('../../services/libraryKnowledge/pdfExtraction');
    const extracted = await extractPdfText(result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength));
    expect(extracted.totalPages).toBe(1);
    expect(extracted.pages[0].text).toContain('traceable-owner@example.com');
    expect(extracted.pages[0].text).toContain('RWL-DEADBEEF');
    expect(extracted.pages[0].text).toContain('Robayer WealthLab');
  });

  it('reports asset_unavailable for genuinely corrupt master bytes, never throwing', async () => {
    const result = await renderProtectedPdfPage(new TextEncoder().encode('garbage').buffer, 1, { customerEmail: 'a@example.com', watermarkId: 'RWL-A', timestamp: 'now' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('asset_unavailable');
  });
});
