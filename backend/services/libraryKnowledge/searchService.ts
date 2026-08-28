/**
 * Private library retrieval — Digital Library Phase 7C (AI Reading
 * Assistant). Mirrors services/knowledge/searchService.ts's own
 * structure closely on purpose (embed the query -> query Vectorize ->
 * join D1 for the real text/metadata -> rerank -> confidence-bucket),
 * reusing chunking/ranking.ts's scoring functions unmodified. The one
 * real difference: this search is scoped to exactly ONE resource
 * (documentId), never the whole private index.
 *
 * SECURITY: this function does not decide whether the caller may see
 * this resource — that decision (checkEntitlement) must already have
 * happened before this is ever called; see answerService.ts. What this
 * function DOES guarantee, independently, is that even if it were
 * somehow called with a documentId the caller shouldn't have, it can
 * only ever return chunks belonging to that exact document — the D1
 * WHERE clause below is scoped by document_id, not just "closest
 * vectors in the whole private index." Vectorize's own topK query
 * returns candidates from across every indexed resource; the D1 join
 * is what actually enforces "chunks from THIS book only," the same
 * "Vectorize answers nearest, D1 answers who may see it" split the
 * public Knowledge Base already established.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { embedText } from '../ai/aiGateway';
import { computeRankingSignals, scoreToConfidence, type RetrievalConfidence } from '../knowledge/ranking';

const EMBEDDING_FEATURE = 'library.embed';
/** How many pages away from the reader's current page still counts as "nearby" for the retrieval-biasing boost below — informational only, see this file's own header comment on why it can never be a security signal. */
const PAGE_PROXIMITY_WINDOW = 2;
const PAGE_PROXIMITY_BOOST_WEIGHT = 0.1;

export interface LibrarySearchRequest {
  query: string;
  documentId: number;
  bookTitle: string;
  /** The reader's current page when the question was asked — used ONLY to bias which chunks rank higher among results ALREADY scoped to this document; never widens or narrows which document is searched. */
  currentPage?: number | null;
  limit?: number;
}

export interface LibrarySearchResult {
  chunkId: number;
  chunkText: string;
  pageNumber: number | null;
  chapterTitle: string | null;
  vectorSimilarity: number;
  pageProximityBoost: number;
  score: number;
  confidence: RetrievalConfidence;
}

export interface LibrarySearchResponse {
  results: LibrarySearchResult[];
  latencyMs: number;
}

interface ChunkJoinRow {
  chunk_id: number;
  chunk_text: string;
  page_number: number | null;
  chapter_title: string | null;
  vector_id: string;
}

export async function searchLibraryResource(env: Env, logger: Logger, request: LibrarySearchRequest): Promise<LibrarySearchResponse> {
  const startedAt = Date.now();
  const limit = Math.min(10, Math.max(1, request.limit ?? 5));

  const embedded = await embedText(env, logger, {
    feature: EMBEDDING_FEATURE,
    actorType: 'customer',
    actorId: null,
    classification: 'CONFIDENTIAL',
    texts: [request.query],
  });
  const queryVector = embedded.embeddings[0];

  // Over-fetch, same reasoning as the public search: some Vectorize
  // matches will belong to OTHER resources (the private index holds
  // every purchased resource's chunks, not just this one) and get
  // filtered out by the document_id-scoped D1 join below.
  const matches = await env.LIBRARY_KNOWLEDGE_INDEX.query(queryVector, { topK: limit * 6, returnMetadata: 'none' });

  let results: LibrarySearchResult[] = [];
  if (matches.matches.length > 0) {
    const vectorIds = matches.matches.map((m) => m.id);
    const scoreByVectorId = new Map(matches.matches.map((m) => [m.id, m.score]));
    const placeholders = vectorIds.map(() => '?').join(', ');

    // document_id in the WHERE clause is the real enforcement point —
    // see this file's own header comment.
    const rows = await env.DB.prepare(
      `SELECT id AS chunk_id, chunk_text, page_number, chapter_title, vector_id
       FROM library_knowledge_chunks
       WHERE document_id = ? AND vector_id IN (${placeholders})`
    )
      .bind(request.documentId, ...vectorIds)
      .all<ChunkJoinRow>();

    results = rows.results
      .map((r) => {
        const vectorSimilarity = scoreByVectorId.get(r.vector_id) ?? 0;
        const signals = computeRankingSignals(request.query, vectorSimilarity, request.bookTitle, r.chunk_text, 'PDF');
        const pageProximityBoost =
          request.currentPage != null && r.page_number != null && Math.abs(r.page_number - request.currentPage) <= PAGE_PROXIMITY_WINDOW
            ? PAGE_PROXIMITY_BOOST_WEIGHT
            : 0;
        return {
          chunkId: r.chunk_id,
          chunkText: r.chunk_text,
          pageNumber: r.page_number,
          chapterTitle: r.chapter_title,
          vectorSimilarity,
          pageProximityBoost,
          score: Math.min(1, signals.finalScore + pageProximityBoost),
          confidence: scoreToConfidence(Math.min(1, signals.finalScore + pageProximityBoost)),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  return { results, latencyMs: Date.now() - startedAt };
}
