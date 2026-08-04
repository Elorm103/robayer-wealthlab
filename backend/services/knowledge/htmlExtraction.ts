/**
 * Static-page content extraction — Version 5.0 Milestone 2 (Knowledge
 * Base). Uses `HTMLRewriter`, the native Workers streaming HTML
 * parser — no new dependency, matching this project's established
 * zero-runtime-dependency posture (see utils/passwordHash.ts's own
 * header comment on the same discipline applied to cryptography).
 *
 * Extracts, from a fetched page's HTML:
 *  - `<title>`
 *  - `<meta name="description">`
 *  - Every `<script type="application/ld+json">` block, parsed —
 *    this site already embeds real structured data (Article/FAQPage/
 *    Service/WebPage schemas, confirmed present on real pages during
 *    this milestone's own content-inventory verification), which is
 *    cleaner, more reliable ground truth than trying to re-derive the
 *    same facts from arbitrary HTML.
 *  - Plain text within `<main>` — confirmed present on every real page
 *    checked during this milestone's verification (investment-centre,
 *    legal, services, the homepage). If a future page genuinely lacks
 *    a `<main>` element, `mainText` comes back empty and that
 *    document is recorded with `status = 'failed'`
 *    (services/knowledge/indexingService.ts) rather than silently
 *    indexing nothing under a false "success."
 */

export interface ExtractedPage {
  title: string;
  metaDescription: string | null;
  mainText: string;
  jsonLd: unknown[];
}

export async function extractPageContent(response: Response): Promise<ExtractedPage> {
  let title = '';
  let metaDescription: string | null = null;
  const jsonLdBlocks: string[] = [];
  const mainTextParts: string[] = [];

  const rewriter = new HTMLRewriter()
    .on('title', {
      text(chunk) {
        title += chunk.text;
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        metaDescription = el.getAttribute('content');
      },
    })
    .on('script[type="application/ld+json"]', {
      text(chunk) {
        if (jsonLdBlocks.length === 0) jsonLdBlocks.push('');
        jsonLdBlocks[jsonLdBlocks.length - 1] += chunk.text;
        if (chunk.lastInTextNode) jsonLdBlocks.push('');
      },
    })
    .on('main', {
      text(chunk) {
        mainTextParts.push(chunk.text);
      },
    });

  const transformed = rewriter.transform(response);
  await transformed.text(); // drives the stream through every handler above

  const jsonLd: unknown[] = [];
  for (const block of jsonLdBlocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    try {
      jsonLd.push(JSON.parse(trimmed));
    } catch {
      // Malformed JSON-LD on a real page is a content bug on that
      // page, not a reason to fail the whole extraction — skip it and
      // keep the rest of what was successfully parsed.
    }
  }

  const trimmedMetaDescription: string | null = typeof metaDescription === 'string' ? (metaDescription as string).trim() : null;

  return {
    title: title.trim(),
    metaDescription: trimmedMetaDescription,
    mainText: mainTextParts.join('').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
    jsonLd,
  };
}

interface JsonLdFaqEntry {
  '@type'?: string;
  name?: string;
  acceptedAnswer?: { text?: string };
}

interface JsonLdFaqPage {
  '@type'?: string;
  mainEntity?: JsonLdFaqEntry[];
}

/** Extracts {question, answer} pairs from any FAQPage JSON-LD block(s) found on a page — see knowledge_faqs (migration 0036). */
export function extractFaqsFromJsonLd(jsonLd: unknown[]): { question: string; answer: string }[] {
  const faqs: { question: string; answer: string }[] = [];

  for (const block of jsonLd) {
    const page = block as JsonLdFaqPage;
    if (page?.['@type'] !== 'FAQPage' || !Array.isArray(page.mainEntity)) continue;

    for (const entry of page.mainEntity) {
      const question = entry?.name?.trim();
      const answer = entry?.acceptedAnswer?.text?.trim();
      if (question && answer) faqs.push({ question, answer });
    }
  }

  return faqs;
}
