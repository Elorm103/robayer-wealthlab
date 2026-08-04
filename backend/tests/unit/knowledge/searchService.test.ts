/**
 * Unit tests: Knowledge Base search/retrieval — Version 5.0 Milestone 2.
 * Seeds knowledge_documents/knowledge_chunks directly in D1 (bypassing
 * the indexing orchestrator, which is already covered by
 * indexingService.test.ts) and upserts matching vectors straight into
 * the fake Vectorize index, so each test controls cosine similarity
 * precisely via a queued OpenAI embeddings response for the query.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createLogger } from '../../../utils/logger';
import { searchKnowledge } from '../../../services/knowledge/searchService';
import { queueOpenAiEmbeddingResponse } from '../../outboundMock';
import { createFakeVectorizeIndex } from '../../knowledgeTestHelpers';

const logger = createLogger('test-request-id', 'test');

function envWithFakeVectorize() {
  return { ...(env as any), KNOWLEDGE_INDEX: createFakeVectorizeIndex() };
}

/** Queues the exact query-embedding vector `embedText()` will receive for the next call. */
async function queueQueryVector(vector: number[]): Promise<void> {
  await queueOpenAiEmbeddingResponse(env as any, {
    status: 200,
    body: { data: [{ embedding: vector, index: 0 }], usage: { prompt_tokens: 5 }, model: 'text-embedding-3-small' },
  });
}

interface SeedDocOptions {
  documentKey: string;
  sourceType: 'blog_post' | 'resource' | 'product' | 'static_page' | 'cms_setting';
  title: string;
  sourceUrl: string;
  visibility?: 'public' | 'admin_only';
  dataClassification?: 'PRODUCTION' | 'INTERNAL' | 'DEVELOPMENT' | 'UNKNOWN';
  status?: 'pending' | 'indexed' | 'failed';
}

async function seedDocumentWithChunk(opts: SeedDocOptions, vectorId: string, chunkText: string, vectorValues: number[], testEnv: ReturnType<typeof envWithFakeVectorize>): Promise<number> {
  const docInsert = await env.DB.prepare(
    `INSERT INTO knowledge_documents (document_key, source_type, source_id, source_url, title, visibility, data_classification, content_hash, status, chunk_count, version)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 'hash', ?, 1, 1)`
  )
    .bind(opts.documentKey, opts.sourceType, opts.sourceUrl, opts.title, opts.visibility ?? 'public', opts.dataClassification ?? 'PRODUCTION', opts.status ?? 'indexed')
    .run();
  const documentId = Number(docInsert.meta.last_row_id);

  await env.DB.prepare(`INSERT INTO knowledge_chunks (document_id, chunk_index, chunk_text, chunk_tokens, vector_id, embedding_model) VALUES (?, 0, ?, 10, ?, 'text-embedding-3-small')`)
    .bind(documentId, chunkText, vectorId)
    .run();

  await testEnv.KNOWLEDGE_INDEX.upsert([{ id: vectorId, values: vectorValues, metadata: { documentId, sourceType: opts.sourceType, sourceUrl: opts.sourceUrl } }]);

  return documentId;
}

