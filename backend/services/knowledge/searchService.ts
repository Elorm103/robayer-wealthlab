/**
 * Knowledge Base search/retrieval — Version 5.0 Milestone 2, reranking
 * and confidence calibration added in Milestone 2.2. Embeds the query
 * via the AI Gateway's `embedText()` (the same governed door every
 * embedding call in this codebase goes through — see
 * services/ai/aiGateway.ts), queries Vectorize for the nearest chunk
 * vectors, joins back to D1 for the actual text, title, citation URL,
 * and — critically — the `visibility`/`data_classification`/`status`
 * filtering Vectorize's own metadata filter DSL is not relied upon for,
 * then reranks the candidates with lightweight lexical signals
 * (services/knowledge/ranking.ts) before confidence-bucketing and
 * slicing to the requested limit. D1 remains the single source of
 * truth for what's currently indexed and who may see it; Vectorize
 * only ever answers "which vectors are nearest," never "is this one
 * allowed."
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { embedText } from '../ai/aiGateway';
import type { KnowledgeSourceType } from './documentSources';
import { computeRankingSignals, scoreToConfidence, type RetrievalConfidence } from './ranking';

const EMBEDDING_FEATURE = 'knowledge.embed';

export interface KnowledgeSearchRequest {
  query: string;
  /** Defaults to 'public' — a customer-facing caller should never pass 'admin_only'. */
  visibility?: 'public' | 'admin_only';
  sourceTypes?: KnowledgeSourceType[];
  limit?: number;
  actorType: 'customer' | 'admin' | 'system';
  actorId: number | null;
}

export type { RetrievalConfidence };

export interface KnowledgeSearchResult {
  chunkId: number;
  documentId: number;
  sourceType: KnowledgeSourceType;
  sourceTitle: string;
  sourceUrl: string | null;
  chunkText: string;
  /** Raw Vectorize cosine similarity — Task 3 diagnostic field, kept distinct from the blended score below. */
  vectorSimilarity: number;
  titleBoost: number;
  keywordBoost: number;
  sourceBoost: number;
  /** vectorSimilarity + titleBoost + keywordBoost + sourceBoost — what results are actually sorted and confidence-bucketed by. */
  score: number;
  confidence: RetrievalConfidence;
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResult[];
  latencyMs: number;
}

interface ChunkJoinRow {
  chunk_id: number;
  document_id: number;
  chunk_text: string;
  vector_id: string;
  source_type: KnowledgeSourceType;
  title: string;
  source_url: string | null;
  visibility: 'public' | 'admin_only';
  data_classification: string;
  status: string;
}

export async function searchKnowledge(env: Env, logger: Logger, request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
  const startedAt = Date.now();
  const visibility = request.visibility ?? 'public';
  const limit = Math.min(20, Math.max(1, request.limit ?? 5));

  const embedded = await embedText(env, logger, {
    feature: EMBEDDING_FEATURE,
    actorType: request.actorType,
    actorId: request.actorId,
    classification: 'PUBLIC',
    texts: [request.query],
  });
  const queryVector = embedded.embeddings[0];

  // Over-fetch from Vectorize (4x the requested limit) since some
  // matches get filtered out below by visibility/classification/
  // source-type/status — Vectorize itself has no knowledge of any of
  // those, only D1 does. returnMetadata must be the string 'none' (not
  // a boolean) on current Vectorize (V2) indexes — a boolean is only
  // valid on legacy V1 indexes and fails at the API layer with
  // VECTOR_QUERY_ERROR 40026 on a real (V2) index. We never read vector
  // metadata anyway (every field this function needs comes from the D1
  // join below), so 'none' is also the most efficient choice.
  const matches = await env.KNOWLEDGE_INDEX.query(queryVector, { topK: limit * 4, returnMetadata: 'none' });

  let results: KnowledgeSearchResult[] = [];
  if (matches.matches.length > 0) {
    const vectorIds = matches.matches.map((m) => m.id);
    const scoreByVectorId = new Map(matches.matches.map((m) => [m.id, m.score]));
    const placeholders = vectorIds.map(() => '?').join(', ');

    const rows = await env.DB.prepare(
      `SELECT c.id AS chunk_id, c.document_id, c.chunk_text, c.vector_id,
              d.source_type, d.title, d.source_url, d.visibility, d.data_classification, d.status
       FROM knowledge_chunks c
       JOIN knowledge_documents d ON d.id = c.document_id
       WHERE c.vector_id IN (${placeholders})`
    )
      .bind(...vectorIds)
      .all<ChunkJoinRow>();

    results = rows.results
      .filter((r) => r.visibility === visibility && r.status === 'indexed' && r.data_classification === 'PRODUCTION')
      .filter((r) => !request.sourceTypes || request.sourceTypes.includes(r.source_type))
      .map((r) => {
        const vectorSimilarity = scoreByVectorId.get(r.vector_id) ?? 0;
        const signals = computeRankingSignals(request.query, vectorSimilarity, r.title, r.chunk_text, r.source_type);
        return {
          chunkId: r.chunk_id,
          documentId: r.document_id,
          sourceType: r.source_type,
          sourceTitle: r.title,
          sourceUrl: r.source_url,
          chunkText: r.chunk_text,
          vectorSimilarity: signals.vectorSimilarity,
          titleBoost: signals.titleBoost,
          keywordBoost: signals.keywordBoost,
          sourceBoost: signals.sourceBoost,
          score: signals.finalScore,
          confidence: scoreToConfidence(signals.finalScore),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  const latencyMs = Date.now() - startedAt;

  try {
    await env.DB.prepare(
      `INSERT INTO knowledge_search_log (query_text, actor_type, actor_id, visibility_scope, result_count, top_score, top_document_id, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(request.query, request.actorType, request.actorId, visibility, results.length, results[0]?.score ?? null, results[0]?.documentId ?? null, latencyMs)
      .run();
  } catch (err) {
    // Same "never let logging break the real operation" posture as
    // aiGateway.ts's own logUsage() — a search that succeeded must not
    // fail just because its diagnostic log entry couldn't be written.
    logger.error('knowledge.search_log_write_failed', { error: err instanceof Error ? err.message : String(err) });
  }

  return { results, latencyMs };
}
