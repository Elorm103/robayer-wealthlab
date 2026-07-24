/**
 * Adds real clickable /Subtype /Link annotations to a page — the piece
 * Chrome's own print-to-PDF can't give us here, since the TOC is rendered
 * as a standalone single page with no in-document anchor target to
 * resolve (see render-toc-page.mjs's header comment). Built via pdf-lib's
 * low-level object API for the same reason as pdf-outline.mjs.
 */

/**
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @param {import('pdf-lib').PDFPage} page - the page to attach links to
 * @param {{ rect: [number, number, number, number], targetPageIndex: number }[]} links
 *   rect is [x1, y1, x2, y2] in PDF points, origin bottom-left (pdf-lib's
 *   own convention). targetPageIndex is 0-based.
 */
export function addLinkAnnotations(pdfDoc, page, links) {
  const { context } = pdfDoc;
  const pages = pdfDoc.getPages();

  const annotRefs = links.map(({ rect, targetPageIndex }) => {
    const dict = context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: rect,
      Border: [0, 0, 0], // no visible border box — the styled text itself is the affordance
      Dest: [pages[targetPageIndex].ref, 'Fit'],
    });
    return context.register(dict);
  });

  const existing = page.node.Annots();
  const annotsArray = existing ?? context.obj([]);
  for (const ref of annotRefs) annotsArray.push(ref);
  page.node.set(context.obj('Annots'), annotsArray);
}
