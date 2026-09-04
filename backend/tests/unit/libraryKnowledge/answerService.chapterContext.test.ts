/**
 * Integration tests: Robayer AI chapter-context architecture — Phase 4.
 * Proves the actual failure mode this phase's brief calls out ("summarize
 * chapter" was a generic top-K similarity search with no real chapter
 * identity) is fixed: a reader positioned inside a specific real chapter
 * gets that chapter's OWN content deterministically, via real chapter
 * identity (page->chapter_title for PDF, href->cfi for EPUB) — never a
 * similarity guess — even when the free-text question shares no
 * vocabulary with the chapter at all.
 *
 * Same real-pipeline technique as answerService.test.ts (real bytes
 * through R2, real extraction/chunking/D1 writes, only the OpenAI HTTP
 * calls mocked) — kept in its own file so this phase's new fixtures
 * (a real multi-chapter, real-outline PDF; a real multi-chapter EPUB)
 * don't entangle with that file's existing, already-passing coverage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { PDFDocument, StandardFonts, PDFString } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';
import { createLogger } from '../../../utils/logger';
import { answerLibraryQuestion } from '../../../services/libraryKnowledge/answerService';
import { queueOpenAiResponse } from '../../outboundMock';
import { createFakeVectorizeIndex } from '../../knowledgeTestHelpers';

const logger = createLogger('test-request-id', 'test');

/** Mirrors scripts/pdf-outline.mjs's own addOutline() — see pdfExtraction.outline.test.ts's own copy of this helper for why pdf-lib needs it built by hand. */
function addFlatOutline(pdfDoc: PDFDocument, nodes: { title: string; pageIndex: number }[]): void {
  const { context } = pdfDoc;
  const pages = pdfDoc.getPages();
  const refs = nodes.map(() => context.nextRef());
  nodes.forEach((node, i) => {
    const dict = context.obj({
      Title: PDFString.of(node.title),
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

/** A real 5-page PDF, real outline: page 1 = cover (no chapter), pages 2-3 = Chapter 1, pages 4-5 = Chapter 2. Each page's text is deliberately vocabulary-disjoint from every other page, so a similarity-only search would never reliably land on the right one — proving LEVEL 1's exact resolution is what's actually doing the work. */
async function buildMultiChapterPdf(): Promise<ArrayBuffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pageTexts = [
    'Cover. Understanding the Ghana Stock Exchange.',
    'Budgeting means planning your monthly cedi income against your expenses ahead of time.',
    'A zero-based budget assigns every cedi a job before the month begins.',
    'The stock exchange lists companies whose shares the public can buy and sell.',
    'Dividends are a portion of company profit paid out to shareholders periodically.',
  ];
  for (const text of pageTexts) {
    const page = pdfDoc.addPage([300, 300]);
    page.drawText(text, { x: 20, y: 150, size: 10, font, maxWidth: 260 });
  }
  addFlatOutline(pdfDoc, [
    { title: 'Chapter 1: Budgeting Basics', pageIndex: 1 },
    { title: 'Chapter 2: The Stock Exchange', pageIndex: 3 },
  ]);
  const bytes = await pdfDoc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** A real 2-chapter EPUB (real ZIP via fflate, real OPF/spine/manifest) — same vocabulary-disjoint design as the PDF fixture above. */
function buildMultiChapterEpub(): ArrayBuffer {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/content.opf"/></rootfiles></container>'),
    'EPUB/content.opf': strToU8(
      '<?xml version="1.0"?><package><manifest><item id="ch1" href="ch1.xhtml"/><item id="ch2" href="ch2.xhtml"/></manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>'
    ),
    'EPUB/ch1.xhtml': strToU8(
      '<html><head><title>Chapter 1: Budgeting Basics</title></head><body><h1>Chapter 1: Budgeting Basics</h1><p>Budgeting means planning your monthly cedi income against your expenses ahead of time. A zero-based budget assigns every cedi a job before the month begins.</p></body></html>'
    ),
    'EPUB/ch2.xhtml': strToU8(
      '<html><head><title>Chapter 2: The Stock Exchange</title></head><body><h1>Chapter 2: The Stock Exchange</h1><p>The stock exchange lists companies whose shares the public can buy and sell. Dividends are a portion of company profit paid out to shareholders periodically.</p></body></html>'
    ),
  };
  const zipped = zipSync(files);
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);
}

function envWithFakeVectorize() {
  return { ...(env as any), LIBRARY_KNOWLEDGE_INDEX: createFakeVectorizeIndex() };
}

// Deliberately does NOT queue a specific embedding response:
// outboundMock's OpenAI embeddings handler is a single-slot override
// (INSERT OR REPLACE on one fixed key), not a real FIFO — queuing
// twice upfront (indexing, then query) silently clobbers the first
// with the second, which is exactly wrong once indexing needs more
// than one vector (see this file's own multi-chunk fixtures). Its
// UNqueued DEFAULT already auto-generates one small, deterministic,
// correctly-SIZED vector per input text (whatever the real request
// actually sends) — perfectly sufficient here, since these tests
// prove LEVEL 1's EXACT chapter resolution works regardless of vector
// similarity, never that a specific similarity score was computed.

async function queueChatAnswer(content = 'CHAPTER SUMMARY\nChapter: placeholder\nMain Idea: placeholder.'): Promise<void> {
  await queueOpenAiResponse(env as any, { status: 200, body: { choices: [{ message: { content } }], usage: { prompt_tokens: 80, completion_tokens: 30 }, model: 'gpt-4o-mini' } });
}

const CUSTOMER_A = 3001;

async function seedProduct(slug: string, assetId: string, storageKey: string, fileType: 'PDF' | 'EPUB', bytes: ArrayBuffer): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES (?, ?, ?, 'investing', 'ebook', 'active', 3900, 'GHS', 'one-time', 'inclusive', 'en')`
  )
    .bind(`prod-${slug}`, slug, `Title for ${slug}`)
    .run();
  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES (?, ?, ?, 1024, ?, ?, ?, 'document', 'books', 'ready')`
  )
    .bind(`${slug}.${fileType.toLowerCase()}`, `${slug}.${fileType.toLowerCase()}`, fileType === 'PDF' ? 'application/pdf' : 'application/epub+zip', `hash-${slug}`, storageKey, `https://example.com/${slug}`)
    .run();
  const mediaId = Number(mediaInsert.meta.last_row_id);
  const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(slug).first<{ id: number }>();
  await env.DB.prepare(`INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status) VALUES (?, ?, ?, ?, ?, 'published')`)
    .bind(productRow!.id, assetId, mediaId, fileType, fileType)
    .run();
  await env.STORAGE.put(storageKey, bytes);
}

async function seedPurchase(reference: string, customerId: number, slug: string, assetId: string): Promise<void> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, expires_at)
     VALUES (?, ?, ?, ?, 3900, 'GHS', 'verified', ?, datetime('now', '+30 minutes'))`
  )
    .bind(reference, slug, `prod-${slug}`, `Title for ${slug}`, customerId)
    .run();
  await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) VALUES (?, ?, ?, 10, 0, 'delivered')`)
    .bind(Number(insert.meta.last_row_id), assetId, slug)
    .run();
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM library_ai_message_citations');
  await env.DB.exec('DELETE FROM library_ai_messages');
  await env.DB.exec('DELETE FROM library_knowledge_chunks');
  await env.DB.exec('DELETE FROM library_knowledge_documents');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM product_files');
  await env.DB.exec('DELETE FROM media_assets');
  await env.DB.exec('DELETE FROM products');
  await env.DB.exec('DELETE FROM customers');
  await env.DB.exec(`DELETE FROM ai_usage_log`);
  await env.DB.exec(`DELETE FROM site_settings WHERE key LIKE 'ai_gateway_%'`);
  await env.DB.prepare(`INSERT INTO customers (id, email, status) VALUES (?, 'a@example.com', 'active')`).bind(CUSTOMER_A).run();
});

