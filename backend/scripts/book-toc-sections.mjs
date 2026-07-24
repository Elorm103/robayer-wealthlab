/**
 * The canonical list of sections that belong in "Small Cedis, Big Wealth"'s
 * Table of Contents, grouped for hierarchy. Page numbers are NEVER stored
 * here — see resolvePageMap() below, which finds each section's real page
 * by scanning the actual PDF text at build time. If a chapter is ever
 * reordered, renamed, or a page count shifts, re-running the build finds
 * the new correct page automatically; it never silently drifts the way the
 * old static TOC did (see docs/media-library-asset-replacement-procedure.md
 * for the incident that motivated treating this as append-only-safe).
 *
 * `match` is a regex tested against the first ~2 lines of each PDF page's
 * extracted text (see resolvePageMap). It intentionally matches the
 * *heading* text, not the TOC's own display label, so a title can be
 * shortened for the TOC (see Chapter 4) without breaking the match.
 */

export const TOC_GROUPS = [
  {
    group: 'Front Matter',
    entries: [
      { title: 'Copyright & Disclaimer', match: /^Copyright & Disclaimer$/m },
      { title: 'About Robayer WealthLab', match: /^About Robayer WealthLab$/m },
      { title: 'About the Author', match: /^About the Author$/m },
      { title: 'Why I Wrote This Book', match: /^Why I Wrote This Book$/m },
    ],
  },
  {
    group: 'Introduction',
    entries: [
      {
        title: 'Introduction: Why Small Money Can Build Big Wealth in Ghana',
        match: /^Introduction: Why Small Money Can Build Big Wealth in Ghana$/m,
      },
    ],
  },
  {
    group: 'Chapters',
    entries: [
      { title: 'Chapter 1: Mobile Money Susu & Digital Savings Wallets', match: /^CHAPTER 1 OF 9$/m },
      { title: "Chapter 2: Treasury Bills, Ghana's Safest Real Investment", match: /^CHAPTER 2 OF 9$/m },
      { title: 'Chapter 3: Money Market Funds & Mutual Funds', match: /^CHAPTER 3 OF 9$/m },
      { title: 'Chapter 4: IC Wealth and Other Licensed Wealth Platforms', match: /^CHAPTER 4 OF 9$/m },
      { title: 'Chapter 5: The Ghana Stock Exchange', match: /^CHAPTER 5 OF 9$/m },
      { title: 'Chapter 6: Traditional Bank Savings & Fixed Deposits', match: /^CHAPTER 6 OF 9$/m },
      { title: 'Chapter 7: Petty Trading & Skills', match: /^CHAPTER 7 OF 9$/m },
      { title: 'Chapter 8: How to Spot and Avoid Investment Scams in Ghana', match: /^CHAPTER 8 OF 9$/m },
      { title: 'Chapter 9: Your 6-Month Action Plan', match: /^CHAPTER 9 OF 9$/m },
    ],
  },
  {
    group: 'Additional Resources',
    entries: [
      { title: 'Frequently Asked Questions', match: /^Frequently Asked Questions$/m },
      { title: 'Bonus Chapter: 10 Biggest Money Mistakes Ghanaians Make', match: /^Bonus Chapter: 10 Biggest Money Mistakes Ghanaians Make$/m },
      { title: 'Bonus: The 30-Day Wealth Challenge', match: /^Bonus: The 30-Day Wealth Challenge$/m },
      { title: 'Bonus: Investment Due-Diligence Checklist', match: /^Bonus: Investment Due-Diligence Checklist$/m },
      { title: 'Bonus: Financial Goal Worksheet', match: /^Bonus: Financial Goal Worksheet$/m },
      { title: 'Bonus: Official Resource Links', match: /^Bonus: Official Resource Links$/m },
    ],
  },
  {
    group: 'Back Matter',
    entries: [
      { title: 'Glossary', match: /^Glossary$/m },
      { title: 'Appendix: Side-by-Side Comparison', match: /^Appendix: Side-by-Side Comparison$/m },
      { title: 'Continue Your Wealth Journey', match: /^Continue Your Wealth Journey$/m },
      // Two pages in the current PDF carry this exact heading (7 and 37) —
      // a pre-existing content duplication bug (see audit report). The TOC
      // must point at the real one: the LAST match, since the legitimate
      // "Other Books" section belongs at the very end of the book, and the
      // earlier occurrence is the stray duplicate.
      { title: 'Other Books by Robayer WealthLab', match: /^Other Books by Robayer WealthLab$/m, useLastMatch: true },
    ],
  },
];

/**
 * Scans every page's extracted text and returns each entry's true 1-indexed
 * PDF page number. Throws (rather than silently guessing) if a section's
 * heading can't be found, so a future content change fails loudly instead
 * of shipping a wrong page number.
 *
 * Matches only against each page's own FIRST line, not the whole page
 * body — every real heading in this book is the first line of its page
 * (confirmed by inspection), and matching the whole page would also match
 * the TOC page itself, since it lists every other section's title as body
 * text (a real false-positive hit this function used to produce before
 * this comment was written).
 */
export function resolvePageMap(pagesText) {
  const firstLines = pagesText.map((text) => (text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''));

  const map = new Map();
  for (const { entries } of TOC_GROUPS) {
    for (const entry of entries) {
      const matches = [];
      for (let i = 0; i < firstLines.length; i++) {
        if (entry.match.test(firstLines[i])) matches.push(i + 1);
      }
      if (matches.length === 0) {
        throw new Error(`TOC section "${entry.title}" not found as any page's heading — pattern ${entry.match} matched no page's first line. Book content may have changed; update book-toc-sections.mjs.`);
      }
      map.set(entry.title, entry.useLastMatch ? matches[matches.length - 1] : matches[0]);
    }
  }
  return map;
}
