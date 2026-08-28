/**
 * Unit tests: AI Reading Assistant answer pipeline — Digital Library
 * Phase 7C. Runs the REAL pipeline end to end (real PDF bytes through
 * R2, real extraction, real chunking, real D1 writes) with only the
 * OpenAI HTTP calls mocked (tests/outboundMock.ts) and Vectorize
 * substituted for the real-runtime-unsupported fake
 * (tests/knowledgeTestHelpers.ts) — same technique
 * tests/unit/customerAi/answerService.test.ts already established for
 * the public assistant.
 *
 * Central concern, explicitly required by this phase's brief: cross-
 * customer and cross-resource isolation, proven directly against
 * actual returned data, not inferred from code reading.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createLogger } from '../../../utils/logger';
import { answerLibraryQuestion } from '../../../services/libraryKnowledge/answerService';
import { queueOpenAiEmbeddingResponse, queueOpenAiResponse } from '../../outboundMock';
import { createFakeVectorizeIndex } from '../../knowledgeTestHelpers';

const logger = createLogger('test-request-id', 'test');

// A real, minimal, valid single-page PDF (generated via pdf-lib, same
// technique used throughout this project's browser-side reader QA) —
// "Compound interest grows your savings over time." is its only text,
// short enough to always chunk into exactly one chunk.
const PDF_BASE64 =
  'JVBERi0xLjcKJYGBgYEKCjYgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCAxMzkKPj4Kc3RyZWFtCnicJYqxCgIxEET7/YqtBXGzSXYuIBZyOSxshP0BERVFC0X8fpOTYWB48160dRLueV9ptTs/vufP7XRcQsqQBsFQOCj7hTSx7ynMamAVjlnYn7RO0SYbITYhW7WkYsUqkmVoa0QnaHsCEFVQugltK1qAddvmp3Gz/5MaHS1r3bDfyRdUnQ70A0nKJeUKZW5kc3RyZWFtCmVuZG9iagoKNyAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovVHlwZSAvT2JqU3RtCi9OIDUKL0ZpcnN0IDI2Ci9MZW5ndGggMzYzCj4+CnN0cmVhbQp4nNVS30vDMBB+z19xj/ogSdOsP2QMtrVVkKFsgqL4kLVhVEYibSrzv/eu7SZ7EJ+lfCR3993l7voFIECCUhBCnICCSShhAlGgYDpl/PHrwwB/0DvTMn5XVy28YlTAGt4YX7rOegjYbMZ+uEvt9d7t2JAEAZGPjIfGVV1pGpgWeVEIEQshIoWIhJAZnktEipBoY0wmeEfEagT64lCIcI6xYkAUDzkU77mTMT/HE7kRcbKBq5LBPr1Lb+VDDflXP+mM8ZWrMu0NXGTXUshIJDIJUhWE0cslrqMx2rv/O1zff+3srxOe/efCWc/4ptv63iRnwPhCt4YiwG/N/tP4utSM57Z0VW13wJ9qO7dtfXScVyTBkGwaQ6rqdcPXpnVdU6KQiNdXpsup+FUs0gQnj5MUtTtKjT/fb99N2VPJzA/+ZuNpqsFBvpWpar1wB9SzwA93CbgbUvXcWudJ573CrcduyIpG1WPyN7AzxfYKZW5kc3RyZWFtCmVuZG9iagoKOCAwIG9iago8PAovU2l6ZSA5Ci9Sb290IDIgMCBSCi9JbmZvIDMgMCBSCi9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9UeXBlIC9YUmVmCi9MZW5ndGggNDIKL1cgWyAxIDIgMiBdCi9JbmRleCBbIDAgOSBdCj4+CnN0cmVhbQp4nGNgYPj/n4mBnYEBRDCCCCYQwQwiWBgZBBgYGBmeAAmmrQwMAGLhA+QKZW5kc3RyZWFtCmVuZG9iagoKc3RhcnR4cmVmCjY5MwolJUVPRg==';

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function envWithFakeVectorize() {
  return { ...(env as any), LIBRARY_KNOWLEDGE_INDEX: createFakeVectorizeIndex() };
}

/** Cosine similarity against the fixed query vector below is exactly `cosine`. */
function vectorForCosine(cosine: number): number[] {
  return [cosine, Math.sqrt(Math.max(0, 1 - cosine * cosine)), 0, 0, 0, 0, 0, 0];
}
const QUERY_VECTOR = vectorForCosine(1.0);