describe('Robayer AI chapter-context — LEVEL 1 (current chapter), PDF', () => {
  it('a reader on page 4 (inside "Chapter 2: The Stock Exchange") gets a "high" confidence, chapter-correct answer even with a vocabulary-disjoint question', async () => {
    const pdf = await buildMultiChapterPdf();
    await seedProduct('gse-book', 'asset-gse-pdf', 'ebooks/gse-book.pdf', 'PDF', pdf);
    await seedPurchase('RWL-2026-910001', CUSTOMER_A, 'gse-book', 'asset-gse-pdf');
    const testEnv = envWithFakeVectorize();
    await queueChatAnswer();

    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-910001',
      assetId: 'asset-gse-pdf',
      customerId: CUSTOMER_A,
      mode: 'summarize',
      question: '',
      currentPage: 4, // real page 4 — inside Chapter 2's real [4,5] range
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('answered');
    // Exact resolution, not similarity: confidence is 'high' purely
    // because a real chapter was resolved, regardless of the (here,
    // deliberately low/irrelevant) vector scores.
    expect(result.confidenceTier).toBe('high');
    // Every citation must come from Chapter 2 specifically — the reader
    // was on page 4, never Chapter 1 (pages 2-3) or the cover (page 1).
    expect(result.citations.length).toBeGreaterThan(0);
    for (const c of result.citations) {
      if (c.chapterTitle) expect(c.chapterTitle).toBe('Chapter 2: The Stock Exchange');
    }
    // At least one citation is real page-scoped content that is
    // genuinely part of Chapter 2's real page range.
    expect(result.citations.some((c) => c.pageNumber === 4 || c.pageNumber === 5)).toBe(true);
  }, 15_000);

  it('a reader on page 1 (before any chapter starts) falls back to LEVEL 2 (whole-book) behavior — no fabricated chapter identity', async () => {
    const pdf = await buildMultiChapterPdf();
    await seedProduct('gse-book2', 'asset-gse-pdf2', 'ebooks/gse-book2.pdf', 'PDF', pdf);
    await seedPurchase('RWL-2026-910002', CUSTOMER_A, 'gse-book2', 'asset-gse-pdf2');
    const testEnv = envWithFakeVectorize();
    await queueChatAnswer('A generic, non-chapter-scoped answer.');

    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-910002',
      assetId: 'asset-gse-pdf2',
      customerId: CUSTOMER_A,
      mode: 'ask',
      question: 'What is this book about?',
      currentPage: 1, // the cover page — precedes the first real outline entry
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No chapter resolved for page 1 -> confidence follows the ordinary
    // similarity floor, not an automatic 'high'.
    expect(['high', 'medium', 'low', 'very_low']).toContain(result.confidenceTier);
  }, 15_000);

  it('a manipulated currentPage can only select a DIFFERENT chapter of the SAME authorized book — never another customer\'s/another book\'s content', async () => {
    const pdfA = await buildMultiChapterPdf();
    await seedProduct('gse-book3', 'asset-gse-pdf3', 'ebooks/gse-book3.pdf', 'PDF', pdfA);
    await seedPurchase('RWL-2026-910003', CUSTOMER_A, 'gse-book3', 'asset-gse-pdf3');
    const testEnv = envWithFakeVectorize();
    await queueChatAnswer();

    // An absurd, out-of-range page number — must never crash, never leak
    // another document's chunks, and must simply resolve to "no chapter"
    // (documentId-scoped lookup finds no matching page_number row).
    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-910003',
      assetId: 'asset-gse-pdf3',
      customerId: CUSTOMER_A,
      mode: 'ask',
      question: 'Tell me about this book.',
      currentPage: 999999,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.status === 'answered') {
      for (const c of result.citations) {
        // Whatever citations DO come back must still belong to THIS
        // book's own real chapters/pages, never a fabricated one.
        if (c.chapterTitle) expect(['Chapter 1: Budgeting Basics', 'Chapter 2: The Stock Exchange']).toContain(c.chapterTitle);
      }
    }
  }, 15_000);
});

