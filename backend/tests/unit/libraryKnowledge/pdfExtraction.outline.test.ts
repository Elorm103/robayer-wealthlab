/**
 * Unit tests: pdfExtraction.ts's outline-based chapter_title assignment
 * — Phase 4 (Robayer AI chapter-context architecture). Builds a REAL
 * multi-page PDF with a REAL outline/bookmark tree via pdf-lib's
 * low-level object API (the same technique this project's own
 * scripts/pdf-outline.mjs already established for production books),
 * then proves extractPdfText() resolves every outline entry to the
 * correct real page and assigns the correct chapter to every page in
 * its real range — never a guess, never fabricated.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, PDFString } from 'pdf-lib';
import { extractPdfText } from '../../../services/libraryKnowledge/pdfExtraction';

/** Mirrors scripts/pdf-outline.mjs's own addOutline() exactly — pdf-lib has no high-level bookmark API, so the /Outlines dictionary is built by hand. Flat (no nested children) is all this test needs. */
function addFlatOutline(pdfDoc: PDFDocument, nodes: { title: string; pageIndex: number }[]): void {
  const { context } = pdfDoc;
  const pages = pdfDoc.getPages();
  const refs = nodes.map(() => context.nextRef());
  nodes.forEach((node, i) => {
    const dict = context.obj({
      Title: PDFString.of(node.title),
      Parent: undefined,
      Dest: [pages[node.pageIndex].ref, 'Fit'],
      ...(i > 0 ? { Prev: refs[i - 1] } : {}),
      ...(i < nodes.length - 1 ? { Next: refs[i + 1] } : {}),
    });
    context.assign(refs[i], dict);
  });
  const outlinesRef = context.nextRef();
  context.assign(outlinesRef, context.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: nodes.length }));
  let cursor: unknown = refs[0];
  while (cursor) {
    const dict = context.lookup(cursor as any);
    dict.set(context.obj('Parent'), outlinesRef);
    cursor = dict.get(context.obj('Next'));
  }
  pdfDoc.catalog.set(context.obj('Outlines'), outlinesRef);
}

async function buildOutlinedPdf(): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  // Page 1: cover (no outline entry covers it). Page 2-3: Chapter 1.
  // Page 4-5: Chapter 2. 5 pages total.
  const pageTexts = ['Cover page, no chapter yet.', 'Chapter 1 page A content.', 'Chapter 1 page B content.', 'Chapter 2 page A content.', 'Chapter 2 page B content.'];
  for (const text of pageTexts) {
    const page = pdfDoc.addPage([300, 300]);
    page.drawText(text, { x: 20, y: 150, size: 12, font });
  }
  addFlatOutline(pdfDoc, [
    { title: 'Chapter 1: Getting Started', pageIndex: 1 },
    { title: 'Chapter 2: Going Further', pageIndex: 3 },
  ]);
  const bytes = await pdfDoc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe('extractPdfText() — outline-based chapter_title (Phase 4)', () => {
  it('resolves every real outline entry to its correct page and assigns the correct chapter to every page in range', async () => {
    const pdf = await buildOutlinedPdf();
    const result = await extractPdfText(pdf);

    expect(result.totalPages).toBe(5);
    // Page 1 precedes the first outline entry — correctly null, never
    // attributed to a chapter it comes before.
    expect(result.pages[0].chapterTitle).toBeNull();
    expect(result.pages[0].text).toContain('Cover page');

    expect(result.pages[1].chapterTitle).toBe('Chapter 1: Getting Started');
    expect(result.pages[2].chapterTitle).toBe('Chapter 1: Getting Started');
    expect(result.pages[3].chapterTitle).toBe('Chapter 2: Going Further');
    expect(result.pages[4].chapterTitle).toBe('Chapter 2: Going Further');

    // Real, distinct per-page text still extracted correctly alongside
    // the new chapter assignment — this feature must never regress the
    // existing per-page text extraction.
    expect(result.pages[1].text).toContain('Chapter 1 page A');
    expect(result.pages[3].text).toContain('Chapter 2 page A');
  });

  it('a PDF with no outline at all degrades to chapterTitle: null for every page, never throwing', async () => {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const page = pdfDoc.addPage([300, 300]);
    page.drawText('A single page, no outline.', { x: 20, y: 150, size: 12, font });
    const bytes = await pdfDoc.save();
    const pdf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    const result = await extractPdfText(pdf);
    expect(result.totalPages).toBe(1);
    expect(result.pages[0].chapterTitle).toBeNull();
    expect(result.pages[0].text).toContain('single page');
  });
});
