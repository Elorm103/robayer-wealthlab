/**
 * Unit tests: Knowledge Base indexing orchestrator — Version 5.0
 * Milestone 2. Uses the fake in-memory Vectorize index
 * (tests/knowledgeTestHelpers.ts) since Miniflare has no local
 * Vectorize simulation, and an empty sitemap.xml (queued via
 * outboundMock) so only the one deliberately-seeded blog post is a
 * real document — full control over assertions, no incidental noise
 * from the static-page crawl's own default mock page.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createLogger } from '../../../utils/logger';
import { runIncrementalIndex, runFullRebuild } from '../../../services/knowledge/indexingService';
import { queueSitemapResponse, queueOpenAiEmbeddingResponse } from '../../outboundMock';
import { createFakeVectorizeIndex } from '../../knowledgeTestHelpers';

const logger = createLogger('test-request-id', 'test');
const EMPTY_SITEMAP = `<?xml version="1.0"?><urlset></urlset>`;

async function seedPublishedBlogPost(slug: string, body: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO blog_posts (post_id, slug, title, excerpt, body, category, status) VALUES (?, ?, 'Test Post', 'An excerpt', ?, 'investing', 'published')`)
    .bind(`post-${slug}`, slug, body)
    .run();
}

function envWithFakeVectorize() {
  return { ...(env as any), KNOWLEDGE_INDEX: createFakeVectorizeIndex() };
}

describe('indexingService', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM knowledge_chunks');
    await env.DB.exec('DELETE FROM knowledge_faqs');
    await env.DB.exec('DELETE FROM knowledge_documents');
    await env.DB.exec('DELETE FROM knowledge_indexing_runs');
    await env.DB.exec('DELETE FROM blog_posts');
    await env.DB.exec('DELETE FROM resources');
    await env.DB.exec('DELETE FROM ai_usage_log');
    await env.DB.prepare(`DELETE FROM products WHERE slug = 'not-used-here'`).run();
    await queueSitemapResponse(env as any, EMPTY_SITEMAP);
  });

  it('indexes a real seeded blog post end-to-end: chunks, embeds, upserts to Vectorize, and marks the document indexed', async () => {
    await seedPublishedBlogPost('test-post', '<p>Treasury bills are a common first investment in Ghana.</p>');
    const testEnv = envWithFakeVectorize();

    const summary = await runIncrementalIndex(testEnv, logger, null);

    expect(summary.documentsSeen).toBe(1);
    expect(summary.documentsIndexed).toBe(1);
    expect(summary.documentsFailed).toBe(0);
    expect(summary.chunksCreated).toBeGreaterThan(0);

    const doc = await env.DB.prepare(`SELECT * FROM knowledge_documents WHERE document_key LIKE 'blog_post:%'`).first<{ status: string; chunk_count: number; version: number }>();
    expect(doc!.status).toBe('indexed');
    expect(doc!.chunk_count).toBeGreaterThan(0);
    expect(doc!.version).toBe(1);

    expect(testEnv.KNOWLEDGE_INDEX._size()).toBe(doc!.chunk_count);

    const run = await env.DB.prepare(`SELECT * FROM knowledge_indexing_runs ORDER BY id DESC LIMIT 1`).first<{ status: string; run_type: string }>();
    expect(run!.status).toBe('completed');
    expect(run!.run_type).toBe('incremental');
  });

  it('batches embedding calls across multiple documents into a single provider call, rather than one call per document', async () => {
    // Regression test for a real production incident: a per-document embed
    // call caused a full-catalog run to exceed Cloudflare's per-invocation
    // subrequest limit (see indexingService.ts's header comment and the
    // Milestone 2 Production Verification Report). Two small documents
    // together produce well under EMBED_BATCH_SIZE (96) chunks, so both
    // should be covered by exactly one ai_usage_log row for
    // 'knowledge.embed' — not two.
    await seedPublishedBlogPost('batch-post-one', '<p>Treasury bills are a common first investment in Ghana.</p>');
    await env.DB.prepare(
      `INSERT INTO resources (resource_id, slug, title, short_description, description, category, format, status) VALUES ('batch-r1','batch-resource','Batch Resource','A short template','<p>Some resource content for batching.</p>','budgeting','template','published')`
    ).run();
    const testEnv = envWithFakeVectorize();

    const summary = await runIncrementalIndex(testEnv, logger, null);
    expect(summary.documentsSeen).toBe(2);
    expect(summary.documentsIndexed).toBe(2);
    expect(summary.documentsFailed).toBe(0);

    const embedCallCount = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ai_usage_log WHERE feature = 'knowledge.embed'`).first<{ count: number }>();
    expect(embedCallCount!.count).toBe(1);
  });

  it('incremental indexing skips a document whose content has not changed since the last successful index', async () => {
    await seedPublishedBlogPost('unchanged-post', '<p>Stable content that never changes.</p>');
    const testEnv = envWithFakeVectorize();

    const first = await runIncrementalIndex(testEnv, logger, null);
    expect(first.documentsIndexed).toBe(1);

    await queueSitemapResponse(env as any, EMPTY_SITEMAP); // sitemap fetch is one-shot consumed
    const second = await runIncrementalIndex(testEnv, logger, null);
    expect(second.documentsIndexed).toBe(0);
    expect(second.documentsUnchanged).toBe(1);
  });

  it('incremental indexing re-processes a document whose content DID change, replacing old chunks/vectors', async () => {
    await seedPublishedBlogPost('changing-post', '<p>Original content about savings.</p>');
    const testEnv = envWithFakeVectorize();
    await runIncrementalIndex(testEnv, logger, null);

    const before = await env.DB.prepare(`SELECT id, chunk_count FROM knowledge_documents WHERE document_key LIKE 'blog_post:%'`).first<{ id: number; chunk_count: number }>();
    const oldVectorIds = (await env.DB.prepare(`SELECT vector_id FROM knowledge_chunks WHERE document_id = ?`).bind(before!.id).all<{ vector_id: string }>()).results.map((r) => r.vector_id);

    await env.DB.prepare(`UPDATE blog_posts SET body = '<p>Completely different content about investing in the Ghana Stock Exchange, much longer than before.</p>' WHERE slug = 'changing-post'`).run();
    await queueSitemapResponse(env as any, EMPTY_SITEMAP);

    const second = await runIncrementalIndex(testEnv, logger, null);
    expect(second.documentsIndexed).toBe(1);
    expect(second.documentsUnchanged).toBe(0);

    const after = await env.DB.prepare(`SELECT version FROM knowledge_documents WHERE id = ?`).bind(before!.id).first<{ version: number }>();
    expect(after!.version).toBe(2);

    // Old vectors were cleaned up from Vectorize — none of the original ids remain.
    for (const oldId of oldVectorIds) {
      const still = await testEnv.KNOWLEDGE_INDEX.getByIds([oldId]);
      expect(still).toHaveLength(0);
    }
  });

  it('full rebuild re-processes a document even when its content is unchanged', async () => {
    await seedPublishedBlogPost('stable-post', '<p>Content that will not change between runs.</p>');
    const testEnv = envWithFakeVectorize();
    await runIncrementalIndex(testEnv, logger, null);

    const adminInsert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES ('kb-admin@robayerwealthlab.com', 'x:1:x', 'super_admin', 1)`).run();
    const adminId = Number(adminInsert.meta.last_row_id);

    await queueSitemapResponse(env as any, EMPTY_SITEMAP);
    const rebuild = await runFullRebuild(testEnv, logger, adminId);
    expect(rebuild.documentsIndexed).toBe(1);
    expect(rebuild.documentsUnchanged).toBe(0);

    const run = await env.DB.prepare(`SELECT run_type, trigger_type, triggered_by FROM knowledge_indexing_runs ORDER BY id DESC LIMIT 1`).first<{
      run_type: string;
      trigger_type: string;
      triggered_by: number;
    }>();
    expect(run!.run_type).toBe('full_rebuild');
    expect(run!.triggered_by).toBe(adminId);
  });

  it('marks a document failed (without aborting the whole run) when embedding fails, and records why', async () => {
    await seedPublishedBlogPost('embed-fails-post', '<p>Content that will fail to embed in this test.</p>');
    await queueOpenAiEmbeddingResponse(env as any, { status: 500, body: { error: { message: 'mock embedding provider outage' } } });
    const testEnv = envWithFakeVectorize();

    const summary = await runIncrementalIndex(testEnv, logger, null);
    expect(summary.documentsFailed).toBe(1);
    expect(summary.documentsIndexed).toBe(0);

    const doc = await env.DB.prepare(`SELECT status, error_message FROM knowledge_documents WHERE document_key LIKE 'blog_post:%'`).first<{ status: string; error_message: string }>();
    expect(doc!.status).toBe('failed');
    expect(doc!.error_message).toContain('Embedding failed');
  });
});