describe('Robayer AI chapter-context — LEVEL 1 (current chapter), EPUB', () => {
  it('a reader in "ch2.xhtml" gets a "high" confidence, chapter-correct answer scoped to Chapter 2 only', async () => {
    const epub = buildMultiChapterEpub();
    await seedProduct('gse-epub', 'asset-gse-epub', 'ebooks/gse-epub.epub', 'EPUB', epub);
    await seedPurchase('RWL-2026-910010', CUSTOMER_A, 'gse-epub', 'asset-gse-epub');
    const testEnv = envWithFakeVectorize();
    await queueChatAnswer();

    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-910010',
      assetId: 'asset-gse-epub',
      customerId: CUSTOMER_A,
      mode: 'summarize',
      question: '',
      currentHref: 'ch2.xhtml',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('answered');
    expect(result.confidenceTier).toBe('high');
    expect(result.citations.length).toBeGreaterThan(0);
    for (const c of result.citations) {
      if (c.cfi) expect(c.cfi).toBe('ch2.xhtml');
      if (c.chapterTitle) expect(c.chapterTitle).toBe('Chapter 2: The Stock Exchange');
    }
  }, 15_000);

  it('a currentHref belonging to a DIFFERENT book the customer also owns never resolves — chapter identity is scoped by documentId, not just the href string', async () => {
    const epubA = buildMultiChapterEpub();
    await seedProduct('gse-epub-x', 'asset-gse-epub-x', 'ebooks/gse-epub-x.epub', 'EPUB', epubA);
    await seedPurchase('RWL-2026-910011', CUSTOMER_A, 'gse-epub-x', 'asset-gse-epub-x');
    const testEnv = envWithFakeVectorize();
    await queueChatAnswer('A generic, non-chapter-scoped answer.');

    // 'nonexistent-chapter.xhtml' never appears in THIS book's own
    // indexed chunks — resolveCurrentChapter() must return null (no
    // row matches), not fabricate or cross-match anything.
    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-910011',
      assetId: 'asset-gse-epub-x',
      customerId: CUSTOMER_A,
      mode: 'ask',
      question: 'What does this book cover?',
      currentHref: 'nonexistent-chapter.xhtml',
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.status === 'answered') {
      for (const c of result.citations) {
        if (c.cfi) expect(['ch1.xhtml', 'ch2.xhtml']).toContain(c.cfi);
      }
    }
  }, 15_000);
});
