/**
 * Indexing orchestrator — Version 5.0 Milestone 2 (Knowledge Base),
 * redesigned in Milestone 2.1 after production's first full rebuild
 * proved the original synchronous, single-invocation design does not
 * scale. See docs/v5.0-milestone-2.1-engineering-report.md for the full
 * incident writeup; summary below.
 *
 * ROOT CAUSE (measured directly against production D1/logs, not
 * assumed): Cloudflare counts D1, KV, R2, AND Vectorize binding calls
 * against the SAME per-invocation subrequest budget as fetch(). Every
 * document's finalization (Vectorize upsert, D1 chunk/faq writes,
 * status updates, old-vector cleanup) costs roughly 5-7 of those calls,
 * irreducibly — each document genuinely needs its own write. A
 * Milestone 2 fix batched EMBEDDING calls across documents (good, and
 * kept below), but that only ever addressed one line item; the
 * per-document D1/Vectorize write cost remained, and a 38-document
 * full rebuild still totalled roughly 300+ subrequests in one
 * `ctx.waitUntil()` invocation. That is linear in catalog size with no
 * ceiling — "hundreds or thousands of documents" was never going to
 * fit in one invocation's budget no matter how the calls inside it were
 * optimized.
 *
 * THE FIX: split indexing into two phases that run as SEPARATE Worker
 * invocations, each with its own fresh subrequest budget:
 *
 *   1. PLANNING (`planIncrementalIndex`/`planFullRebuild`) — gathers
 *      documents, hash-compares against a single bulk query (not one
 *      SELECT per document, another real fix — see below), and enqueues
 *      one Cloudflare Queue message per document that needs work. Fast
 *      and lightweight; still runs inside one admin-triggered
 *      `ctx.waitUntil()` job, same as before.
 *
 *   2. CONSUMING (`processIndexingQueueBatch`, invoked by the Worker's
 *      exported `queue()` handler in worker/index.ts) — processes a
 *      small batch of documents (wrangler.jsonc's `max_batch_size: 5`)
 *      per invocation. Cloudflare delivers queue batches as independent
 *      Worker invocations, each starting with a full, fresh subrequest
 *      budget — this is the actual mechanism that makes indexing scale,
 *      not a bigger batch size or fewer provider calls.
 *
 * `knowledge_indexing_runs.documents_enqueued`/`documents_resolved`
 * (migration 0037) track a run's progress across however many consumer
 * invocations it takes to drain — a run flips 'running' -> 'completed'
 * once every enqueued document has resolved (indexed or failed), giving
 * real checkpointing/resumability: an interrupted consumer invocation
 * just leaves some queue messages unprocessed, and Cloudflare's own
 * retry mechanism (wrangler.jsonc's `max_retries`) redelivers them —
 * nothing is lost, nothing needs restarting from scratch.
 *
 * Versioning discipline is unchanged from Milestone 2: a re-indexed
 * document's OLD chunks/vectors are deleted only AFTER the new ones are
 * successfully written — never a window where a mid-reindex document
 * has zero searchable content.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { embedText } from '../ai/aiGateway';
import { chunkText, type TextChunk } from './chunking';
import { getBlogPostDocuments, getResourceDocuments, getProductDocuments, getStaticPageDocuments, getCmsSettingDocuments, type SourceDocument, type KnowledgeSourceType } from './documentSources';
import type { KnowledgeIndexQueueMessage } from './queueTypes';

const EMBEDDING_FEATURE = 'knowledge.embed';
/** Target chunk count per embed call — bounds both the OpenAI request size and (via fewer total calls) subrequest footprint within one consumer invocation. */
const EMBED_BATCH_SIZE = 96;
/** Cloudflare Queues' own sendBatch() cap. */
const QUEUE_SEND_BATCH_SIZE = 100;

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// ============================================================
// Planning phase — gathers, hash-compares, enqueues. Runs once per
// admin-triggered reindex/rebuild, inside one ctx.waitUntil() job.
// ============================================================

