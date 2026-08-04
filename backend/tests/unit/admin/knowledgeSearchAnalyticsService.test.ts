/**
 * Unit tests: Knowledge Base search analytics — Version 5.0 Milestone
 * 2.2, Task 4. Seeds knowledge_search_log rows directly (search
 * behavior itself is covered by tests/unit/knowledge/searchService.test.ts)
 * and asserts the aggregation logic in isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getSearchAnalytics } from '../../../services/admin/knowledgeSearchAnalyticsService';

async function seedDocument(documentKey: string, title: string): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO knowledge_documents (document_key, source_type, source_id, source_url, title, data_classification, content_hash, status, chunk_count, version)
     VALUES (?, 'blog_post', NULL, 'https://robayerwealthlab.com/blog/x/', ?, 'PRODUCTION', 'hash', 'indexed', 1, 1)`
  )
    .bind(documentKey, title)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedSearchLog(query: string, resultCount: number, topScore: number | null, topDocumentId: number | null, latencyMs: number, daysAgo = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO knowledge_search_log (query_text, actor_type, actor_id, visibility_scope, result_count, top_score, top_document_id, latency_ms, created_at)
     VALUES (?, 'customer', NULL, 'public', ?, ?, ?, ?, datetime('now', ?))`
  )
    .bind(query, resultCount, topScore, topDocumentId, latencyMs, `-${daysAgo} days`)
    .run();
}

describe('getSearchAnalytics', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM knowledge_search_log');
    await env.DB.exec('DELETE FROM knowledge_chunks');
    await env.DB.exec('DELETE FROM knowledge_documents');
  });

  it('returns all-zero/empty shape gracefully when there is no search history yet', async () => {
    const analytics = await getSearchAnalytics(env as any);
    expect(analytics.totalSearches).toBe(0);
    expect(analytics.mostCommonSearches).toEqual([]);
    expect(analytics.zeroResultSearches).toEqual([]);
    expect(analytics.avgConfidenceScore).toBeNull();
    expect(analytics.searchSuccessRate).toBeNull();
    expect(analytics.confidenceDistribution).toEqual({ high: 0, medium: 0, low: 0, none: 0 });
  });

  it('counts the most common searches and zero-result searches correctly', async () => {
    const docId = await seedDocument('blog_post:1', 'Treasury Bills');
    await seedSearchLog('treasury bills', 3, 0.7, docId, 400);
    await seedSearchLog('treasury bills', 3, 0.7, docId, 420);
    await seedSearchLog('privacy policy', 0, null, null, 300);
    await seedSearchLog('privacy policy', 0, null, null, 310);
    await seedSearchLog('privacy policy', 0, null, null, 290);

    const analytics = await getSearchAnalytics(env as any);
    expect(analytics.totalSearches).toBe(5);
    expect(analytics.mostCommonSearches[0]).toEqual({ query: 'privacy policy', count: 3 });
    expect(analytics.zeroResultSearches[0]).toEqual({ query: 'privacy policy', count: 3 });
    expect(analytics.searchSuccessRate).toBe(40); // 2 of 5 searches returned a result
  });

  it('buckets confidence distribution using the real scoreToConfidence() thresholds, not a duplicated copy', async () => {
    const docId = await seedDocument('blog_post:2', 'Some Doc');
    await seedSearchLog('high query', 1, 0.9, docId, 100); // high
    await seedSearchLog('medium query', 1, 0.5, docId, 100); // medium
    await seedSearchLog('low query', 1, 0.2, docId, 100); // low
    await seedSearchLog('zero result query', 0, null, null, 100); // none

    const analytics = await getSearchAnalytics(env as any);
    expect(analytics.confidenceDistribution).toEqual({ high: 1, medium: 1, low: 1, none: 1 });
  });

  it('ranks most frequently retrieved documents by how often each was the #1 result', async () => {
    const popularDocId = await seedDocument('blog_post:3', 'Popular Doc');
    const rareDocId = await seedDocument('blog_post:4', 'Rare Doc');
    await seedSearchLog('q1', 1, 0.6, popularDocId, 100);
    await seedSearchLog('q2', 1, 0.6, popularDocId, 100);
    await seedSearchLog('q3', 1, 0.6, popularDocId, 100);
    await seedSearchLog('q4', 1, 0.6, rareDocId, 100);

    const analytics = await getSearchAnalytics(env as any);
    expect(analytics.mostRetrievedDocuments[0]).toMatchObject({ documentId: popularDocId, title: 'Popular Doc', count: 3 });
  });

  it('computes latency percentiles from real logged values', async () => {
    const docId = await seedDocument('blog_post:5', 'Latency Doc');
    for (const latency of [100, 200, 300, 400, 500]) {
      await seedSearchLog('latency query', 1, 0.6, docId, latency);
    }
    const analytics = await getSearchAnalytics(env as any);
    expect(analytics.latencyMs.max).toBe(500);
    expect(analytics.latencyMs.p50).not.toBeNull();
    expect(analytics.latencyMs.p95).not.toBeNull();
  });

  it('only includes the last 14 days in the low-confidence trend', async () => {
    const docId = await seedDocument('blog_post:6', 'Trend Doc');
    await seedSearchLog('recent low', 1, 0.1, docId, 100, 1);
    await seedSearchLog('old low', 1, 0.1, docId, 100, 30); // outside the 14-day window

    const analytics = await getSearchAnalytics(env as any);
    const totalInTrend = analytics.lowConfidenceTrend.reduce((sum, t) => sum + t.totalSearches, 0);
    expect(totalInTrend).toBe(1); // only the recent one
  });
});
