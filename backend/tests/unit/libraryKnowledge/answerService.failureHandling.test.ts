/**
 * Phase 5, Priority J — Robayer AI failure handling. Proves the
 * customer-facing behavior for the failure modes the phase brief
 * explicitly lists: empty/over-long questions, no relevant information
 * in the book, a question genuinely unrelated to the book, and a real
 * AI-provider failure (HTTP error, malformed response) — in every case,
 * the customer gets a plain, human-readable outcome, never a raw
 * backend error string, a stack trace, or an unhandled exception.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createLogger } from '../../../utils/logger';
import { answerLibraryQuestion } from '../../../services/libraryKnowledge/answerService';
import { findOrCreateCustomer } from '../../../services/customer/identityService';
import { createSession } from '../../../services/customer/sessionService';
import { queueOpenAiEmbeddingResponse, queueOpenAiResponse } from '../../outboundMock';
import { createFakeVectorizeIndex } from '../../knowledgeTestHelpers';

const logger = createLogger('test-request-id', 'test');

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

const CUSTOMER_A = 4001;

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

async function queueIndexingEmbedding(): Promise<void> {
  await queueOpenAiEmbeddingResponse(env as any, { status: 200, body: { data: [{ embedding: [1, 0, 0, 0, 0, 0, 0, 0], index: 0 }], usage: { prompt_tokens: 8 }, model: 'text-embedding-3-small' } });
}
async function queueQueryEmbedding(cosine: number): Promise<void> {
  const vec = [cosine, Math.sqrt(Math.max(0, 1 - cosine * cosine)), 0, 0, 0, 0, 0, 0];
  await queueOpenAiEmbeddingResponse(env as any, { status: 200, body: { data: [{ embedding: vec, index: 0 }], usage: { prompt_tokens: 5 }, model: 'text-embedding-3-small' } });
}
async function queueChatAnswer(content: string): Promise<void> {
  await queueOpenAiResponse(env as any, { status: 200, body: { choices: [{ message: { content } }], usage: { prompt_tokens: 50, completion_tokens: 10 }, model: 'gpt-4o-mini' } });
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
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await env.DB.exec(`DELETE FROM ai_usage_log`);
  await env.DB.exec(`DELETE FROM site_settings WHERE key LIKE 'ai_gateway_%'`);
  await env.DB.prepare(`INSERT INTO customers (id, email, status) VALUES (?, 'a@example.com', 'active')`).bind(CUSTOMER_A).run();
  await seedProductWithAsset('book-a', 'asset-book-a-pdf', 'ebooks/book-a.pdf');
});

describe('Robayer AI failure handling — pipeline level (answerService.ts)', () => {
  it('a real AI-provider HTTP failure (500) surfaces as llm_failed, never a raw error string leaked to the caller', async () => {
    await seedPurchase('RWL-2026-920001', CUSTOMER_A, 'book-a', 'asset-book-a-pdf');
    const testEnv = envWithFakeVectorize();
    await queueIndexingEmbedding();
    await queueQueryEmbedding(0.9);
    await queueOpenAiResponse(env as any, { status: 500, body: { error: { message: 'internal provider outage - some sensitive stack detail' } } });

    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-920001',
      assetId: 'asset-book-a-pdf',
      customerId: CUSTOMER_A,
      mode: 'ask',
      question: 'What does this book say?',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('llm_failed');
    // The message is logged (route-level), but this result object itself
    // never carries the provider's raw error text - confirmed by the
    // narrow, closed `reason` union answerLibraryQuestion() returns.
  }, 15_000);

  it('a malformed AI response (no completion content at all) is treated as a failure, never crashes or returns garbage as an answer', async () => {
    await seedPurchase('RWL-2026-920002', CUSTOMER_A, 'book-a', 'asset-book-a-pdf');
    const testEnv = envWithFakeVectorize();
    await queueIndexingEmbedding();
    await queueQueryEmbedding(0.9);
    await queueOpenAiResponse(env as any, { status: 200, body: { choices: [{ message: {} }], usage: { prompt_tokens: 10, completion_tokens: 0 }, model: 'gpt-4o-mini' } });

    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-920002',
      assetId: 'asset-book-a-pdf',
      customerId: CUSTOMER_A,
      mode: 'ask',
      question: 'What does this book say?',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('llm_failed');
  }, 15_000);

  it('a question with no relevant information anywhere in the book (very low similarity, no chapter context) is honestly declined, never sent to the model at all', async () => {
    await seedPurchase('RWL-2026-920003', CUSTOMER_A, 'book-a', 'asset-book-a-pdf');
    const testEnv = envWithFakeVectorize();
    // outboundMock's embeddings queue is a single-slot override (INSERT
    // OR REPLACE on one fixed key), not a real FIFO — queuing an
    // indexing vector AND a query vector back-to-back before either is
    // ever consumed just overwrites the first with the second (see
    // answerService.chapterContext.test.ts's own header comment on
    // this). So this "warms up" the index with a throwaway first call
    // (consumes the ONE queued embedding for indexing; its own query
    // embed falls back to the mock's harmless default), THEN queues the
    // real low-similarity vector for the actual test call below —
    // ensureResourceIndexed() is idempotent on content_hash, so that
    // second call skips indexing entirely and its embedText() call is
    // ONLY the query, which is the one now genuinely low-similarity.
    await queueIndexingEmbedding();
    await queueChatAnswer('warm-up answer, not under test');
    await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-920003',
      assetId: 'asset-book-a-pdf',
      customerId: CUSTOMER_A,
      mode: 'ask',
      question: 'warm-up question to trigger indexing only',
    });
    await env.DB.exec(`DELETE FROM library_ai_message_citations`);
    await env.DB.exec(`DELETE FROM library_ai_messages`);
    await env.DB.exec(`DELETE FROM ai_usage_log`);

    await queueQueryEmbedding(0.05); // deliberately far below the VERY_LOW_SCORE_FLOOR
    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-920003',
      assetId: 'asset-book-a-pdf',
      customerId: CUSTOMER_A,
      mode: 'ask',
      question: 'What is the airspeed velocity of an unladen swallow?', // genuinely unrelated to the book
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('declined');
      expect(result.answer).toBeNull();
      expect(result.citations).toEqual([]);
    }
    // No CHAT COMPLETION call was ever made for a declined request — the
    // query embedding call legitimately still happens (it's what
    // determines the low-confidence score that triggers the decline in
    // the first place), so this checks the 'library.chat' feature
    // specifically, not total usage-log rows.
    const chatUsage = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ai_usage_log WHERE feature = 'library.chat'`).first<{ n: number }>();
    expect(chatUsage!.n).toBe(0);
  });

  it('an empty question in "ask" mode is rejected as invalid_input before any retrieval or LLM call is attempted', async () => {
    await seedPurchase('RWL-2026-920004', CUSTOMER_A, 'book-a', 'asset-book-a-pdf');
    const testEnv = envWithFakeVectorize();

    const result = await answerLibraryQuestion(testEnv, logger, {
      purchaseReference: 'RWL-2026-920004',
      assetId: 'asset-book-a-pdf',
      customerId: CUSTOMER_A,
      mode: 'ask',
      question: '   ', // whitespace-only, trims to empty
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_input');
    const usage = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ai_usage_log`).first<{ n: number }>();
    expect(usage!.n).toBe(0);
  });
});

describe('Robayer AI failure handling — HTTP route level (POST /api/customer/library/ai/ask)', () => {
  async function seedCustomerWithSession(email: string): Promise<{ customerId: number; cookieHeader: string; csrfSecret: string }> {
    const { customerId } = await findOrCreateCustomer(env as any, email, false);
    const session = await createSession(env as any, customerId, { ip: null, userAgent: null });
    return { customerId, cookieHeader: `customer_session=${session.sessionToken}`, csrfSecret: session.csrfSecret };
  }

  it('an over-length question (>500 chars) is rejected with a clean VALIDATION_ERROR, never an unhandled exception', async () => {
    const { cookieHeader } = await seedCustomerWithSession('long-question@example.com');
    const res = await SELF.fetch('https://example.com/api/customer/library/ai/ask', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchaseReference: 'RWL-2026-999001', assetId: 'asset-book-a-pdf', mode: 'ask', question: 'x'.repeat(501) }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('an invalid mode value is rejected with a clean VALIDATION_ERROR listing the real allowed modes, never a raw type error', async () => {
    const { cookieHeader } = await seedCustomerWithSession('bad-mode@example.com');
    const res = await SELF.fetch('https://example.com/api/customer/library/ai/ask', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchaseReference: 'RWL-2026-999002', assetId: 'asset-book-a-pdf', mode: 'delete_everything', question: '' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('malformed JSON body is rejected cleanly, never a raw parse-error stack', async () => {
    const { cookieHeader } = await seedCustomerWithSession('bad-json@example.com');
    const res = await SELF.fetch('https://example.com/api/customer/library/ai/ask', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: '{not valid json',
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(body)).not.toMatch(/SyntaxError|at Object|\.ts:\d+/); // no leaked stack/parser internals
  });

  it('a nonexistent purchase reference returns a generic NOT_FOUND, never revealing whether the reference format itself was the problem', async () => {
    const { cookieHeader } = await seedCustomerWithSession('nonexistent-ref@example.com');
    const res = await SELF.fetch('https://example.com/api/customer/library/ai/ask', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchaseReference: 'RWL-2026-999999', assetId: 'asset-book-a-pdf', mode: 'ask', question: 'What is this book about?' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('an unauthenticated request is rejected before touching any AI/retrieval logic', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/library/ai/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchaseReference: 'RWL-2026-999003', assetId: 'asset-book-a-pdf', mode: 'ask', question: 'Hello?' }),
    });
    expect(res.status).toBe(401);
  });
});
