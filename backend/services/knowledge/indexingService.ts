/**
 * Indexing orchestrator — Version 5.0 Milestone 2 (Knowledge Base).
 * The one place `knowledge_documents`/`knowledge_chunks`/`knowledge_faqs`
 * are ever written. Reads from every source in services/knowledge/documentSources.ts,
 * chunks (chunking.ts), embeds via the AI Gateway's `embedText()`
 * (services/ai/aiGateway.ts — never a direct provider call), and
 * upserts into Vectorize (env.KNOWLEDGE_INDEX).
 *
 * Versioning discipline matches the AI Gateway's own prompt-versioning
 * precedent (see migration 0036's header comment): a re-indexed
 * document's OLD chunks/vectors are deleted only AFTER the new ones
 * are successfully written — never a window where a mid-reindex
 * document has zero searchable content.
 *
 * "Background indexing" (Task list) means every admin trigger runs via
 * `ctx.waitUntil()` — the route returns immediately, the run's
 * progress is tracked in `knowledge_indexing_runs` and polled by the
 * dashboard, exactly the same pattern this project's Cron Trigger
 * already uses for its own background jobs. There is no Cloudflare
 * Queue here — this platform's real indexable content volume today
 * (see the Milestone 2 Engineering Report) is small enough that a
 * single Worker invocation's wall-clock budget comfortably covers a
 * full run; a genuine Queue would be the right next step if that
 * volume grows by an order of magnitude or more.
 *
 * Embedding calls are batched ACROSS documents, not one call per
 * document — a real production run (Milestone 2's first full rebuild)
 * hit Cloudflare's per-invocation subrequest ceiling with a per-document
 * embed call, because the static-page crawl's page fetches (one
 * subrequest each) plus one embed call per document together exceeded
 * the limit partway through a full catalog run. Grouping many
 * documents' chunks into as few embed calls as possible (bounded by
 * EMBED_BATCH_SIZE) is what keeps a full run's subrequest count low
 * enough to actually complete. The trade-off: fault isolation on an
 * embedding failure is now per-BATCH (a group of documents that happen
 * to share a provider call) rather than strictly per-document — see the
 * Milestone 2 Production Verification Report for the real incident this
 * fixed and why that trade-off was accepted.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { embedText } from '../ai/aiGateway';
import { chunkText, type TextChunk } from './chunking';
import { getBlogPostDocuments, getResourceDocuments, getProductDocuments, getStaticPageDocuments, getCmsSettingDocuments, type SourceDocument } from './documentSources';

const EMBEDDING_FEATURE = 'knowledge.embed';
/** Target chunk count per embed call — bounds both the OpenAI request size and (via fewer total calls) this run's Worker-subrequest footprint. */
const EMBED_BATCH_SIZE = 96;

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export interface IndexingRunSummary {
  runId: number;
  documentsSeen: number;
  documentsIndexed: number;
  documentsUnchanged: number;
  documentsFailed: number;
  chunksCreated: number;
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

interface PreparedDocument {
  doc: SourceDocument;
  contentHash: string;
  existingId: number | null;
  chunks: TextChunk[];
}

/** Writes the final indexed state for ONE document, given its already-computed embeddings. No provider calls here — only Vectorize/D1 binding calls, which do not count against the Worker subrequest limit that batching (below) exists to protect. */
async function finalizeDocument(env: Env, logger: Logger, prepared: PreparedDocument, embeddings: number[][], embeddingModel: string): Promise<{ outcome: 'indexed' | 'failed'; chunksCreated: number }> {
  const { doc, contentHash, existingId, chunks } = prepared;

  if (embeddings.length !== chunks.length) {
    await upsertDocumentRecord(env, doc, contentHash, 'failed', `Embedding count mismatch: ${embeddings.length} vectors for ${chunks.length} chunks.`, 0);
    return { outcome: 'failed', chunksCreated: 0 };
  }

  const documentId = await upsertDocumentRecord(env, doc, contentHash, 'pending', null, chunks.length);

  // Old chunk vector ids, fetched BEFORE any write — deleted only after
  // the new chunks are successfully in place, per this file's own
  // versioning discipline (see header comment).
  const oldChunks = existingId
    ? (await env.DB.prepare(`SELECT vector_id FROM knowledge_chunks WHERE document_id = ?`).bind(existingId).all<{ vector_id: string }>()).results
    : [];

  const newVersionSuffix = Date.now();
  const vectorRecords = chunks.map((chunk, i) => ({
    id: `chunk-${documentId}-${i}-${newVersionSuffix}`,
    values: embeddings[i],
    metadata: { documentId, sourceType: doc.sourceType, sourceUrl: doc.url ?? '' },
  }));

  try {
    await env.KNOWLEDGE_INDEX.upsert(vectorRecords);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Vectorize error';
    logger.error('knowledge.vectorize_upsert_failed', { documentKey: doc.documentKey, error: message });
    await upsertDocumentRecord(env, doc, contentHash, 'failed', `Vectorize upsert failed: ${message}`, 0);
    return { outcome: 'failed', chunksCreated: 0 };
  }

  // New chunks are live in Vectorize — safe to replace the D1 rows now.
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
    ...doc.faqs.map((faq) => env.DB.prepare(`INSERT INTO knowledge_faqs (document_id, question, answer) VALUES (?, ?, ?)`).bind(documentId, faq.question, faq.answer)),
  ]);

  if (oldChunks.length > 0) {
    const oldVectorIds = oldChunks.map((c) => c.vector_id).filter((id) => !vectorRecords.some((v) => v.id === id));
    if (oldVectorIds.length > 0) {
      try {
        await env.KNOWLEDGE_INDEX.deleteByIds(oldVectorIds);
      } catch (err) {
        // A failure to clean up OLD vectors does not make this
        // document's re-index a failure — the new vectors are already
        // live and correct; a few orphaned old vectors are a cleanup
        // concern, not a correctness one, and will simply never be
        // returned since no knowledge_chunks row points to them anymore.
        logger.error('knowledge.old_vector_cleanup_failed', { documentKey: doc.documentKey, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // A brand-new document's INSERT (in upsertDocumentRecord, above) already
  // starts at the schema default of version = 1 — only a document that
  // existed BEFORE this run (existingId !== null) should have its version
  // bumped here, or a first-ever index would incorrectly jump to version 2.
  const versionClause = existingId !== null ? 'version = version + 1, ' : '';
  await env.DB.prepare(
    `UPDATE knowledge_documents SET status = 'indexed', error_message = NULL, chunk_count = ?, ${versionClause}indexed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  )
    .bind(chunks.length, documentId)
    .run();

  return { outcome: 'indexed', chunksCreated: chunks.length };
}

/** Insert-or-update the knowledge_documents row for this document_key, returning its id. */
async function upsertDocumentRecord(env: Env, doc: SourceDocument, contentHash: string, status: 'pending' | 'indexed' | 'failed', errorMessage: string | null, chunkCount: number): Promise<number> {
  const existing = await env.DB.prepare(`SELECT id FROM knowledge_documents WHERE document_key = ?`).bind(doc.documentKey).first<{ id: number }>();

  if (existing) {
    await env.DB.prepare(
      `UPDATE knowledge_documents SET source_url = ?, title = ?, data_classification = ?, content_hash = ?, status = ?, error_message = ?, chunk_count = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(doc.url, doc.title, doc.dataClassification, contentHash, status, errorMessage, chunkCount, existing.id)
      .run();
    return existing.id;
  }

  const insert = await env.DB.prepare(
    `INSERT INTO knowledge_documents (document_key, source_type, source_id, source_url, title, data_classification, content_hash, status, error_message, chunk_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(doc.documentKey, doc.sourceType, doc.sourceId, doc.url, doc.title, doc.dataClassification, contentHash, status, errorMessage, chunkCount)
    .run();
  return Number(insert.meta.last_row_id);
}

/**
 * Embeds every prepared document's chunks and finalizes each one, using
 * as few embed calls as the run's total chunk volume allows. Documents
 * are packed into a batch (by accumulated chunk count, capped at
 * EMBED_BATCH_SIZE) without ever splitting one document's own chunks
 * across two calls — simpler to reason about than a chunk-level split,
 * and the isolation unit a caller actually cares about ("did THIS
 * document index or not") stays intact. A document large enough on its
 * own to exceed EMBED_BATCH_SIZE chunks is sent alone, in one call,
 * rather than looped on forever.
 */
async function embedAndFinalizeAll(env: Env, logger: Logger, prepared: PreparedDocument[]): Promise<{ indexed: number; failed: number; chunksCreated: number }> {
  let indexed = 0;
  let failed = 0;
  let chunksCreated = 0;
  let i = 0;

  while (i < prepared.length) {
    const batch: PreparedDocument[] = [prepared[i]];
    let count = prepared[i].chunks.length;
    i++;
    while (i < prepared.length && count + prepared[i].chunks.length <= EMBED_BATCH_SIZE) {
      batch.push(prepared[i]);
      count += prepared[i].chunks.length;
      i++;
    }

    const allTexts = batch.flatMap((p) => p.chunks.map((c) => c.text));

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

      let offset = 0;
      for (const p of batch) {
        const docEmbeddings = result.embeddings.slice(offset, offset + p.chunks.length);
        offset += p.chunks.length;
        const outcome = await finalizeDocument(env, logger, p, docEmbeddings, result.model);
        if (outcome.outcome === 'indexed') {
          indexed++;
          chunksCreated += outcome.chunksCreated;
        } else {
          failed++;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown embedding error';
      for (const p of batch) {
        logger.error('knowledge.embedding_failed', { documentKey: p.doc.documentKey, error: message });
        await upsertDocumentRecord(env, p.doc, p.contentHash, 'failed', `Embedding failed: ${message}`, 0);
        failed++;
      }
    }
  }

  return { indexed, failed, chunksCreated };
}

async function runIndexing(env: Env, logger: Logger, runType: 'incremental' | 'full_rebuild', triggeredBy: number | null): Promise<IndexingRunSummary> {
  const runInsert = await env.DB.prepare(`INSERT INTO knowledge_indexing_runs (run_type, trigger_type, triggered_by) VALUES (?, 'admin_manual', ?)`).bind(runType, triggeredBy).run();
  const runId = Number(runInsert.meta.last_row_id);

  let documentsSeen = 0;
  let documentsIndexed = 0;
  let documentsUnchanged = 0;
  let documentsFailed = 0;
  let chunksCreated = 0;

  try {
    const documents = await gatherAllDocuments(env, logger);
    const prepared: PreparedDocument[] = [];

    for (const doc of documents) {
      documentsSeen++;
      const contentHash = await sha256Hex(doc.text);
      const existing = await env.DB.prepare(`SELECT id, content_hash, status FROM knowledge_documents WHERE document_key = ?`).bind(doc.documentKey).first<{
        id: number;
        content_hash: string;
        status: string;
      }>();

      if (runType === 'incremental' && existing && existing.content_hash === contentHash && existing.status === 'indexed') {
        documentsUnchanged++;
        continue;
      }

      const chunks = chunkText(doc.text);
      if (chunks.length === 0) {
        await upsertDocumentRecord(env, doc, contentHash, 'failed', 'No content could be extracted for chunking.', 0);
        documentsFailed++;
        continue;
      }

      prepared.push({ doc, contentHash, existingId: existing?.id ?? null, chunks });
    }

    const embedResult = await embedAndFinalizeAll(env, logger, prepared);
    documentsIndexed += embedResult.indexed;
    documentsFailed += embedResult.failed;
    chunksCreated += embedResult.chunksCreated;

    await env.DB.prepare(
      `UPDATE knowledge_indexing_runs SET status = 'completed', documents_seen = ?, documents_indexed = ?, documents_unchanged = ?, documents_failed = ?, chunks_created = ?, completed_at = datetime('now') WHERE id = ?`
    )
      .bind(documentsSeen, documentsIndexed, documentsUnchanged, documentsFailed, chunksCreated, runId)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown indexing error';
    logger.error('knowledge.indexing_run_failed', { runId, error: message });
    await env.DB.prepare(
      `UPDATE knowledge_indexing_runs SET status = 'failed', documents_seen = ?, documents_indexed = ?, documents_unchanged = ?, documents_failed = ?, chunks_created = ?, completed_at = datetime('now'), error_message = ? WHERE id = ?`
    )
      .bind(documentsSeen, documentsIndexed, documentsUnchanged, documentsFailed, chunksCreated, message, runId)
      .run();
  }

  return { runId, documentsSeen, documentsIndexed, documentsUnchanged, documentsFailed, chunksCreated };
}

/** Incremental — only documents whose content_hash has changed (or that are new) are re-processed; everything else is left untouched, per "Incremental indexing" (Task list). */
export function runIncrementalIndex(env: Env, logger: Logger, triggeredBy: number | null): Promise<IndexingRunSummary> {
  return runIndexing(env, logger, 'incremental', triggeredBy);
}

/** Full rebuild — every document is re-processed regardless of whether its content_hash matches, per "Full rebuild" (Task list). Use after a routing/embedding-model change, since a model change invalidates every existing vector's comparability. */
export function runFullRebuild(env: Env, logger: Logger, triggeredBy: number | null): Promise<IndexingRunSummary> {
  return runIndexing(env, logger, 'full_rebuild', triggeredBy);
}
