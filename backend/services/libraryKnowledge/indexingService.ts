/**
 * Private library indexing — Digital Library Phase 7C (AI Reading
 * Assistant). Extract -> chunk -> embed -> store, for ONE purchased
 * resource at a time. Deliberately synchronous and lazy (indexed on
 * the first AI question about a resource that has none yet, or whose
 * content_hash has changed), not the public Knowledge Base's two-phase
 * queue architecture (services/knowledge/indexingService.ts) — that
 * design exists to survive Cloudflare's per-invocation subrequest
 * budget across "hundreds or thousands of documents." This catalog has
 * 9 assets total; one document's extract/chunk/embed/upsert cycle
 * (confirmed directly: a handful of pages, a handful of chunks) is
 * nowhere near that budget, so the queue's own complexity would be
 * pure overbuilding here.
 *
 * Per-page chunking (chunkText() is called once per extracted page,
 * never across page boundaries) trades a small amount of chunk-
 * boundary quality (a paragraph split across two pages produces two
 * chunks instead of one) for a guarantee this phase's brief is
 * explicit about: every chunk's page_number is exactly, unambiguously
 * true, never a range or a guess.
 *
 * Content lives in D1 (library_knowledge_chunks); only the embedding
 * vector goes to LIBRARY_KNOWLEDGE_INDEX — the same "D1 holds the
 * structured record, a binding holds the large payload" split the
 * public Knowledge Base already established.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { embedText } from '../ai/aiGateway';
import { chunkText } from '../knowledge/chunking';
import { extractPdfText } from './pdfExtraction';
import { extractEpubText } from './epubExtraction';

const EMBEDDING_FEATURE = 'library.embed';
const EMBEDDING_MODEL = 'text-embedding-3-small';
/** Mirrors indexingService.ts's own EMBED_BATCH_SIZE reasoning — bounds one embed call's size. Irrelevant at this catalog's real scale (a handful of chunks per document) but kept for the same reason: a very long resource should never produce one oversized embed call. */
const EMBED_BATCH_SIZE = 96;

export type IndexResourceResult =
  | { status: 'indexed'; documentId: number; chunkCount: number }
  | { status: 'unsupported_format' }
  | { status: 'failed'; error: string };

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

interface ExistingDocumentRow {
  id: number;
  content_hash: string;
  status: string;
}

/**
 * Idempotent and repeatable: hashes the freshly-extracted text and
 * compares against the last-indexed hash for this exact (product_slug,
 * asset_id) — an unchanged file is a no-op, a changed one is a full
 * re-index (old chunks/vectors deleted only AFTER the new ones are
 * successfully written, mirroring the public Knowledge Base's own
 * versioning discipline — never a window with zero searchable
 * content).
 */
