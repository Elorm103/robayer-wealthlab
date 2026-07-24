/**
 * Builds a real PDF outline (bookmark sidebar) tree via pdf-lib's
 * low-level object API. pdf-lib has no high-level "addBookmark" helper
 * (confirmed by grepping its README/exports — see rebuild-book-toc.mjs's
 * research notes), so this constructs the /Outlines dictionary structure
 * by hand: each item is a dict with /Title, /Parent, /Next, /Prev, /Dest,
 * and (for parents) /First, /Last, /Count.
 */
import { PDFString } from 'pdf-lib';

/**
 * @param {import('pdf-lib').PDFDocument} pdfDoc
 * @param {{ title: string, pageIndex: number, children?: object[] }[]} nodes
 *   pageIndex is 0-based, matching pdfDoc.getPages() indexing.
 */
export function addOutline(pdfDoc, nodes) {
  const { context } = pdfDoc;
  const pages = pdfDoc.getPages();

  // Builds one sibling chain, wiring Next/Prev, and returns
  // { firstRef, lastRef, visibleCount } for the parent to link in.
  function buildSiblings(items, parentRef) {
    const refs = items.map(() => context.nextRef());

    let visibleCount = 0;
    items.forEach((item, i) => {
      const pageRef = pages[item.pageIndex].ref;
      let childFirstRef, childLastRef, childCount = 0;
      if (item.children?.length) {
        const built = buildSiblings(item.children, refs[i]);
        childFirstRef = built.firstRef;
        childLastRef = built.lastRef;
        childCount = built.visibleCount;
      }

      const dict = context.obj({
        Title: PDFString.of(item.title),
        Parent: parentRef,
        Dest: [pageRef, 'Fit'],
        ...(i > 0 ? { Prev: refs[i - 1] } : {}),
        ...(i < items.length - 1 ? { Next: refs[i + 1] } : {}),
        ...(childFirstRef ? { First: childFirstRef, Last: childLastRef, Count: childCount } : {}),
      });
      context.assign(refs[i], dict);
      visibleCount += 1; // children start collapsed, so they don't add to the parent's visible Count
    });

    return { firstRef: refs[0], lastRef: refs[refs.length - 1], visibleCount };
  }

  const { firstRef, lastRef, visibleCount } = buildSiblings(nodes, null);
  const outlinesRef = context.nextRef();
  const outlinesDict = context.obj({
    Type: 'Outlines',
    First: firstRef,
    Last: lastRef,
    Count: visibleCount,
  });
  context.assign(outlinesRef, outlinesDict);

  // Fix up every top-level item's Parent to point at the real Outlines
  // ref (buildSiblings was called with parentRef=null for the root level,
  // since the Outlines ref doesn't exist yet at that point).
  let cursor = firstRef;
  while (cursor) {
    const dict = context.lookup(cursor);
    dict.set(context.obj('Parent'), outlinesRef);
    cursor = dict.get(context.obj('Next'));
  }

  pdfDoc.catalog.set(context.obj('Outlines'), outlinesRef);
}
