/**
 * Publishing-quality Table of Contents fix for "Small Cedis, Big Wealth".
 * See docs/flagship-toc-and-filename-audit.md for the full audit this
 * implements.
 *
 * Deliberately NOT a full-book regeneration — the original HTML/CSS
 * source used to produce the current production PDF no longer exists in
 * this repo (confirmed: no puppeteer/book.html references anywhere), and
 * reconstructing 37 pages of richly-formatted manuscript content from
 * extracted text alone would risk real content regressions the task
 * explicitly forbids. Instead this surgically:
 *   1. Renders a new, corrected TOC as its own single page (render-toc-page.mjs)
 *   2. Splices it into the existing PDF in place of the old page 6 —
 *      every other page's bytes are copied through untouched
 *   3. Adds real clickable link annotations on the new TOC (pdf-links.mjs)
 *   4. Adds a real PDF outline/bookmark tree (pdf-outline.mjs)
 *   5. Fixes the /Info Title (was the meaningless default "book.html")
 *
 * Every page number — in the TOC, the links, and the bookmarks — comes
 * from resolvePageMap() in book-toc-sections.mjs, which finds each
 * section's real page by scanning the actual current PDF. Nothing here
 * is a hardcoded page number; re-running this script against a
 * future edition of the book (different page count, reordered chapters)
 * recomputes everything from scratch.
 *
 * Usage: node scripts/rebuild-book-toc.mjs <source-book.pdf> <output.pdf>
 */

import { PDFDocument, PDFString } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import fs from 'fs';
import { TOC_GROUPS, resolvePageMap } from './book-toc-sections.mjs';
import { renderTocPage } from './render-toc-page.mjs';
import { addLinkAnnotations } from './pdf-links.mjs';
import { addOutline } from './pdf-outline.mjs';

const TOC_PHYSICAL_PAGE = 6; // 1-indexed position of the old TOC in the source PDF
const PAGE_HEIGHT_PT = 792; // US Letter, matches every page in the current book (confirmed via pdf-lib getSize())

const BOOK_TITLE = 'Small Cedis, Big Wealth';
const BOOK_SUBTITLE = 'A Practical Ghanaian Wealth Guide';
const BOOK_AUTHOR = 'Robayer WealthLab';

async function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('Usage: node scripts/rebuild-book-toc.mjs <source-book.pdf> <output.pdf>');
    process.exit(1);
  }

  const sourceBytes = fs.readFileSync(inPath);

  // --- 1. Resolve every section's real page number from the source PDF ---
  const parser = new PDFParse({ data: sourceBytes });
  const extracted = await parser.getText();
  const pagesText = extracted.pages.map((p) => p.text);
  const pageMap = resolvePageMap(pagesText); // Map<title, 1-indexed page>
  console.log(`Resolved ${pageMap.size} TOC entries across ${pagesText.length} source pages.`);

  // --- 2. Render the new TOC as its own page, with entry bounding boxes ---
  const { pdfBytes: tocPdfBytes, boxes } = await renderTocPage(pageMap);
  console.log(`Rendered new TOC page (${boxes.length} entries with bounding boxes).`);

  // --- 3. Splice: load both PDFs, swap page 6, copy everything else through ---
  const sourceDoc = await PDFDocument.load(sourceBytes);
  const tocDoc = await PDFDocument.load(tocPdfBytes);

  const originalPageCount = sourceDoc.getPageCount();
  const tocPageIndex = TOC_PHYSICAL_PAGE - 1; // 0-based

  const [copiedTocPage] = await sourceDoc.copyPages(tocDoc, [0]);
  sourceDoc.removePage(tocPageIndex);
  sourceDoc.insertPage(tocPageIndex, copiedTocPage);

  if (sourceDoc.getPageCount() !== originalPageCount) {
    throw new Error(`Page count changed during splice: ${originalPageCount} -> ${sourceDoc.getPageCount()}. Aborting — this would be a real regression.`);
  }
  console.log(`Spliced new TOC into page ${TOC_PHYSICAL_PAGE} of ${sourceDoc.getPageCount()} (page count preserved).`);

  // --- 4. Add real clickable link annotations on the new TOC page ---
  const newTocPage = sourceDoc.getPages()[tocPageIndex];
  const links = boxes.map(({ title, page, cssRect }) => {
    const x1 = cssRect.x;
    const x2 = cssRect.x + cssRect.width;
    const y1 = PAGE_HEIGHT_PT - (cssRect.yTop + cssRect.height);
    const y2 = PAGE_HEIGHT_PT - cssRect.yTop;
    return { rect: [x1, y1, x2, y2], targetPageIndex: page - 1, title };
  });
  addLinkAnnotations(sourceDoc, newTocPage, links);
  console.log(`Added ${links.length} clickable link annotations to the TOC.`);

  // --- 5. Add a real PDF outline/bookmark tree, mirroring the TOC's own grouping ---
  const outlineNodes = TOC_GROUPS.flatMap(({ group, entries }) => {
    const children = entries.map((e) => ({ title: e.title, pageIndex: pageMap.get(e.title) - 1 }));
    // Primary reading units (Introduction, each Chapter) stay flat/top-level
    // for one-click access; supplementary groups nest under a labeled
    // parent, mirroring the visual TOC's own hierarchy.
    if (group === 'Introduction' || group === 'Chapters') return children;
    return [{ title: group, pageIndex: children[0].pageIndex, children }];
  });
  addOutline(sourceDoc, outlineNodes);
  console.log(`Added PDF outline/bookmarks (${outlineNodes.length} top-level items).`);

  // --- 6. Fix /Info metadata (was "book.html", a Puppeteer default) ---
  sourceDoc.setTitle(`${BOOK_TITLE} — ${BOOK_SUBTITLE}`);
  sourceDoc.setAuthor(BOOK_AUTHOR);

  const finalBytes = await sourceDoc.save();
  fs.writeFileSync(outPath, finalBytes);
  console.log(`\nWrote corrected book to ${outPath} (${(finalBytes.length / 1024 / 1024).toFixed(2)} MB).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
