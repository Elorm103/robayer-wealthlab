/**
 * Test-only fake Vectorize index — Version 5.0 Milestone 2 (Knowledge
 * Base). Miniflare's local Vectorize simulation does not work
 * (confirmed: "Vectorize Index bindings do not support local
 * development" warning from `wrangler`/Miniflare itself), so every
 * test exercising services/knowledge/indexingService.ts or
 * searchService.ts substitutes this simple in-memory implementation
 * for `env.KNOWLEDGE_INDEX` via `{ ...env, KNOWLEDGE_INDEX: fake }`.
 *
 * Cosine similarity (not just a stub) so search-ranking tests can
 * assert on real relative ordering, not just "some result came back."
 */

export interface FakeVector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface FakeVectorizeOptions {
  /** Errors thrown on the first N upsert() calls (consumed one per call, in order) — Version 5.0 Milestone 2.1, for testing withVectorizeRateLimitRetry()'s retry/no-retry behavior without a real Vectorize outage. */
  upsertFailures?: Error[];
}

export function createFakeVectorizeIndex(options: FakeVectorizeOptions = {}) {
  const store = new Map<string, FakeVector>();
  const upsertFailures = [...(options.upsertFailures ?? [])];
  let upsertCallCount = 0;
  let deleteByIdsCallCount = 0;

  return {
    async upsert(vectors: FakeVector[]) {
      upsertCallCount++;
      if (upsertFailures.length > 0) throw upsertFailures.shift();
      for (const v of vectors) store.set(v.id, v);
      return { ids: vectors.map((v) => v.id), count: vectors.length };
    },
    async insert(vectors: FakeVector[]) {
      for (const v of vectors) store.set(v.id, v);
      return { ids: vectors.map((v) => v.id), count: vectors.length };
    },
    async deleteByIds(ids: string[]) {
      deleteByIdsCallCount++;
      for (const id of ids) store.delete(id);
      return { ids, count: ids.length };
    },
    async getByIds(ids: string[]) {
      return ids.map((id) => store.get(id)).filter((v): v is FakeVector => v !== undefined);
    },
    async query(vector: number[], options?: { topK?: number; returnMetadata?: 'none' | 'indexed' | 'all' }) {
      // Version 5.0 Milestone 2.1 — mirrors a real production bug this
      // fake previously let slip through silently: the real Vectorize
      // (V2) API requires returnMetadata to be the STRING 'none' |
      // 'indexed' | 'all', not a boolean (that's only valid on legacy
      // V1 indexes) — a boolean caused VECTOR_QUERY_ERROR 40026 against
      // the real index, undetected here because this fake used to
      // accept anything. Validating the same shape the real API
      // enforces turns this class of bug into a failing test instead of
      // a silent pass.
      if (options?.returnMetadata !== undefined && !['none', 'indexed', 'all'].includes(options.returnMetadata)) {
        throw new Error(`VECTOR_QUERY_ERROR (code = 40026): Failed to parse the request body as JSON: returnMetadata: expected value`);
      }
      const topK = options?.topK ?? 5;
      const matches = [...store.values()]
        .map((v) => ({ id: v.id, score: cosineSimilarity(vector, v.values), metadata: v.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return { matches, count: matches.length };
    },
    async describe() {
      return { vectorCount: store.size, dimensions: 8, processedUpToDatetime: Date.now(), processedUpToMutation: '0' };
    },
    /** Test-only inspection helpers, not part of the real VectorizeIndex interface. */
    _size(): number {
      return store.size;
    },
    /** Version 5.0 Milestone 2.1 — verifies the fix for VECTOR_UPSERT_ERROR 40014: every document in one consumer batch should share ONE upsert() call, not one call per document. */
    _upsertCallCount(): number {
      return upsertCallCount;
    },
    _deleteByIdsCallCount(): number {
      return deleteByIdsCallCount;
    },
  };
}
