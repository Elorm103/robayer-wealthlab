/**
 * Unit tests: searchService.ts's resolveCurrentChapter() / getChapterChunks()
 * — Phase 4 (Robayer AI chapter-context architecture). Direct D1-row
 * tests (no extraction/embedding pipeline involved) isolating exactly
 * the security/correctness property these two functions exist to
 * guarantee: chapter identity resolution and retrieval are ALWAYS
 * scoped by document_id, never by chapter_title/cfi text alone — two
 * different books can legitimately share an identical chapter_title
 * (e.g. two books both have a "Chapter 1: Introduction") and must never
 * cross-contaminate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { resolveCurrentChapter, getChapterChunks } from '../../../services/libraryKnowledge/searchService';

async function insertDocument(productSlug: string, assetId: string, sourceType: 'PDF' | 'EPUB'): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO library_knowledge_documents (product_slug, asset_id, source_type, content_hash, status, chunk_count, indexed_at) VALUES (?, ?, ?, 'hash', 'indexed', 0, datetime('now'))`
  )
    .bind(productSlug, assetId, sourceType)
    .run();
  return Number(insert.meta.last_row_id);
}

async function insertChunk(documentId: number, chunkIndex: number, text: string, pageNumber: number | null, chapterTitle: string | null, cfi: string | null): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO library_knowledge_chunks (document_id, chunk_index, chunk_text, chunk_tokens, page_number, chapter_title, cfi, vector_id, embedding_model) VALUES (?, ?, ?, 10, ?, ?, ?, ?, 'text-embedding-3-small')`
  )
    .bind(documentId, chunkIndex, text, pageNumber, chapterTitle, cfi, `vec:${documentId}:${chunkIndex}`)
    .run();
  return Number(insert.meta.last_row_id);
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM library_knowledge_chunks');
  await env.DB.exec('DELETE FROM library_knowledge_documents');
});

describe('resolveCurrentChapter() — PDF (by page number)', () => {
  it('resolves the real chapter_title covering the given page', async () => {
    const docId = await insertDocument('book-x', 'asset-x', 'PDF');
    await insertChunk(docId, 0, 'cover text', 1, null, null);
    await insertChunk(docId, 1, 'chapter 1 text', 2, 'Chapter 1: Intro', null);
    await insertChunk(docId, 2, 'chapter 2 text', 3, 'Chapter 2: Growth', null);

    const result = await resolveCurrentChapter(env as any, docId, { currentPage: 3 });
    expect(result).not.toBeNull();
    expect(result!.chapterTitle).toBe('Chapter 2: Growth');
    expect(result!.cfi).toBeNull();
  });

  it('returns null for a page that precedes any real chapter (front matter/cover)', async () => {
    const docId = await insertDocument('book-x', 'asset-x', 'PDF');
    await insertChunk(docId, 0, 'cover text', 1, null, null);

    const result = await resolveCurrentChapter(env as any, docId, { currentPage: 1 });
    expect(result).toBeNull();
  });

  it('returns null for a page number that does not exist in this document at all — never fabricates or falls back to another page', async () => {
    const docId = await insertDocument('book-x', 'asset-x', 'PDF');
    await insertChunk(docId, 0, 'chapter 1 text', 2, 'Chapter 1: Intro', null);

    const result = await resolveCurrentChapter(env as any, docId, { currentPage: 999 });
    expect(result).toBeNull();
  });

  it('SECURITY: an identical page number in a DIFFERENT document never resolves this document\'s chapter — always scoped by document_id', async () => {
    const docA = await insertDocument('book-a', 'asset-a', 'PDF');
    const docB = await insertDocument('book-b', 'asset-b', 'PDF');
    await insertChunk(docA, 0, 'book A chapter text', 5, 'Chapter 3: Book A Only', null);
    await insertChunk(docB, 0, 'book B chapter text', 5, 'Chapter 9: Book B Only', null);

    const resultForA = await resolveCurrentChapter(env as any, docA, { currentPage: 5 });
    expect(resultForA!.chapterTitle).toBe('Chapter 3: Book A Only');

    const resultForB = await resolveCurrentChapter(env as any, docB, { currentPage: 5 });
    expect(resultForB!.chapterTitle).toBe('Chapter 9: Book B Only');
  });
});

describe('resolveCurrentChapter() — EPUB (by section href)', () => {
  it('resolves the real chapter_title/cfi for a genuine section href in this document', async () => {
    const docId = await insertDocument('book-y', 'asset-y', 'EPUB');
    await insertChunk(docId, 0, 'chapter 1 text', null, 'Chapter 1: Intro', 'ch1.xhtml');
    await insertChunk(docId, 1, 'chapter 2 text', null, 'Chapter 2: Growth', 'ch2.xhtml');

    const result = await resolveCurrentChapter(env as any, docId, { currentHref: 'ch2.xhtml' });
    expect(result).not.toBeNull();
    expect(result!.chapterTitle).toBe('Chapter 2: Growth');
    expect(result!.cfi).toBe('ch2.xhtml');
  });

  it('returns null for an href that does not exist in this document — never a partial/fuzzy match', async () => {
    const docId = await insertDocument('book-y', 'asset-y', 'EPUB');
    await insertChunk(docId, 0, 'chapter 1 text', null, 'Chapter 1: Intro', 'ch1.xhtml');

    const result = await resolveCurrentChapter(env as any, docId, { currentHref: 'ch1.xhtml#section2' }); // a fragment-suffixed variant, NOT an exact match
    expect(result).toBeNull();
  });

  it('SECURITY: an identical href in a DIFFERENT document never resolves this document\'s chapter — always scoped by document_id', async () => {
    const docA = await insertDocument('book-a', 'asset-a', 'EPUB');
    const docB = await insertDocument('book-b', 'asset-b', 'EPUB');
    await insertChunk(docA, 0, 'book A chapter text', null, 'Chapter 1: Book A', 'ch1.xhtml');
    await insertChunk(docB, 0, 'book B chapter text', null, 'Chapter 1: Book B', 'ch1.xhtml');

    const resultForA = await resolveCurrentChapter(env as any, docA, { currentHref: 'ch1.xhtml' });
    expect(resultForA!.chapterTitle).toBe('Chapter 1: Book A');

    const resultForB = await resolveCurrentChapter(env as any, docB, { currentHref: 'ch1.xhtml' });
    expect(resultForB!.chapterTitle).toBe('Chapter 1: Book B');
  });
});

describe('getChapterChunks()', () => {
  it('returns every chunk of a chapter, in real reading order (chunk_index), never a similarity-ranked subset', async () => {
    const docId = await insertDocument('book-z', 'asset-z', 'PDF');
    await insertChunk(docId, 0, 'chapter 1 chunk 0', 2, 'Chapter 1', null);
    await insertChunk(docId, 2, 'chapter 1 chunk 2 (out of insertion order)', 2, 'Chapter 1', null);
    await insertChunk(docId, 1, 'chapter 1 chunk 1', 2, 'Chapter 1', null);
    await insertChunk(docId, 3, 'chapter 2 chunk', 3, 'Chapter 2', null);

    const chunks = await getChapterChunks(env as any, docId, { chapterTitle: 'Chapter 1', cfi: null });
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    expect(chunks.every((c) => c.chunkText.includes('chapter 1'))).toBe(true);
  });

  it('SECURITY: never returns chunks from a different document, even with an identical chapter_title', async () => {
    const docA = await insertDocument('book-a', 'asset-a', 'PDF');
    const docB = await insertDocument('book-b', 'asset-b', 'PDF');
    await insertChunk(docA, 0, 'book A chapter 1 content', 2, 'Chapter 1', null);
    await insertChunk(docB, 0, 'book B chapter 1 content', 2, 'Chapter 1', null);

    const chunksForA = await getChapterChunks(env as any, docA, { chapterTitle: 'Chapter 1', cfi: null });
    expect(chunksForA).toHaveLength(1);
    expect(chunksForA[0].chunkText).toContain('book A');

    const chunksForB = await getChapterChunks(env as any, docB, { chapterTitle: 'Chapter 1', cfi: null });
    expect(chunksForB).toHaveLength(1);
    expect(chunksForB[0].chunkText).toContain('book B');
  });

  it('returns an empty array (never throws) when the chapter identity is empty/unresolved', async () => {
    const docId = await insertDocument('book-z', 'asset-z', 'PDF');
    const chunks = await getChapterChunks(env as any, docId, { chapterTitle: null, cfi: null });
    expect(chunks).toEqual([]);
  });
});
