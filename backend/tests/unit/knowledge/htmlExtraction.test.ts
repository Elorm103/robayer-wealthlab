/**
 * Unit tests: static-page HTML/JSON-LD extraction — Version 5.0
 * Milestone 2 (Knowledge Base). Feeds real HTML strings through
 * `HTMLRewriter` via constructed `Response` objects — no network
 * involved.
 */
import { describe, it, expect } from 'vitest';
import { extractPageContent, extractFaqsFromJsonLd } from '../../../services/knowledge/htmlExtraction';

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

describe('extractPageContent', () => {
  it('extracts title, meta description, and main text from a well-formed page', async () => {
    const html = `<!doctype html><html><head>
      <title>Treasury Bills | Robayer WealthLab</title>
      <meta name="description" content="A guide to treasury bills in Ghana.">
    </head><body>
      <header><nav>Home | About</nav></header>
      <main><h1>Treasury Bills</h1><p>Treasury bills are short-term government securities.</p></main>
      <footer>Copyright 2026</footer>
    </body></html>`;

    const extracted = await extractPageContent(htmlResponse(html));
    expect(extracted.title).toBe('Treasury Bills | Robayer WealthLab');
    expect(extracted.metaDescription).toBe('A guide to treasury bills in Ghana.');
    expect(extracted.mainText).toContain('Treasury Bills');
    expect(extracted.mainText).toContain('short-term government securities');
  });

  it('returns an empty mainText when the page has no <main> element', async () => {
    const html = `<!doctype html><html><head><title>No Main</title></head><body><p>Body text with no main tag.</p></body></html>`;
    const extracted = await extractPageContent(htmlResponse(html));
    expect(extracted.mainText).toBe('');
  });

  it('parses a real FAQPage JSON-LD block', async () => {
    const html = `<!doctype html><html><head>
      <title>Services</title>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: [{ '@type': 'Question', name: 'How quickly do you reply?', acceptedAnswer: { '@type': 'Answer', text: 'Within 2-3 business days.' } }],
      })}</script>
    </head><body><main>Some content</main></body></html>`;

    const extracted = await extractPageContent(htmlResponse(html));
    expect(extracted.jsonLd).toHaveLength(1);
    const faqs = extractFaqsFromJsonLd(extracted.jsonLd);
    expect(faqs).toEqual([{ question: 'How quickly do you reply?', answer: 'Within 2-3 business days.' }]);
  });

  it('skips a malformed JSON-LD block without throwing, keeping any other valid ones', async () => {
    const html = `<!doctype html><html><head>
      <title>Mixed</title>
      <script type="application/ld+json">{not valid json</script>
      <script type="application/ld+json">${JSON.stringify({ '@type': 'WebPage', name: 'Real Page' })}</script>
    </head><body><main>Content</main></body></html>`;

    const extracted = await extractPageContent(htmlResponse(html));
    expect(extracted.jsonLd).toHaveLength(1);
    expect((extracted.jsonLd[0] as { name: string }).name).toBe('Real Page');
  });

  it('collapses whitespace but does not fabricate content', async () => {
    const html = `<!doctype html><html><head><title>Whitespace</title></head><body><main>


      Line one.


      Line two.
    </main></body></html>`;

    const extracted = await extractPageContent(htmlResponse(html));
    expect(extracted.mainText).not.toMatch(/\n{3,}/);
    expect(extracted.mainText).toContain('Line one.');
    expect(extracted.mainText).toContain('Line two.');
  });
});

describe('extractFaqsFromJsonLd', () => {
  it('returns an empty array when no FAQPage block is present', () => {
    expect(extractFaqsFromJsonLd([{ '@type': 'WebPage' }])).toEqual([]);
    expect(extractFaqsFromJsonLd([])).toEqual([]);
  });

  it('ignores a mainEntity entry missing a question or answer', () => {
    const jsonLd = [{ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q with no answer' }, { '@type': 'Question', acceptedAnswer: { text: 'A with no question' } }] }];
    expect(extractFaqsFromJsonLd(jsonLd)).toEqual([]);
  });
});