export interface PlanIndexingRunSummary {
  runId: number;
  documentsSeen: number;
  documentsUnchanged: number;
  /** Failed synchronously during planning (e.g. zero extractable content) — never even reached the queue. */
  documentsFailedAtPlanning: number;
  documentsEnqueued: number;
}

async function gatherAllDocuments(env: Env, logger: Logger): Promise<SourceDocument[]> {
  const [blogDocs, resourceDocs, productDocs, cmsDocs] = await Promise.all([
    getBlogPostDocuments(env),
    getResourceDocuments(env),
    getProductDocuments(env, logger),
    getCmsSettingDocuments(env),
  ]);

  const excludeUrls = new Set<string>([...blogDocs, ...productDocs].map((d) => d.url).filter((u): u is string => u !== null));
  const staticDocs = await getStaticPageDocuments(env, excludeUrls, logger);

  return [...blogDocs, ...resourceDocs, ...productDocs, ...cmsDocs, ...staticDocs];
}

/** Insert-or-update the knowledge_documents row for this document, given an ALREADY-KNOWN existing id (or null) — planning fetches every existing row in ONE bulk query up front rather than one SELECT per document, which was itself a real, measured contributor to Milestone 2's subrequest ceiling. */
async function upsertDocumentRecord(env: Env, doc: SourceDocument, contentHash: string, status: 'pending' | 'failed', errorMessage: string | null, chunkCount: number, existingId: number | null): Promise<number> {
  if (existingId !== null) {
    await env.DB.prepare(
      `UPDATE knowledge_documents SET source_url = ?, title = ?, data_classification = ?, content_hash = ?, status = ?, error_message = ?, chunk_count = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(doc.url, doc.title, doc.dataClassification, contentHash, status, errorMessage, chunkCount, existingId)
      .run();
    return existingId;
  }

  const insert = await env.DB.prepare(
    `INSERT INTO knowledge_documents (document_key, source_type, source_id, source_url, title, data_classification, content_hash, status, error_message, chunk_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(doc.documentKey, doc.sourceType, doc.sourceId, doc.url, doc.title, doc.dataClassification, contentHash, status, errorMessage, chunkCount)
    .run();
  return Number(insert.meta.last_row_id);
}

async function planIndexingRun(env: Env, logger: Logger, runType: 'incremental' | 'full_rebuild', triggeredBy: number | null): Promise<PlanIndexingRunSummary> {
  const runInsert = await env.DB.prepare(`INSERT INTO knowledge_indexing_runs (run_type, trigger_type, triggered_by) VALUES (?, 'admin_manual', ?)`).bind(runType, triggeredBy).run();
  const runId = Number(runInsert.meta.last_row_id);

  let documentsSeen = 0;
  let documentsUnchanged = 0;
  let documentsFailed = 0;
  let documentsEnqueued = 0;

  try {
    const documents = await gatherAllDocuments(env, logger);

    const existingRows = (await env.DB.prepare(`SELECT id, document_key, content_hash, status FROM knowledge_documents`).all<{ id: number; document_key: string; content_hash: string; status: string }>()).results;
    const existingByKey = new Map(existingRows.map((r) => [r.document_key, r]));

    const toEnqueue: KnowledgeIndexQueueMessage[] = [];

    for (const doc of documents) {
      documentsSeen++;
      const contentHash = await sha256Hex(doc.text);
      const existing = existingByKey.get(doc.documentKey) ?? null;

      if (runType === 'incremental' && existing && existing.content_hash === contentHash && existing.status === 'indexed') {
        documentsUnchanged++;
        continue;
      }

      const chunks = chunkText(doc.text);
      if (chunks.length === 0) {
        await upsertDocumentRecord(env, doc, contentHash, 'failed', 'No content could be extracted for chunking.', 0, existing?.id ?? null);
        documentsFailed++;
        continue;
      }

      const documentId = await upsertDocumentRecord(env, doc, contentHash, 'pending', null, chunks.length, existing?.id ?? null);
      documentsEnqueued++;
      toEnqueue.push({
        runId,
        documentId,
        contentHash,
        wasPreExisting: existing !== null,
        documentKey: doc.documentKey,
        sourceType: doc.sourceType,
        sourceId: doc.sourceId,
        sourceUrl: doc.url,
        title: doc.title,
        dataClassification: doc.dataClassification,
        faqs: doc.faqs,
        chunks,
      });
    }

    for (let i = 0; i < toEnqueue.length; i += QUEUE_SEND_BATCH_SIZE) {
      const batch = toEnqueue.slice(i, i + QUEUE_SEND_BATCH_SIZE);
      await env.KNOWLEDGE_INDEX_QUEUE.sendBatch(batch.map((m) => ({ body: m })));
    }

    const status = documentsEnqueued > 0 ? 'running' : 'completed';
    await env.DB.prepare(
      `UPDATE knowledge_indexing_runs SET documents_seen = ?, documents_unchanged = ?, documents_failed = ?, documents_enqueued = ?, status = ?, completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE NULL END WHERE id = ?`
    )
      .bind(documentsSeen, documentsUnchanged, documentsFailed, documentsEnqueued, status, status, runId)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown indexing error';
    logger.error('knowledge.indexing_plan_failed', { runId, error: message });
    await env.DB.prepare(
      `UPDATE knowledge_indexing_runs SET status = 'failed', documents_seen = ?, documents_unchanged = ?, documents_failed = ?, documents_enqueued = ?, completed_at = datetime('now'), error_message = ? WHERE id = ?`
    )
      .bind(documentsSeen, documentsUnchanged, documentsFailed, documentsEnqueued, message, runId)
      .run();
  }

  return { runId, documentsSeen, documentsUnchanged, documentsFailedAtPlanning: documentsFailed, documentsEnqueued };
}

/** Incremental — only documents whose content_hash has changed (or that are new) are enqueued; everything else is left untouched, per "Incremental indexing" (Task list). */
export function planIncrementalIndex(env: Env, logger: Logger, triggeredBy: number | null): Promise<PlanIndexingRunSummary> {
  return planIndexingRun(env, logger, 'incremental', triggeredBy);
}

/** Full rebuild — every document is enqueued regardless of whether its content_hash matches, per "Full rebuild" (Task list). Use after a routing/embedding-model change, since a model change invalidates every existing vector's comparability. */
export function planFullRebuild(env: Env, logger: Logger, triggeredBy: number | null): Promise<PlanIndexingRunSummary> {
  return planIndexingRun(env, logger, 'full_rebuild', triggeredBy);
}

// ============================================================
// Consumer phase — one Worker invocation per queue batch, each with
// its own fresh subrequest budget. Invoked by worker/index.ts's
// exported queue() handler; never calls anything that fetches or
// re-derives content — everything it needs travels in the message.
// ============================================================

interface PreparedDocument {
  documentId: number;
  wasPreExisting: boolean;
  documentKey: string;
  sourceType: KnowledgeSourceType;
  sourceUrl: string | null;
  faqs: { question: string; answer: string }[];
  chunks: TextChunk[];
}

interface FinalizeOutcome {
  outcome: 'indexed' | 'failed';
  chunksCreated: number;
}

interface VectorRecord {
  id: string;
  values: number[];
  metadata: { documentId: number; sourceType: KnowledgeSourceType; sourceUrl: string };
}

const VECTORIZE_RATE_LIMIT_MAX_ATTEMPTS = 4;
const VECTORIZE_RATE_LIMIT_BASE_DELAY_MS = 250;

/**
 * Version 5.0 Milestone 2.1's second production incident: even after
 * the subrequest-scaling fix above, a full rebuild still failed 2 of 38
 * documents with `VECTOR_UPSERT_ERROR (40014): Too Many Requests` — a
 * genuine Vectorize write-rate limit, distinct from the Worker
 * subrequest budget. Cloudflare's Vectorize docs don't publish an exact
 * requests-per-second ceiling, but they do explicitly recommend
 * "batch more vectors into fewer requests... important for write-heavy
 * workloads" (developers.cloudflare.com/vectorize/best-practices/insert-vectors/).
 * The real cause: every document in a consumer batch was still issuing
 * its OWN separate `upsert()` call (up to 5 sequential calls per
 * invocation), and with wrangler.jsonc's queue consumer concurrency
 * unbounded, multiple invocations could fire near-simultaneously,
 * collectively bursting past Vectorize's per-index write ceiling.
 *
 * Fixed on two fronts: (1) every document's vectors in one consumer
 * batch are now upserted in ONE combined call (below), cutting
 * Vectorize write-call volume up to 5x per invocation; (2)
 * wrangler.jsonc's consumer now sets an explicit `max_concurrency`
 * rather than leaving it to Cloudflare's auto-scaled maximum, capping
 * how many invocations can hit the same index at once. This retry
 * helper is a bounded safety net on top of both — not a substitute for
 * them — for the residual case where a rate-limit is still hit despite
 * batching and concurrency control. Only a genuine rate-limit error
 * (40014 / "Too Many Requests" / HTTP 429) is retried; any other
 * Vectorize error (bad dimensions, malformed id) is not, since retrying
 * an error that isn't transient would just fail identically.
 */
function isVectorizeRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('40014') || message.includes('Too Many Requests') || message.includes('429');
}

async function withVectorizeRateLimitRetry<T>(logger: Logger, operation: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= VECTORIZE_RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isVectorizeRateLimitError(err) || attempt === VECTORIZE_RATE_LIMIT_MAX_ATTEMPTS) throw err;
      const delayMs = VECTORIZE_RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1);
      logger.error('knowledge.vectorize_rate_limited_retrying', { operation, attempt, delayMs, error: err instanceof Error ? err.message : String(err) });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function markDocumentFailed(env: Env, documentId: number, message: string): Promise<void> {
  await env.DB.prepare(`UPDATE knowledge_documents SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?`).bind(message, documentId).run();
}

/** Writes the final indexed D1 state for ONE document, given its vectors are ALREADY confirmed live in Vectorize (upserted as part of the whole batch — see embedAndFinalizeAll). No Vectorize calls here. */
async function writeDocumentIndexedState(
  env: Env,
  documentId: number,
  wasPreExisting: boolean,
  faqs: { question: string; answer: string }[],
  chunks: TextChunk[],
  vectorRecords: VectorRecord[],
  embeddingModel: string
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM knowledge_chunks WHERE document_id = ?`).bind(documentId),
    ...chunks.map((chunk, i) =>
      env.DB.prepare(`INSERT INTO knowledge_chunks (document_id, chunk_index, chunk_text, chunk_tokens, vector_id, embedding_model) VALUES (?, ?, ?, ?, ?, ?)`).bind(
        documentId,
        chunk.index,
        chunk.text,
        chunk.tokens,
        vectorRecords[i].id,
        embeddingModel
      )
    ),
    env.DB.prepare(`DELETE FROM knowledge_faqs WHERE document_id = ?`).bind(documentId),
    ...faqs.map((faq) => env.DB.prepare(`INSERT INTO knowledge_faqs (document_id, question, answer) VALUES (?, ?, ?)`).bind(documentId, faq.question, faq.answer)),
  ]);

  // A brand-new document already started at version = 1 (the schema
  // default, set when planning INSERTed its 'pending' row) — only a
  // document that existed BEFORE this run should have its version
  // bumped here, or a first-ever index would incorrectly jump to
  // version 2.
  const versionClause = wasPreExisting ? 'version = version + 1, ' : '';
  await env.DB.prepare(
    `UPDATE knowledge_documents SET status = 'indexed', error_message = NULL, chunk_count = ?, ${versionClause}indexed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  )
    .bind(chunks.length, documentId)
    .run();
}