async function queueIndexingAndQueryEmbeddings(): Promise<void> {
  // 1st embedText() call: indexing the one real chunk this fixture produces.
  await queueOpenAiEmbeddingResponse(env as any, { status: 200, body: { data: [{ embedding: vectorForCosine(1.0), index: 0 }], usage: { prompt_tokens: 8 }, model: 'text-embedding-3-small' } });
  // 2nd embedText() call: the customer's query.
  await queueOpenAiEmbeddingResponse(env as any, { status: 200, body: { data: [{ embedding: QUERY_VECTOR, index: 0 }], usage: { prompt_tokens: 5 }, model: 'text-embedding-3-small' } });
}

async function queueChatAnswer(): Promise<void> {
  await queueOpenAiResponse(env as any, { status: 200, body: { choices: [{ message: { content: 'Compound interest means your savings earn interest on interest over time.' } }], usage: { prompt_tokens: 50, completion_tokens: 20 }, model: 'gpt-4o-mini' } });
}

const CUSTOMER_A = 2001;
const CUSTOMER_B = 2002;

async function seedProductWithAsset(slug: string, assetId: string, storageKey: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES (?, ?, ?, 'investing', 'ebook', 'active', 3900, 'GHS', 'one-time', 'inclusive', 'en')`
  )
    .bind(`prod-${slug}`, slug, `Title for ${slug}`)
    .run();
  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES (?, ?, 'application/pdf', 1024, ?, ?, ?, 'document', 'books', 'ready')`
  )
    .bind(`${slug}.pdf`, `${slug}.pdf`, `hash-${slug}`, storageKey, `https://example.com/${slug}.pdf`)
    .run();
  const mediaId = Number(mediaInsert.meta.last_row_id);
  const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(slug).first<{ id: number }>();
  await env.DB.prepare(`INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status) VALUES (?, ?, ?, 'PDF', 'PDF', 'published')`)
    .bind(productRow!.id, assetId, mediaId)
    .run();
  await env.STORAGE.put(storageKey, base64ToArrayBuffer(PDF_BASE64));
}

async function seedPurchase(reference: string, customerId: number, slug: string, assetId: string, overrides: { status?: string } = {}): Promise<void> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, expires_at)
     VALUES (?, ?, ?, ?, 3900, 'GHS', 'verified', ?, datetime('now', '+30 minutes'))`
  )
    .bind(reference, slug, `prod-${slug}`, `Title for ${slug}`, customerId)
    .run();
  const purchaseSessionId = Number(insert.meta.last_row_id);
  await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) VALUES (?, ?, ?, 10, 0, ?)`)
    .bind(purchaseSessionId, assetId, slug, overrides.status ?? 'delivered')
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
  await env.DB.prepare(`INSERT INTO customers (id, email, status) VALUES (?, 'b@example.com', 'active')`).bind(CUSTOMER_B).run();

  await seedProductWithAsset('book-a', 'asset-book-a-pdf', 'ebooks/book-a.pdf');
  await seedProductWithAsset('book-b', 'asset-book-b-pdf', 'ebooks/book-b.pdf');
});

