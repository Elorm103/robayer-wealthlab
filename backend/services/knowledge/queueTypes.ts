/**
 * Knowledge Base indexing queue message shape — Version 5.0 Milestone
 * 2.1. Split into its own file (rather than living in indexingService.ts
 * or worker/env.ts) so both can import it without a circular dependency
 * — worker/env.ts needs it for the Queue<T> binding type, and
 * indexingService.ts needs it for both the producer (planning phase)
 * and consumer (queue batch processor) sides.
 *
 * Carries everything finalizeDocument() needs — including the already-
 * computed chunks — so the queue consumer never has to re-fetch or
 * re-chunk a document; only D1/Vectorize/embedding calls happen there.
 */
import type { KnowledgeSourceType } from './documentSources';
import type { TextChunk } from './chunking';

export interface KnowledgeIndexQueueMessage {
  runId: number;
  /** The knowledge_documents.id already created (status='pending') during planning. */
  documentId: number;
  contentHash: string;
  /** Whether this document_key already had a knowledge_documents row before this run — controls version-bump and old-vector-cleanup behavior in finalizeDocument(). */
  wasPreExisting: boolean;
  documentKey: string;
  sourceType: KnowledgeSourceType;
  sourceId: number | null;
  sourceUrl: string | null;
  title: string;
  dataClassification: string;
  faqs: { question: string; answer: string }[];
  chunks: TextChunk[];
}
