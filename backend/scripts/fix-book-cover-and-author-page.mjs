/**
 * Two surgical content fixes on the already-TOC-corrected book, found by
 * the user comparing the current 37-page production PDF against an
 * older local copy:
 *   1. The cover (page 1) is missing the Robayer WealthLab logo —
 *      present in the older copy, absent here. Fixed by drawing the
 *      real production logo asset (assets/branding/logo/logo-with-tagline.png,
 *      the same file used to compose the site's OG image — see
 *      assets/branding/logo/README.md) directly onto the existing page,
 *      not by regenerating the page from scratch.
 *   2. The About the Author page (page 4) still has the literal
 *      "[Insert professional photo here]" placeholder line. Fixed by
 *      drawing a white rectangle over its exact bounding box (found by
 *      scanning a rendered screenshot for non-white pixels) — a
 *      standard, safe redaction technique. This whites out the text
 *      without needing to parse/rewrite the page's content stream,
 *      which pdf-lib doesn't support for existing text.
 *
 * Both edits only touch pages 1 and 4's own content streams (adding an
 * image XObject / a filled rectangle) — no other page is altered, and
 * neither the TOC, outline, links, nor /Info metadata from the previous
 * fix are touched.
 *
 * Usage: node scripts/fix-book-cover-and-author-page.mjs <in.pdf> <out.pdf>
 */

import { PDFDocument, rgb } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

const LOGO_PATH = path.resolve(import.meta.dirname, '../../assets/branding/logo/logo-with-tagline.png');

// Cover page (612x792pt), logo centered horizontally, positioned above
// the "A PRACTICAL GHANAIAN WEALTH GUIDE" eyebrow (which starts ~254pt
// from the top, measured from the current cover's rendered screenshot).
const LOGO_WIDTH_PT = 260;
const LOGO_TOP_PT = 100; // distance from top of page to top of logo

// "[Insert professional photo here]" bounding box on page 4, measured by
// scanning a scale-1.5 screenshot for non-white pixels (see
// _scratch-find-placeholder-bbox.mjs): x 65.3-219.3pt, y(top-origin)
// 109.3-118.7pt. Padded slightly to fully cover antialiasing/descenders.
const PLACEHOLDER_RECT = { x1: 62, x2: 224, yTop1: 106, yTop2: 122 };

async function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('Usage: node scripts/fix-book-cover-and-author-page.mjs <in.pdf> <out.pdf>');
    process.exit(1);
  }

  const doc = await PDFDocument.load(fs.readFileSync(inPath));
  const originalPageCount = doc.getPageCount();
  const [PAGE_WIDTH, PAGE_HEIGHT] = [612, 792];

  // --- 1. Draw the logo onto the cover page ---
  const logoBytes = fs.readFileSync(LOGO_PATH);
  const logoImage = await doc.embedPng(logoBytes);
  const logoHeight = LOGO_WIDTH_PT * (logoImage.height / logoImage.width);

  const coverPage = doc.getPages()[0];
  coverPage.drawImage(logoImage, {
    x: (PAGE_WIDTH - LOGO_WIDTH_PT) / 2,
    y: PAGE_HEIGHT - LOGO_TOP_PT - logoHeight, // bottom-left origin
    width: LOGO_WIDTH_PT,
    height: logoHeight,
  });
  console.log(`Drew logo on cover page (${LOGO_WIDTH_PT}x${logoHeight.toFixed(1)}pt, centered, top at ${LOGO_TOP_PT}pt).`);

  // --- 2. White out the placeholder line on the About the Author page ---
  const authorPage = doc.getPages()[3];
  const rectX = PLACEHOLDER_RECT.x1;
  const rectWidth = PLACEHOLDER_RECT.x2 - PLACEHOLDER_RECT.x1;
  const rectY = PAGE_HEIGHT - PLACEHOLDER_RECT.yTop2; // bottom-left origin
  const rectHeight = PLACEHOLDER_RECT.yTop2 - PLACEHOLDER_RECT.yTop1;
  authorPage.drawRectangle({
    x: rectX,
    y: rectY,
    width: rectWidth,
    height: rectHeight,
    color: rgb(1, 1, 1),
  });
  console.log(`Whited out the placeholder line on the About the Author page (page 4).`);

  if (doc.getPageCount() !== originalPageCount) {
    throw new Error(`Page count changed: ${originalPageCount} -> ${doc.getPageCount()}. Aborting.`);
  }

  const finalBytes = await doc.save();
  fs.writeFileSync(outPath, finalBytes);
  console.log(`\nWrote ${outPath} (${(finalBytes.length / 1024 / 1024).toFixed(2)} MB).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