describe('searchKnowledge', () => {
  beforeEach(async () => {
    // Version 5.0 Milestone 2.2 added knowledge_search_log.top_document_id
    // as a foreign key into knowledge_documents — search_log must be
    // cleared BEFORE knowledge_documents, or a prior test's logged row
    // referencing a soon-to-be-deleted document blocks the delete.
    await env.DB.exec('DELETE FROM knowledge_search_log');
    await env.DB.exec('DELETE FROM knowledge_chunks');
    await env.DB.exec('DELETE FROM knowledge_faqs');
    await env.DB.exec('DELETE FROM knowledge_documents');
  });

  it('embeds the query, matches against Vectorize, and returns a cited, high-confidence result', async () => {
    const testEnv = envWithFakeVectorize();
    const documentId = await seedDocumentWithChunk(
      { documentKey: 'blog_post:1', sourceType: 'blog_post', title: 'Treasury Bills Guide', sourceUrl: 'https://robayerwealthlab.com/blog/treasury-bills/' },
      'vec-1',
      'Treasury bills are short-term government securities.',
      [1, 0, 0, 0, 0, 0, 0, 0],
      testEnv
    );
    await queueQueryVector([1, 0, 0, 0, 0, 0, 0, 0]); // identical to the stored vector — cosine similarity 1.0

    const response = await searchKnowledge(testEnv, logger, { query: 'treasury bills', actorType: 'customer', actorId: null });

    expect(response.results).toHaveLength(1);
    expect(response.results[0].documentId).toBe(documentId);
    expect(response.results[0].sourceType).toBe('blog_post');
    expect(response.results[0].sourceTitle).toBe('Treasury Bills Guide');
    expect(response.results[0].sourceUrl).toBe('https://robayerwealthlab.com/blog/treasury-bills/');
    expect(response.results[0].chunkText).toContain('Treasury bills');
    expect(response.results[0].score).toBeCloseTo(1, 5);
    expect(response.results[0].confidence).toBe('high');
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);

    const logRow = await env.DB.prepare(`SELECT * FROM knowledge_search_log ORDER BY id DESC LIMIT 1`).first<{
      query_text: string;
      actor_type: string;
      actor_id: number | null;
      visibility_scope: string;
      result_count: number;
      top_score: number;
    }>();
    expect(logRow!.query_text).toBe('treasury bills');
    expect(logRow!.actor_type).toBe('customer');
    expect(logRow!.actor_id).toBeNull();
    expect(logRow!.visibility_scope).toBe('public');
    expect(logRow!.result_count).toBe(1);
    expect(logRow!.top_score).toBeCloseTo(1, 5);
  });

  it('defaults to public visibility and excludes admin_only documents unless explicitly requested', async () => {
    const testEnv = envWithFakeVectorize();
    await seedDocumentWithChunk(
      { documentKey: 'blog_post:2', sourceType: 'blog_post', title: 'Public Post', sourceUrl: 'https://robayerwealthlab.com/blog/public-post/', visibility: 'public' },
      'vec-public',
      'Public content about saving money.',
      [1, 0, 0, 0, 0, 0, 0, 0],
      testEnv
    );
    await seedDocumentWithChunk(
      { documentKey: 'static_page:/internal/sop/', sourceType: 'static_page', title: 'Internal SOP', sourceUrl: 'https://robayerwealthlab.com/internal/sop/', visibility: 'admin_only' },
      'vec-admin',
      'Internal admin-only procedure text.',
      [1, 0, 0, 0, 0, 0, 0, 0],
      testEnv
    );

    await queueQueryVector([1, 0, 0, 0, 0, 0, 0, 0]);
    const publicResponse = await searchKnowledge(testEnv, logger, { query: 'saving procedure', actorType: 'customer', actorId: null });
    expect(publicResponse.results).toHaveLength(1);
    expect(publicResponse.results[0].sourceTitle).toBe('Public Post');

    await queueQueryVector([1, 0, 0, 0, 0, 0, 0, 0]);
    const adminResponse = await searchKnowledge(testEnv, logger, { query: 'saving procedure', actorType: 'admin', actorId: 1, visibility: 'admin_only' });
    expect(adminResponse.results).toHaveLength(1);
    expect(adminResponse.results[0].sourceTitle).toBe('Internal SOP');
  });

  it('excludes documents whose data_classification is not PRODUCTION, even on a strong vector match', async () => {
    const testEnv = envWithFakeVectorize();
    await seedDocumentWithChunk(
      { documentKey: 'static_page:/staging/draft/', sourceType: 'static_page', title: 'Draft Page', sourceUrl: 'https://robayerwealthlab.com/staging/draft/', dataClassification: 'DEVELOPMENT' },
      'vec-dev',
      'Draft content not yet ready for production.',
      [1, 0, 0, 0, 0, 0, 0, 0],
      testEnv
    );
    await queueQueryVector([1, 0, 0, 0, 0, 0, 0, 0]);

    const response = await searchKnowledge(testEnv, logger, { query: 'draft content', actorType: 'customer', actorId: null });
    expect(response.results).toHaveLength(0);
  });

  it('filters by sourceTypes when requested', async () => {
    const testEnv = envWithFakeVectorize();
    await seedDocumentWithChunk(
      { documentKey: 'blog_post:3', sourceType: 'blog_post', title: 'Blog Match', sourceUrl: 'https://robayerwealthlab.com/blog/match/' },
      'vec-blog',
      'Blog content about budgeting.',
      [1, 0, 0, 0, 0, 0, 0, 0],
      testEnv
    );
    await seedDocumentWithChunk(
      { documentKey: 'resource:1', sourceType: 'resource', title: 'Resource Match', sourceUrl: 'https://robayerwealthlab.com/resources/#budget-planner' },
      'vec-resource',
      'A downloadable budgeting template.',
      [1, 0, 0, 0, 0, 0, 0, 0],
      testEnv
    );
    await queueQueryVector([1, 0, 0, 0, 0, 0, 0, 0]);

    const response = await searchKnowledge(testEnv, logger, { query: 'budgeting', actorType: 'customer', actorId: null, sourceTypes: ['resource'] });
    expect(response.results).toHaveLength(1);
    expect(response.results[0].sourceType).toBe('resource');
    expect(response.results[0].sourceTitle).toBe('Resource Match');
  });

  it('buckets results into high/medium/low confidence by final (boosted) score, ranked descending', async () => {
    // Version 5.0 Milestone 2.2 thresholds: high >= 0.6, medium >= 0.45,
    // low below — see services/knowledge/ranking.ts. Titles/chunk text
    // here deliberately share no tokens with the query so each
    // document's final score equals its raw cosine similarity (no
    // boost), keeping this test about bucketing/ordering, not reranking
    // (that's covered by its own test below).
    const testEnv = envWithFakeVectorize();
    await seedDocumentWithChunk(
      { documentKey: 'blog_post:4', sourceType: 'blog_post', title: 'High Match', sourceUrl: 'https://robayerwealthlab.com/blog/high/' },
      'vec-high',
      'An extremely applicable chunk.',
      [1, 0, 0, 0, 0, 0, 0, 0], // cosine 1.0 -> high
      testEnv
    );
    await seedDocumentWithChunk(
      { documentKey: 'blog_post:5', sourceType: 'blog_post', title: 'Medium Match', sourceUrl: 'https://robayerwealthlab.com/blog/medium/' },
      'vec-medium',
      'A somewhat applicable chunk.',
      [0.5, Math.sqrt(1 - 0.25), 0, 0, 0, 0, 0, 0], // cosine 0.5 -> medium
      testEnv
    );
    await seedDocumentWithChunk(
      { documentKey: 'blog_post:6', sourceType: 'blog_post', title: 'Low Match', sourceUrl: 'https://robayerwealthlab.com/blog/low/' },
      'vec-low',
      'A barely applicable chunk.',
      [0.3, Math.sqrt(1 - 0.09), 0, 0, 0, 0, 0, 0], // cosine 0.3 -> low
      testEnv
    );
    await queueQueryVector([1, 0, 0, 0, 0, 0, 0, 0]);

    const response = await searchKnowledge(testEnv, logger, { query: 'zzyzx qorvath', actorType: 'customer', actorId: null, limit: 3 });
    expect(response.results).toHaveLength(3);
    expect(response.results[0].sourceTitle).toBe('High Match');
    expect(response.results[0].confidence).toBe('high');
    expect(response.results[1].sourceTitle).toBe('Medium Match');
    expect(response.results[1].confidence).toBe('medium');
    expect(response.results[2].sourceTitle).toBe('Low Match');
    expect(response.results[2].confidence).toBe('low');
    // Strictly descending by score.
    expect(response.results[0].score).toBeGreaterThan(response.results[1].score);
    expect(response.results[1].score).toBeGreaterThan(response.results[2].score);
  });

  it('reranks a lower-cosine, exact-title-match result above a higher-cosine, no-title-overlap result', async () => {
    // Direct coverage for Task 2's real purpose: production evidence
    // showed raw cosine similarity alone does not reliably rank an
    // exact title match first — see ranking.ts's header comment.
    const testEnv = envWithFakeVectorize();
    await seedDocumentWithChunk(
      { documentKey: 'static_page:/legal/privacy-policy/', sourceType: 'static_page', title: 'Privacy Policy | Robayer WealthLab', sourceUrl: 'https://robayerwealthlab.com/legal/privacy-policy/' },
      'vec-exact-title',
      'How Robayer WealthLab collects, uses, stores, and protects your privacy policy information.',
      [0.5, Math.sqrt(1 - 0.25), 0, 0, 0, 0, 0, 0], // cosine 0.5 alone — lower than the unrelated page below
      testEnv
    );
    await seedDocumentWithChunk(
      { documentKey: 'static_page:/about/', sourceType: 'static_page', title: 'About Us | Robayer WealthLab', sourceUrl: 'https://robayerwealthlab.com/about/' },
      'vec-higher-cosine-no-title',
      'General information about the company with no mention of the query topic.',
      [0.62, Math.sqrt(1 - 0.62 * 0.62), 0, 0, 0, 0, 0, 0], // cosine 0.62 — higher raw similarity, but no title/keyword overlap
      testEnv
    );
    await queueQueryVector([1, 0, 0, 0, 0, 0, 0, 0]);

    const response = await searchKnowledge(testEnv, logger, { query: 'What does the Privacy Policy say?', actorType: 'customer', actorId: null });

    expect(response.results).toHaveLength(2);
    expect(response.results[0].sourceTitle).toBe('Privacy Policy | Robayer WealthLab');
    expect(response.results[0].titleBoost).toBeGreaterThan(0);
    expect(response.results[0].keywordBoost).toBeGreaterThan(0);
    expect(response.results[0].vectorSimilarity).toBeLessThan(response.results[1].vectorSimilarity); // raw cosine alone would have ranked these the other way
    expect(response.results[0].score).toBeGreaterThan(response.results[1].score); // the blended score correctly reverses that
  });

  it('writes top_document_id to knowledge_search_log for the #1 result', async () => {
    const testEnv = envWithFakeVectorize();
    const documentId = await seedDocumentWithChunk(
      { documentKey: 'blog_post:7', sourceType: 'blog_post', title: 'Top Doc', sourceUrl: 'https://robayerwealthlab.com/blog/top-doc/' },
      'vec-topdoc',
      'Content for the top-document logging test.',
      [1, 0, 0, 0, 0, 0, 0, 0],
      testEnv
    );
    await queueQueryVector([1, 0, 0, 0, 0, 0, 0, 0]);

    await searchKnowledge(testEnv, logger, { query: 'top document logging', actorType: 'customer', actorId: null });

    const logRow = await env.DB.prepare(`SELECT top_document_id FROM knowledge_search_log ORDER BY id DESC LIMIT 1`).first<{ top_document_id: number | null }>();
    expect(logRow!.top_document_id).toBe(documentId);
  });

  it('still writes a knowledge_search_log row (with zero results and a null top_document_id) when nothing matches', async () => {
    const testEnv = envWithFakeVectorize();
    await queueQueryVector([1, 0, 0, 0, 0, 0, 0, 0]);

    const response = await searchKnowledge(testEnv, logger, { query: 'nothing indexed yet', actorType: 'system', actorId: null });
    expect(response.results).toHaveLength(0);

    const logRow = await env.DB.prepare(`SELECT result_count, top_score, top_document_id FROM knowledge_search_log ORDER BY id DESC LIMIT 1`).first<{
      result_count: number;
      top_score: number | null;
      top_document_id: number | null;
    }>();
    expect(logRow!.result_count).toBe(0);
    expect(logRow!.top_score).toBeNull();
    expect(logRow!.top_document_id).toBeNull();
  });
});