/**
 * Embeds every prepared document's chunks and finalizes each one, using
 * as few embed calls (and as few Vectorize write calls) as this batch
 * allows. Documents are packed by accumulated chunk count (capped at
 * EMBED_BATCH_SIZE) without splitting one document's own chunks across
 * two embed calls; every document's resulting vectors are then upserted
 * to Vectorize in ONE combined call per embed-batch, not one call per
 * document (see this file's header comment on VECTOR_UPSERT_ERROR
 * 40014). Returns one outcome per input document, in the same order, so
 * the caller can attribute results back to the right run/message.
 */
async function embedAndFinalizeAll(env: Env, logger: Logger, prepared: PreparedDocument[]): Promise<FinalizeOutcome[]> {
  const results: FinalizeOutcome[] = new Array(prepared.length);
  let i = 0;

  while (i < prepared.length) {
    const batchIndices: number[] = [i];
    let count = prepared[i].chunks.length;
    i++;
    while (i < prepared.length && count + prepared[i].chunks.length <= EMBED_BATCH_SIZE) {
      batchIndices.push(i);
      count += prepared[i].chunks.length;
      i++;
    }

    const batch = batchIndices.map((idx) => prepared[idx]);
    const allTexts = batch.flatMap((p) => p.chunks.map((c) => c.text));

    processBatch: {
      let embeddings: number[][];
      let embeddingModel: string;
      try {
        const result = await embedText(env, logger, {
          feature: EMBEDDING_FEATURE,
          actorType: 'system',
          actorId: null,
          classification: 'PUBLIC', // every source this milestone indexes is public-facing platform content — see documentSources.ts's own dataClassification reasoning
          texts: allTexts,
        });
        if (result.embeddings.length !== allTexts.length) {
          throw new Error(`Embedding count mismatch: ${result.embeddings.length} vectors for ${allTexts.length} input texts.`);
        }
        embeddings = result.embeddings;
        embeddingModel = result.model;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown embedding error';
        for (let bi = 0; bi < batch.length; bi++) {
          logger.error('knowledge.embedding_failed', { documentKey: batch[bi].documentKey, error: message });
          await markDocumentFailed(env, batch[bi].documentId, `Embedding failed: ${message}`);
          results[batchIndices[bi]] = { outcome: 'failed', chunksCreated: 0 };
        }
        break processBatch;
      }

      const newVersionSuffix = Date.now();
      const perDocVectorRecords: VectorRecord[][] = [];
      let offset = 0;
      for (const p of batch) {
        const docEmbeddings = embeddings.slice(offset, offset + p.chunks.length);
        offset += p.chunks.length;
        perDocVectorRecords.push(
          p.chunks.map((chunk, idx) => ({
            id: `chunk-${p.documentId}-${idx}-${newVersionSuffix}`,
            values: docEmbeddings[idx],
            metadata: { documentId: p.documentId, sourceType: p.sourceType, sourceUrl: p.sourceUrl ?? '' },
          }))
        );
      }
      const allVectorRecords = perDocVectorRecords.flat();

      try {
        await withVectorizeRateLimitRetry(logger, 'upsert', () => env.KNOWLEDGE_INDEX.upsert(allVectorRecords));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown Vectorize error';
        for (let bi = 0; bi < batch.length; bi++) {
          logger.error('knowledge.vectorize_upsert_failed', { documentKey: batch[bi].documentKey, error: message });
          await markDocumentFailed(env, batch[bi].documentId, `Vectorize upsert failed: ${message}`);
          results[batchIndices[bi]] = { outcome: 'failed', chunksCreated: 0 };
        }
        break processBatch;
      }

      // New vectors are live — write each document's D1 state (cheap,
      // per-document; D1 write volume was never the reported problem),
      // collecting old vector ids for ONE combined cleanup delete
      // afterward rather than one deleteByIds() call per document.
      const allOldVectorIdsToDelete: string[] = [];
      for (let bi = 0; bi < batch.length; bi++) {
        const p = batch[bi];
        const vectorRecords = perDocVectorRecords[bi];
        const oldChunks = p.wasPreExisting
          ? (await env.DB.prepare(`SELECT vector_id FROM knowledge_chunks WHERE document_id = ?`).bind(p.documentId).all<{ vector_id: string }>()).results
          : [];
        await writeDocumentIndexedState(env, p.documentId, p.wasPreExisting, p.faqs, p.chunks, vectorRecords, embeddingModel);
        results[batchIndices[bi]] = { outcome: 'indexed', chunksCreated: p.chunks.length };
        for (const c of oldChunks) {
          if (!vectorRecords.some((v) => v.id === c.vector_id)) allOldVectorIdsToDelete.push(c.vector_id);
        }
      }

      if (allOldVectorIdsToDelete.length > 0) {
        try {
          await withVectorizeRateLimitRetry(logger, 'deleteByIds', () => env.KNOWLEDGE_INDEX.deleteByIds(allOldVectorIdsToDelete));
        } catch (err) {
          // Same posture as Milestone 2: failing to clean up OLD vectors
          // does not make the re-index itself a failure — the new
          // vectors are already live and correct; a few orphaned old
          // vectors are a cleanup concern, not a correctness one.
          logger.error('knowledge.old_vector_cleanup_failed', { count: allOldVectorIdsToDelete.length, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  return results;
}

/**
 * Processes one queue-delivered batch of documents. Called from
 * worker/index.ts's exported `queue()` handler with the batch's message
 * bodies already unwrapped. Never throws for a document-level failure
 * (already caught and recorded above) — only an unexpected
 * infrastructure error (e.g. the run-counter UPDATE itself failing)
 * propagates, which is deliberate: that is exactly the case Cloudflare
 * Queues' own retry mechanism (wrangler.jsonc's `max_retries`) exists
 * to handle, by redelivering the batch to a fresh invocation.
 */
export async function processIndexingQueueBatch(env: Env, logger: Logger, messages: KnowledgeIndexQueueMessage[]): Promise<void> {
  if (messages.length === 0) return;

  const prepared: PreparedDocument[] = messages.map((m) => ({
    documentId: m.documentId,
    wasPreExisting: m.wasPreExisting,
    documentKey: m.documentKey,
    sourceType: m.sourceType,
    sourceUrl: m.sourceUrl,
    faqs: m.faqs,
    chunks: m.chunks,
  }));

  const results = await embedAndFinalizeAll(env, logger, prepared);

  // Grouped by run rather than assumed single-run, since a batch
  // Cloudflare delivers is not guaranteed to come from one planning
  // call — e.g. an admin triggering a second rebuild before the first
  // finishes draining.
  const byRun = new Map<number, { indexed: number; failed: number; chunksCreated: number; resolved: number }>();
  for (let i = 0; i < messages.length; i++) {
    const runId = messages[i].runId;
    const entry = byRun.get(runId) ?? { indexed: 0, failed: 0, chunksCreated: 0, resolved: 0 };
    entry.resolved++;
    if (results[i].outcome === 'indexed') {
      entry.indexed++;
      entry.chunksCreated += results[i].chunksCreated;
    } else {
      entry.failed++;
    }
    byRun.set(runId, entry);
  }

  for (const [runId, delta] of byRun) {
    await env.DB.prepare(
      `UPDATE knowledge_indexing_runs SET documents_indexed = documents_indexed + ?, documents_failed = documents_failed + ?, chunks_created = chunks_created + ?, documents_resolved = documents_resolved + ? WHERE id = ?`
    )
      .bind(delta.indexed, delta.failed, delta.chunksCreated, delta.resolved, runId)
      .run();

    const run = await env.DB.prepare(`SELECT documents_resolved, documents_enqueued, status FROM knowledge_indexing_runs WHERE id = ?`).bind(runId).first<{
      documents_resolved: number;
      documents_enqueued: number;
      status: string;
    }>();
    if (run && run.status === 'running' && run.documents_resolved >= run.documents_enqueued) {
      await env.DB.prepare(`UPDATE knowledge_indexing_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND status = 'running'`).bind(runId).run();
    }
  }
}