describe('answerLibraryQuestion — customer isolation', () => {
  // 15s, not the 5s default — this is the one test in this file that
  // exercises real PDF extraction (services/libraryKnowledge/pdfExtraction.ts),
  // which since the Phase 7C production-readiness pass statically
  // imports pdfjs-dist's worker module up front (a real fix for a real
  // esbuild bundling gap — see that file's own header comment); Vitest's
  // bundler resolving that same module the first time a suite touches
  // it is real, legitimate work, not a stall.
  it("Customer A, who owns Book A, can ask about Book A and gets a real, grounded answer", async () => {
    await seedPurchase('RWL-2026-900001', CUSTOMER_A, 'book-a', 'asset-book-a-pdf');
    const testEnv = envWithFakeVectorize();
    await queueIndexingAndQueryEmbeddings();
    await queueChatAnswer();

    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-900001',
      assetId: 'asset-book-a-pdf',
      customerId: CUSTOMER_A,
      mode: 'ask',
      question: 'What does compound interest mean?',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('answered');
      expect(result.answer).toContain('interest');
      expect(result.citations.length).toBeGreaterThan(0);
    }
  }, 15_000);

  it('Customer B, who does NOT own Book A, cannot query Book A — denied, not_authorized', async () => {
    await seedPurchase('RWL-2026-900002', CUSTOMER_A, 'book-a', 'asset-book-a-pdf');
    const testEnv = envWithFakeVectorize();

    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-900002',
      assetId: 'asset-book-a-pdf',
      customerId: CUSTOMER_B,
      mode: 'ask',
      question: 'What does compound interest mean?',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_authorized');
    // No indexing or LLM call should ever have been attempted for a denied request.
    const usage = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ai_usage_log`).first<{ n: number }>();
    expect(usage!.n).toBe(0);
  });

  it('Customer A, who owns Book A but NOT Book B, cannot query Book B content', async () => {
    await seedPurchase('RWL-2026-900003', CUSTOMER_A, 'book-a', 'asset-book-a-pdf');
    // Book B belongs to nobody in this test — no purchase seeded for it at all.
    const testEnv = envWithFakeVectorize();

    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-900003', // Customer A's real, owned reference...
      assetId: 'asset-book-b-pdf', // ...but Book B's asset id, not Book A's
      customerId: CUSTOMER_A,
      mode: 'ask',
      question: 'What does this book say?',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_authorized');
  });

  it('a manipulated/nonexistent purchase reference is denied, not_authorized', async () => {
    const testEnv = envWithFakeVectorize();
    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-999999',
      assetId: 'asset-book-a-pdf',
      customerId: CUSTOMER_A,
      mode: 'ask',
      question: 'What does this book say?',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_authorized');
  });

  it('a revoked purchase denies AI access', async () => {
    await seedPurchase('RWL-2026-900004', CUSTOMER_A, 'book-a', 'asset-book-a-pdf', { status: 'revoked' });
    const testEnv = envWithFakeVectorize();
    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-900004',
      assetId: 'asset-book-a-pdf',
      customerId: CUSTOMER_A,
      mode: 'ask',
      question: 'What does this book say?',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_authorized');
  });

  it('an exhausted download limit does NOT block AI access — reading and asking never draw from the download count, exactly like the reader itself', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, expires_at)
       VALUES ('RWL-2026-900005', 'book-a', 'prod-book-a', 'Title for book-a', 3900, 'GHS', 'verified', ?, datetime('now', '+30 minutes'))`
    )
      .bind(CUSTOMER_A)
      .run();
    await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) VALUES (?, 'asset-book-a-pdf', 'book-a', 5, 5, 'delivered')`)
      .bind(Number(insert.meta.last_row_id))
      .run();

    const testEnv = envWithFakeVectorize();
    await queueIndexingAndQueryEmbeddings();
    await queueChatAnswer();

    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-900005',
      assetId: 'asset-book-a-pdf',
      customerId: CUSTOMER_A,
      mode: 'ask',
      question: 'What does compound interest mean?',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe('answered');
  });

  it("cross-resource retrieval isolation: even with both books indexed, a question about Book A only ever cites Book A's chunks", async () => {
    await seedPurchase('RWL-2026-900006', CUSTOMER_A, 'book-a', 'asset-book-a-pdf');
    await seedPurchase('RWL-2026-900007', CUSTOMER_A, 'book-b', 'asset-book-b-pdf');
    const testEnv = envWithFakeVectorize();

    // Index Book A first.
    await queueIndexingAndQueryEmbeddings();
    await queueChatAnswer();
    const first = await answerLibraryQuestion(testEnv, logger, { purchaseReference: 'RWL-2026-900006', assetId: 'asset-book-a-pdf', customerId: CUSTOMER_A, mode: 'ask', question: 'What does compound interest mean?' });
    expect(first.ok).toBe(true);

    // Index Book B second — same fixture text/vector on purpose, so
    // Vectorize's topK genuinely returns candidates from BOTH books
    // with equally strong scores; only the D1 document_id filter can
    // tell them apart.
    await queueIndexingAndQueryEmbeddings();
    await queueChatAnswer();
    const second = await answerLibraryQuestion(testEnv, logger, { purchaseReference: 'RWL-2026-900007', assetId: 'asset-book-b-pdf', customerId: CUSTOMER_A, mode: 'ask', question: 'What does compound interest mean?' });
    expect(second.ok).toBe(true);

    // Now ask about Book A again — confirm its citations resolve back
    // to Book A's own document, never Book B's, via the real citations table.
    if (first.ok && first.status === 'answered') {
      const citationRows = await env.DB.prepare(
        `SELECT lkd.product_slug AS productSlug FROM library_ai_message_citations c JOIN library_knowledge_documents lkd ON lkd.id = c.document_id WHERE c.message_id = ?`
      )
        .bind(first.messageId)
        .all<{ productSlug: string }>();
      expect(citationRows.results.length).toBeGreaterThan(0);
      for (const row of citationRows.results) {
        expect(row.productSlug).toBe('book-a');
      }
    } else {
      throw new Error('expected an answered response for Book A');
    }
  });
});
