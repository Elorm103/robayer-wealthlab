/**
 * Unit tests: Knowledge Base indexing orchestrator — Version 5.0
 * Milestone 2.1 (plan + queue-consumer architecture; see
 * indexingService.ts's header comment for why this replaced Milestone
 * 2's single-invocation design).
 *
 * planIncrementalIndex/planFullRebuild are tested directly against D1
 * (they only gather/hash-compare/enqueue — no embedding happens here).
 * processIndexingQueueBatch is tested directly with hand-built
 * KnowledgeIndexQueueMessage bodies, bypassing the real Cloudflare
 * Queue transport — the message shape is exactly what planning would
 * have produced (reconstructed here via the same real document-source
 * readers and chunkText(), not duplicated logic), so this exercises the
 * genuine consumer code path deterministically. The real queue
 * transport itself (Cloudflare Queues' own delivery/retry mechanism) is
 * Cloudflare's tested infrastructure, not this project's code, and is
 * verified for real in production as part of Milestone 2.1's
 * verification report.
 *
 * Uses the fake in-memory Vectorize index (tests/knowledgeTestHelpers.ts)
 * since Miniflare has no local Vectorize simulation, and an empty
 * sitemap.xml (queued via outboundMock) so only deliberately-seeded
 * documents are real — full control over assertions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createLogger } from '../../../utils/logger';
import { planIncrementalIndex, planFullRebuild, processIndexingQueueBatch } from '../../../services/knowledge/indexingService';
import { getBlogPostDocuments } from '../../../services/knowledge/documentSources';
import { chunkText } from '../../../services/knowledge/chunking';
import { queueSitemapResponse, queueOpenAiEmbeddingResponse } from '../../outboundMock';
import { createFakeVectorizeIndex, type FakeVectorizeOptions } from '../../knowledgeTestHelpers';
import type { KnowledgeIndexQueueMessage } from '../../../services/knowledge/queueTypes';

const logger = createLogger('test-request-id', 'test');
const EMPTY_SITEMAP = `<?xml version="1.0"?><urlset></urlset>`;

async function seedPublishedBlogPost(slug: string, body: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO blog_posts (post_id, slug, title, excerpt, body, category, status) VALUES (?, ?, 'Test Post', 'An excerpt', ?, 'investing', 'published')`)
    .bind(`post-${slug}`, slug, body)
    .run();
}

function envWithFakeVectorize(options?: FakeVectorizeOptions) {
  return { ...(env as any), KNOWLEDGE_INDEX: createFakeVectorizeIndex(options) };
}

/** Reconstructs the exact queue message planning would have produced for the ONE blog post currently in D1 — real reader, real chunker, not duplicated logic. */
async function buildBlogPostMessage(runId: number, documentId: number, contentHash: string, wasPreExisting: boolean): Promise<KnowledgeIndexQueueMessage> {
  const [doc] = await getBlogPostDocuments(env as any);
  const chunks = chunkText(doc.text);
  return {
    runId,
    documentId,
    contentHash,
    wasPreExisting,
    documentKey: doc.documentKey,
    sourceType: doc.sourceType,
    sourceId: doc.sourceId,
    sourceUrl: doc.url,
    title: doc.title,
    dataClassification: doc.dataClassification,
    faqs: doc.faqs,
    chunks,
  };
}

