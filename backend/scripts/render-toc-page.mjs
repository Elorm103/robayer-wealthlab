/**
 * Renders the redesigned Table of Contents as a standalone single US
 * Letter page (612x792pt, matching every other page in the current
 * production PDF — see _scratch-page-size.mjs's readout) via headless
 * Chrome, and reports each entry's exact on-page bounding box so
 * rebuild-book-toc.mjs can place real clickable link annotations over
 * them after splicing this page into the full book.
 *
 * Colors are sampled directly from the current production PDF's TOC page
 * (see _scratch-gold-precise.mjs / _scratch-extract-style.mjs), not
 * guessed, so the redesign stays visually consistent with the rest of the
 * book: headline navy #16233d, accent gold #d4a017.
 */

import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';
import { TOC_GROUPS } from './book-toc-sections.mjs';

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const NAVY = '#16233d';
const GOLD = '#d4a017';
const BODY_TEXT = '#2a2a2a';
const MUTED = '#6b6b6b';
const DIVIDER = '#e2e2e2';

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildHtml(pageMap) {
  const groupsHtml = TOC_GROUPS.map(({ group, entries }) => {
    const rows = entries
      .map((entry) => {
        const page = pageMap.get(entry.title);
        const chapterMatch = entry.title.match(/^Chapter (\d+): (.+)$/);
        const label = chapterMatch ? chapterMatch[2] : entry.title;
        const numberBadge = chapterMatch
          ? `<span class="chapter-num">${chapterMatch[1]}</span>`
          : '<span class="chapter-num chapter-num--blank"></span>';
        return `
          <li class="entry" data-toc-title="${escapeHtml(entry.title)}" data-toc-page="${page}">
            ${numberBadge}
            <div class="entry-link">
              <span class="entry-title">${escapeHtml(label)}</span>
              <span class="leader"></span>
              <span class="entry-page">${page}</span>
            </div>
          </li>`;
      })
      .join('\n');
    return `
      <section class="group">
        <h2 class="group-label">${escapeHtml(group)}</h2>
        <ul class="entries">${rows}</ul>
      </section>`;
  }).join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,600;0,700;1,500&family=Work+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  @page { size: 612pt 792pt; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 612pt;
    height: 792pt;
    font-family: 'Work Sans', Arial, sans-serif;
    color: ${BODY_TEXT};
    -webkit-font-smoothing: antialiased;
  }
  .page {
    position: relative;
    width: 100%;
    height: 100%;
    padding: 38pt 64.7pt 50pt 64.7pt;
    display: flex;
    flex-direction: column;
  }
  .running-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 8pt;
    letter-spacing: 1.5pt;
    text-transform: uppercase;
    color: ${MUTED};
    border-bottom: 0.75pt solid ${DIVIDER};
    padding-bottom: 8pt;
    margin-bottom: 22pt;
  }
  h1.headline {
    font-family: 'Newsreader', Georgia, serif;
    font-weight: 700;
    font-size: 27pt;
    color: ${NAVY};
    margin-bottom: 8pt;
  }
  .accent-bar {
    width: 42pt;
    height: 3pt;
    background: ${GOLD};
    margin-bottom: 22pt;
  }
  .group { margin-bottom: 13pt; }
  .group-label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 8pt;
    font-weight: 500;
    letter-spacing: 2pt;
    text-transform: uppercase;
    color: ${GOLD};
    margin-bottom: 6pt;
  }
  .entries { list-style: none; }
  .entry {
    display: flex;
    align-items: baseline;
    padding: 3.5pt 0;
    border-bottom: 0.5pt solid ${DIVIDER};
  }
  .entry:last-child { border-bottom: none; }
  .chapter-num {
    font-family: 'Newsreader', Georgia, serif;
    font-weight: 700;
    font-size: 9.5pt;
    color: ${NAVY};
    width: 15pt;
    flex: none;
  }
  .chapter-num--blank { width: 15pt; }
  .entry-link {
    display: flex;
    align-items: baseline;
    flex: 1;
    min-width: 0;
    text-decoration: none;
    color: inherit;
  }
  .entry-title {
    font-size: 10pt;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .leader {
    flex: 1;
    margin: 0 5pt;
    border-bottom: 0.75pt dotted #9a9a9a;
    transform: translateY(-2.5pt);
    min-width: 8pt;
  }
  .entry-page {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9pt;
    color: ${MUTED};
    flex: none;
    text-align: right;
    min-width: 14pt;
  }
</style>
</head>
<body>
  <div class="page">
    <div class="running-header">
      <span>Small Cedis, Big Wealth</span>
      <span>Table of Contents</span>
    </div>
    <h1 class="headline">Table of Contents</h1>
    <div class="accent-bar"></div>
    ${groupsHtml}
  </div>
</body>
</html>`;
}

/**
 * Renders the TOC page and returns { pdfBytes, boxes }, where boxes is
 * [{ title, page, rect: {x, y, width, height} }] in PDF point coordinates
 * (origin bottom-left, matching pdf-lib's Rect convention) for every
 * entry, ready to become a clickable link annotation.
 */
export async function renderTocPage(pageMap) {
  const executablePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!executablePath) {
    throw new Error(`No Chrome/Edge executable found at any of: ${CHROME_PATHS.join(', ')}`);
  }

  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(buildHtml(pageMap), { waitUntil: 'networkidle0' });

    const boxes = await page.evaluate(() => {
      const PT_PER_PX = 72 / 96; // Chrome renders CSS px at 96dpi; PDF points are 72/in
      return [...document.querySelectorAll('.entry')].map((el) => {
        const linkEl = el.querySelector('.entry-link');
        const r = linkEl.getBoundingClientRect();
        return {
          title: el.dataset.tocTitle,
          page: Number(el.dataset.tocPage),
          // top-left CSS px -> converted to pt; y-flip to PDF's bottom-left
          // origin happens later in rebuild-book-toc.mjs, once we know the
          // exact rendered page height in points.
          cssRect: { x: r.left * PT_PER_PX, yTop: r.top * PT_PER_PX, width: r.width * PT_PER_PX, height: r.height * PT_PER_PX },
        };
      });
    });

    const pdfBytes = await page.pdf({ width: '8.5in', height: '11in', printBackground: true, preferCSSPageSize: true });
    return { pdfBytes, boxes };
  } finally {
    await browser.close();
  }
}

// Allow standalone `node scripts/render-toc-page.mjs <in.pdf> <out.pdf>` for quick visual QA.
const { pathToFileURL } = await import('url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { PDFParse } = await import('pdf-parse');
  const fs = await import('fs');
  const { resolvePageMap } = await import('./book-toc-sections.mjs');

  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('Usage: node scripts/render-toc-page.mjs <source-book.pdf> <out-toc-preview.pdf>');
    process.exit(1);
  }
  const buffer = fs.readFileSync(inPath);
  const parser = new PDFParse({ data: buffer });
  const text = await parser.getText();
  const pageMap = resolvePageMap(text.pages.map((p) => p.text));

  const { pdfBytes, boxes } = await renderTocPage(pageMap);
  fs.writeFileSync(outPath, pdfBytes);
  console.log('wrote', outPath);
  console.log(JSON.stringify(boxes, null, 2));
}