export async function ensureResourceIndexed(env: Env, logger: Logger, productSlug: string, assetId: string, fileType: 'PDF' | 'EPUB', fileBytes: ArrayBuffer): Promise<IndexResourceResult> {
  if (fileType !== 'PDF' && fileType !== 'EPUB') {
    await upsertDocumentRow(env, productSlug, assetId, fileType, null, '', 'unsupported_format', null);
    return { status: 'unsupported_format' };
  }

  // Build every chunk BEFORE writing anything, so a failure partway
  // through extraction/embedding never leaves a half-updated document.
  // pageNumber is real per-page for PDF (never for EPUB, which has no
  // fixed page count); cfi is real per-section for EPUB only (the
  // section's own href). chapterTitle is now real and populated for
  // BOTH formats (Phase 4): from the PDF's own outline/bookmark entry
  // covering that page, or from the EPUB section's own <title> tag
  // (falling back to its first heading) — see pdfExtraction.ts's and
  // epubExtraction.ts's own header comments on why the two formats'
  // chapter titles are expected to read identically for the same real
  // book, which is what lets searchService.ts's chapter-scoped lookup
  // use one (documentId, chapterTitle) key across either format.
  const pending: { pageNumber: number | null; chapterTitle: string | null; cfi: string | null; text: string; tokens: number }[] = [];
  let totalPages: number | null = null;
  let fullText: string;

  if (fileType === 'PDF') {
    let extracted: Awaited<ReturnType<typeof extractPdfText>>;
    try {
      extracted = await extractPdfText(fileBytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('library_knowledge.extraction_failed', { productSlug, assetId, error: message });
      await upsertDocumentRow(env, productSlug, assetId, fileType, null, '', 'failed', message);
      return { status: 'failed', error: message };
    }
    totalPages = extracted.totalPages;
    fullText = extracted.pages.map((p) => p.text).join('\n\n');
    for (const page of extracted.pages) {
      if (!page.text) continue; // a genuinely blank page (cover, divider) contributes nothing to index — not an error
      for (const chunk of chunkText(page.text)) {
        pending.push({ pageNumber: page.pageNumber, chapterTitle: page.chapterTitle, cfi: null, text: chunk.text, tokens: chunk.tokens });
      }
    }
  } else {
    let extracted: Awaited<ReturnType<typeof extractEpubText>>;
    try {
      extracted = await extractEpubText(fileBytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('library_knowledge.extraction_failed', { productSlug, assetId, error: message });
      await upsertDocumentRow(env, productSlug, assetId, fileType, null, '', 'failed', message);
      return { status: 'failed', error: message };
    }
    fullText = extracted.sections.map((s) => s.text).join('\n\n');
    for (const section of extracted.sections) {
      if (!section.text) continue; // a genuinely empty section contributes nothing to index — not an error
      for (const chunk of chunkText(section.text)) {
        // section.href (e.g. "ch01.xhtml") is stored in the reserved
        // `cfi` column, not a byte-precise EPUB CFI — this codebase's
        // own reader (epubRendition.display(item.href)) already accepts
        // a plain href interchangeably with a full CFI for navigation,
        // so a citation's "Read this section" link works identically
        // either way, without inventing a DOM-path CFI generator.
        pending.push({ pageNumber: null, chapterTitle: section.chapterTitle, cfi: section.href, text: chunk.text, tokens: chunk.tokens });
      }
    }
  }

  const contentHash = await sha256Hex(fullText);

  const existing = await env.DB.prepare(`SELECT id, content_hash, status FROM library_knowledge_documents WHERE product_slug = ? AND asset_id = ?`)
    .bind(productSlug, assetId)
    .first<ExistingDocumentRow>();

  if (existing && existing.content_hash === contentHash && existing.status === 'indexed') {
    const chunkCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM library_knowledge_chunks WHERE document_id = ?`).bind(existing.id).first<{ n: number }>();
    return { status: 'indexed', documentId: existing.id, chunkCount: chunkCount?.n ?? 0 };
  }

  if (pending.length === 0) {
    await upsertDocumentRow(env, productSlug, assetId, fileType, totalPages, contentHash, 'failed', 'No extractable text found in this file.');
    return { status: 'failed', error: 'No extractable text found in this file.' };
  }

  const embeddings: number[][] = [];
  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    const result = await embedText(env, logger, {
      feature: EMBEDDING_FEATURE,
      actorType: 'system',
      actorId: null,
      classification: 'CONFIDENTIAL',
      texts: batch.map((c) => c.text),
    });
    embeddings.push(...result.embeddings);
  }

  const documentId = await upsertDocumentRow(env, productSlug, assetId, fileType, totalPages, contentHash, 'indexed', null, pending.length);

  const vectorRecords = pending.map((chunk, i) => ({
    id: `library:${documentId}:${i}`,
    values: embeddings[i],
    metadata: { documentId, productSlug, assetId },
  }));
  await env.LIBRARY_KNOWLEDGE_INDEX.upsert(vectorRecords);

  // Old chunk rows (from a prior version of this document, if any) are
  // deleted only now, after the new vectors are already written —
  // never a window with zero searchable content for this resource.
  const oldChunks = existing ? await env.DB.prepare(`SELECT vector_id FROM library_knowledge_chunks WHERE document_id = ?`).bind(existing.id).all<{ vector_id: string }>() : null;
  if (oldChunks && oldChunks.results.length > 0) {
    await env.LIBRARY_KNOWLEDGE_INDEX.deleteByIds(oldChunks.results.map((r) => r.vector_id));
  }
  if (existing) {
    await env.DB.prepare(`DELETE FROM library_knowledge_chunks WHERE document_id = ?`).bind(existing.id).run();
  }

  await env.DB.batch(
    pending.map((chunk, i) =>
      env.DB.prepare(
        `INSERT INTO library_knowledge_chunks (document_id, chunk_index, chunk_text, chunk_tokens, page_number, chapter_title, cfi, vector_id, embedding_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(documentId, i, chunk.text, chunk.tokens, chunk.pageNumber, chunk.chapterTitle, chunk.cfi, vectorRecords[i].id, EMBEDDING_MODEL)
    )
  );

  return { status: 'indexed', documentId, chunkCount: pending.length };
}

async function upsertDocumentRow(
  env: Env,
  productSlug: string,
  assetId: string,
  fileType: 'PDF' | 'EPUB',
  totalPages: number | null,
  contentHash: string,
  status: 'indexed' | 'failed' | 'unsupported_format',
  errorMessage: string | null,
  chunkCount = 0
): Promise<number> {
  const existing = await env.DB.prepare(`SELECT id, version FROM library_knowledge_documents WHERE product_slug = ? AND asset_id = ?`)
    .bind(productSlug, assetId)
    .first<{ id: number; version: number }>();

  if (existing) {
    await env.DB.prepare(
      `UPDATE library_knowledge_documents
       SET total_pages = ?, content_hash = ?, status = ?, error_message = ?, chunk_count = ?, version = version + 1,
           indexed_at = CASE WHEN ? = 'indexed' THEN datetime('now') ELSE indexed_at END, updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(totalPages, contentHash, status, errorMessage, chunkCount, status, existing.id)
      .run();
    return existing.id;
  }

  const insert = await env.DB.prepare(
    `INSERT INTO library_knowledge_documents (product_slug, asset_id, source_type, total_pages, content_hash, status, error_message, chunk_count, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'indexed' THEN datetime('now') ELSE NULL END)`
  )
    .bind(productSlug, assetId, fileType, totalPages, contentHash, status, errorMessage, chunkCount, status)
    .run();
  return Number(insert.meta.last_row_id);
}