async function getPendingDocument() {
  return env.DB.prepare(`SELECT * FROM knowledge_documents WHERE status = 'pending' ORDER BY id DESC LIMIT 1`).first<{ id: number; document_key: string; content_hash: string }>();
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

  describe('planIncrementalIndex / planFullRebuild (planning phase)', () => {
    it('enqueues a real seeded blog post: creates a pending document row and a running, correctly-counted run', async () => {
      await seedPublishedBlogPost('test-post', '<p>Treasury bills are a common first investment in Ghana.</p>');

      const summary = await planIncrementalIndex(env as any, logger, null);
      expect(summary.documentsSeen).toBe(1);
      expect(summary.documentsUnchanged).toBe(0);
      expect(summary.documentsFailedAtPlanning).toBe(0);
      expect(summary.documentsEnqueued).toBe(1);

      const doc = await getPendingDocument();
      expect(doc!.document_key).toMatch(/^blog_post:\d+$/);

      const run = await env.DB.prepare(`SELECT status, run_type, documents_enqueued, documents_resolved FROM knowledge_indexing_runs WHERE id = ?`).bind(summary.runId).first<{
        status: string;
        run_type: string;
        documents_enqueued: number;
        documents_resolved: number;
      }>();
      expect(run!.status).toBe('running');
      expect(run!.run_type).toBe('incremental');
      expect(run!.documents_enqueued).toBe(1);
      expect(run!.documents_resolved).toBe(0);
    });

    it('completes a run immediately, with nothing enqueued, when a second incremental plan finds no changes', async () => {
      await seedPublishedBlogPost('unchanged-post', '<p>Stable content that never changes.</p>');
      const testEnv = envWithFakeVectorize();

      const plan1 = await planIncrementalIndex(testEnv, logger, null);
      const pending = await getPendingDocument();
      const msg = await buildBlogPostMessage(plan1.runId, pending!.id, pending!.content_hash, false);
      await processIndexingQueueBatch(testEnv, logger, [msg]);

      await queueSitemapResponse(env as any, EMPTY_SITEMAP);
      const plan2 = await planIncrementalIndex(testEnv, logger, null);
      expect(plan2.documentsUnchanged).toBe(1);
      expect(plan2.documentsEnqueued).toBe(0);

      const run2 = await env.DB.prepare(`SELECT status FROM knowledge_indexing_runs WHERE id = ?`).bind(plan2.runId).first<{ status: string }>();
      expect(run2!.status).toBe('completed');
    });
  });

  describe('processIndexingQueueBatch (consumer phase)', () => {
    it('finalizes a single-document batch end-to-end: embeds, upserts to Vectorize, marks indexed, and resolves the run to completed', async () => {
      await seedPublishedBlogPost('test-post', '<p>Treasury bills are a common first investment in Ghana.</p>');
      const testEnv = envWithFakeVectorize();

      const plan = await planIncrementalIndex(testEnv, logger, null);
      const pending = await getPendingDocument();
      const msg = await buildBlogPostMessage(plan.runId, pending!.id, pending!.content_hash, false);

      await processIndexingQueueBatch(testEnv, logger, [msg]);

      const doc = await env.DB.prepare(`SELECT status, chunk_count, version FROM knowledge_documents WHERE id = ?`).bind(pending!.id).first<{ status: string; chunk_count: number; version: number }>();
      expect(doc!.status).toBe('indexed');
      expect(doc!.chunk_count).toBeGreaterThan(0);
      expect(doc!.version).toBe(1); // first-ever index — wasPreExisting: false — must not be double-incremented

      expect(testEnv.KNOWLEDGE_INDEX._size()).toBe(doc!.chunk_count);
      const chunkRows = await env.DB.prepare(`SELECT COUNT(*) AS count FROM knowledge_chunks WHERE document_id = ?`).bind(pending!.id).first<{ count: number }>();
      expect(chunkRows!.count).toBe(doc!.chunk_count);

      const run = await env.DB.prepare(`SELECT status, documents_indexed, documents_failed, documents_resolved, chunks_created FROM knowledge_indexing_runs WHERE id = ?`).bind(plan.runId).first<{
        status: string;
        documents_indexed: number;
        documents_failed: number;
        documents_resolved: number;
        chunks_created: number;
      }>();
      expect(run!.status).toBe('completed');
      expect(run!.documents_indexed).toBe(1);
      expect(run!.documents_failed).toBe(0);
      expect(run!.documents_resolved).toBe(1);
      expect(run!.chunks_created).toBe(doc!.chunk_count);
    });

    it('batches both embedding calls AND Vectorize upserts across every document in ONE queue batch into a single call each', async () => {
      // Direct regression coverage for TWO real production incidents:
      // (1) per-document embed calls exceeding the Worker subrequest
      // budget, fixed by batching embed calls per queue batch; (2) even
      // after that fix, per-document Vectorize upsert() calls still hit
      // VECTOR_UPSERT_ERROR 40014 ("Too Many Requests") under concurrent
      // consumer invocations — fixed by combining every document's
      // vectors in one batch into a single upsert() call too. See
      // indexingService.ts's header comment for both incidents.
      await seedPublishedBlogPost('batch-post', '<p>Treasury bills are a common first investment in Ghana.</p>');
      await env.DB.prepare(
        `INSERT INTO resources (resource_id, slug, title, short_description, description, category, format, status) VALUES ('batch-r1','batch-resource','Batch Resource','A short template','<p>Some resource content for batching.</p>','budgeting','template','published')`
      ).run();
      const testEnv = envWithFakeVectorize();

      const plan = await planIncrementalIndex(testEnv, logger, null);
      expect(plan.documentsEnqueued).toBe(2);

      const pendingRows = (await env.DB.prepare(`SELECT id, document_key, content_hash FROM knowledge_documents WHERE status = 'pending' ORDER BY id`).all<{ id: number; document_key: string; content_hash: string }>()).results;
      expect(pendingRows).toHaveLength(2);

      const blogMsg = await buildBlogPostMessage(plan.runId, pendingRows.find((r) => r.document_key.startsWith('blog_post:'))!.id, pendingRows.find((r) => r.document_key.startsWith('blog_post:'))!.content_hash, false);
      const resourceRow = pendingRows.find((r) => r.document_key.startsWith('resource:'))!;
      const resourceMsg: KnowledgeIndexQueueMessage = {
        runId: plan.runId,
        documentId: resourceRow.id,
        contentHash: resourceRow.content_hash,
        wasPreExisting: false,
        documentKey: resourceRow.document_key,
        sourceType: 'resource',
        sourceId: null,
        sourceUrl: 'https://robayerwealthlab.com/resources/#batch-resource',
        title: 'Batch Resource',
        dataClassification: 'PRODUCTION',
        faqs: [],
        chunks: chunkText('A short template\n\nSome resource content for batching.'),
      };

      await processIndexingQueueBatch(testEnv, logger, [blogMsg, resourceMsg]);

      const run = await env.DB.prepare(`SELECT status, documents_indexed, documents_resolved FROM knowledge_indexing_runs WHERE id = ?`).bind(plan.runId).first<{
        status: string;
        documents_indexed: number;
        documents_resolved: number;
      }>();
      expect(run!.status).toBe('completed');
      expect(run!.documents_indexed).toBe(2);
      expect(run!.documents_resolved).toBe(2);

      const embedCallCount = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ai_usage_log WHERE feature = 'knowledge.embed'`).first<{ count: number }>();
      expect(embedCallCount!.count).toBe(1);
      expect(testEnv.KNOWLEDGE_INDEX._upsertCallCount()).toBe(1);
    });

    it('re-processes a document whose content changed: bumps version and cleans up old vectors, without aborting the run', async () => {
      await seedPublishedBlogPost('changing-post', '<p>Original content about savings.</p>');
      const testEnv = envWithFakeVectorize();

      const plan1 = await planIncrementalIndex(testEnv, logger, null);
      const pending1 = await getPendingDocument();
      const msg1 = await buildBlogPostMessage(plan1.runId, pending1!.id, pending1!.content_hash, false);
      await processIndexingQueueBatch(testEnv, logger, [msg1]);

      const oldVectorIds = (await env.DB.prepare(`SELECT vector_id FROM knowledge_chunks WHERE document_id = ?`).bind(pending1!.id).all<{ vector_id: string }>()).results.map((r) => r.vector_id);

      await env.DB.prepare(`UPDATE blog_posts SET body = '<p>Completely different content about investing in the Ghana Stock Exchange, much longer than before.</p>' WHERE slug = 'changing-post'`).run();
      await queueSitemapResponse(env as any, EMPTY_SITEMAP);

      const plan2 = await planIncrementalIndex(testEnv, logger, null);
      expect(plan2.documentsEnqueued).toBe(1);
      expect(plan2.documentsUnchanged).toBe(0);

      const pending2 = await env.DB.prepare(`SELECT id, content_hash FROM knowledge_documents WHERE id = ?`).bind(pending1!.id).first<{ id: number; content_hash: string }>();
      const msg2 = await buildBlogPostMessage(plan2.runId, pending2!.id, pending2!.content_hash, true);
      await processIndexingQueueBatch(testEnv, logger, [msg2]);

      const after = await env.DB.prepare(`SELECT version, status FROM knowledge_documents WHERE id = ?`).bind(pending1!.id).first<{ version: number; status: string }>();
      expect(after!.status).toBe('indexed');
      expect(after!.version).toBe(2);

      for (const oldId of oldVectorIds) {
        const still = await testEnv.KNOWLEDGE_INDEX.getByIds([oldId]);
        expect(still).toHaveLength(0);
      }
    });

    it('full rebuild re-enqueues a document even when its content is unchanged', async () => {
      await seedPublishedBlogPost('stable-post', '<p>Content that will not change between runs.</p>');
      const testEnv = envWithFakeVectorize();

      const plan1 = await planIncrementalIndex(testEnv, logger, null);
      const pending1 = await getPendingDocument();
      const msg1 = await buildBlogPostMessage(plan1.runId, pending1!.id, pending1!.content_hash, false);
      await processIndexingQueueBatch(testEnv, logger, [msg1]);

      const adminInsert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES ('kb-admin@robayerwealthlab.com', 'x:1:x', 'super_admin', 1)`).run();
      const adminId = Number(adminInsert.meta.last_row_id);

      await queueSitemapResponse(env as any, EMPTY_SITEMAP);
      const rebuildPlan = await planFullRebuild(testEnv, logger, adminId);
      expect(rebuildPlan.documentsEnqueued).toBe(1);
      expect(rebuildPlan.documentsUnchanged).toBe(0);

      const run = await env.DB.prepare(`SELECT run_type, trigger_type, triggered_by FROM knowledge_indexing_runs WHERE id = ?`).bind(rebuildPlan.runId).first<{
        run_type: string;
        trigger_type: string;
        triggered_by: number;
      }>();
      expect(run!.run_type).toBe('full_rebuild');
      expect(run!.triggered_by).toBe(adminId);
    });

    it('marks every document in a batch failed — without losing the run — when the shared embedding call fails', async () => {
      // Documents that share one embed call also share its fate — the
      // accepted trade-off for cutting per-document provider calls (see
      // indexingService.ts's header comment on why fault isolation moved
      // from per-document to per-batch).
      await seedPublishedBlogPost('embed-fails-post', '<p>Content that will fail to embed in this test.</p>');
      const testEnv = envWithFakeVectorize();

      const plan = await planIncrementalIndex(testEnv, logger, null);
      const pending = await getPendingDocument();
      const msg = await buildBlogPostMessage(plan.runId, pending!.id, pending!.content_hash, false);

      await queueOpenAiEmbeddingResponse(env as any, { status: 500, body: { error: { message: 'mock embedding provider outage' } } });
      await processIndexingQueueBatch(testEnv, logger, [msg]);

      const doc = await env.DB.prepare(`SELECT status, error_message FROM knowledge_documents WHERE id = ?`).bind(pending!.id).first<{ status: string; error_message: string }>();
      expect(doc!.status).toBe('failed');
      expect(doc!.error_message).toContain('Embedding failed');

      const run = await env.DB.prepare(`SELECT status, documents_failed, documents_resolved FROM knowledge_indexing_runs WHERE id = ?`).bind(plan.runId).first<{
        status: string;
        documents_failed: number;
        documents_resolved: number;
      }>();
      expect(run!.status).toBe('completed'); // resolved (as failed) still counts toward completion — the run itself did not hang or crash
      expect(run!.documents_failed).toBe(1);
      expect(run!.documents_resolved).toBe(1);
    });

    it('retries a Vectorize upsert that fails with a rate-limit error (40014), and succeeds once the retry goes through', async () => {
      await seedPublishedBlogPost('rate-limited-post', '<p>Content whose first upsert attempt gets rate-limited.</p>');
      const testEnv = envWithFakeVectorize({ upsertFailures: [new Error('VECTOR_UPSERT_ERROR (40014): Too Many Requests')] });

      const plan = await planIncrementalIndex(testEnv, logger, null);
      const pending = await getPendingDocument();
      const msg = await buildBlogPostMessage(plan.runId, pending!.id, pending!.content_hash, false);

      await processIndexingQueueBatch(testEnv, logger, [msg]);

      const doc = await env.DB.prepare(`SELECT status FROM knowledge_documents WHERE id = ?`).bind(pending!.id).first<{ status: string }>();
      expect(doc!.status).toBe('indexed'); // the retry succeeded — a transient rate-limit must not permanently fail a good document

      expect(testEnv.KNOWLEDGE_INDEX._upsertCallCount()).toBe(2); // 1 failed attempt + 1 successful retry

      const run = await env.DB.prepare(`SELECT status, documents_indexed, documents_failed FROM knowledge_indexing_runs WHERE id = ?`).bind(plan.runId).first<{
        status: string;
        documents_indexed: number;
        documents_failed: number;
      }>();
      expect(run!.status).toBe('completed');
      expect(run!.documents_indexed).toBe(1);
      expect(run!.documents_failed).toBe(0);
    });

    it('does NOT retry a non-rate-limit Vectorize error — fails immediately since retrying would just fail identically', async () => {
      await seedPublishedBlogPost('bad-vector-post', '<p>Content whose upsert fails for a real, non-transient reason.</p>');
      const testEnv = envWithFakeVectorize({ upsertFailures: [new Error('VECTOR_INSERT_ERROR (40006): Vector dimensions do not match index configuration')] });

      const plan = await planIncrementalIndex(testEnv, logger, null);
      const pending = await getPendingDocument();
      const msg = await buildBlogPostMessage(plan.runId, pending!.id, pending!.content_hash, false);

      await processIndexingQueueBatch(testEnv, logger, [msg]);

      const doc = await env.DB.prepare(`SELECT status, error_message FROM knowledge_documents WHERE id = ?`).bind(pending!.id).first<{ status: string; error_message: string }>();
      expect(doc!.status).toBe('failed');
      expect(doc!.error_message).toContain('Vectorize upsert failed');

      expect(testEnv.KNOWLEDGE_INDEX._upsertCallCount()).toBe(1); // no retry — a dimension mismatch would fail identically on every attempt
    });
  });
});
