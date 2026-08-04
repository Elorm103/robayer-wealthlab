/**
 * Knowledge Base admin dashboard — Version 5.0 Milestone 2. Read-only
 * aggregation over knowledge_documents/knowledge_indexing_runs/
 * knowledge_search_log for the admin "Knowledge Base" page
 * (routes/admin/knowledgeBase.ts). Writes to these tables happen only
 * in services/knowledge/indexingService.ts — this file never writes.
 *
 * Embedding cost/volume figures are read from `ai_usage_log` filtered
 * to `feature = 'knowledge.embed'` — the SAME table/mechanism the AI
 * Gateway dashboard (services/admin/settingsService.ts) already reads,
 * not a second, parallel cost-tracking mechanism. This is the concrete
 * meaning of "reuse the governance framework from Milestone 1.2."
 */

import type { Env } from '../../worker/env';
import type { KnowledgeSourceType } from '../knowledge/documentSources';

export type KnowledgeBaseHealth = 'healthy' | 'warning' | 'critical';

export interface KnowledgeBaseStatus {
  indexedCount: number;
  pendingCount: number;
  failedCount: number;
  totalDocuments: number;
  lastRun: {
    id: number;
    runType: 'incremental' | 'full_rebuild';
    status: 'running' | 'completed' | 'failed';
    startedAt: string;
    completedAt: string | null;
    documentsSeen: number;
    documentsIndexed: number;
    documentsUnchanged: number;
    documentsFailed: number;
    chunksCreated: number;
  } | null;
  health: KnowledgeBaseHealth;
  healthReason: string;
  storageStats: {
    totalChunks: number;
    totalDocumentsWithChunks: number;
    avgChunksPerDocument: number | null;
  };
  embeddingStats: {
    callCount30d: number;
    costUsdMicros30d: number;
    embeddingModel: string | null;
  };
  searchStats: {
    searchCount30d: number;
    avgLatencyMs30d: number | null;
    avgTopScore30d: number | null;
    lowConfidenceRatio30d: number | null;
  };
}

export async function getKnowledgeBaseStatus(env: Env): Promise<KnowledgeBaseStatus> {
  const [statusCounts, lastRunRow, chunkStats, embeddingRow, searchRow, embeddingModelRow] = await Promise.all([
    env.DB.prepare(`SELECT status, COUNT(*) AS c FROM knowledge_documents GROUP BY status`).all<{ status: string; c: number }>(),
    env.DB.prepare(`SELECT * FROM knowledge_indexing_runs ORDER BY id DESC LIMIT 1`).first<{
      id: number;
      run_type: 'incremental' | 'full_rebuild';
      status: 'running' | 'completed' | 'failed';
      started_at: string;
      completed_at: string | null;
      documents_seen: number;
      documents_indexed: number;
      documents_unchanged: number;
      documents_failed: number;
      chunks_created: number;
    }>(),
    env.DB.prepare(`SELECT COUNT(*) AS totalChunks, COUNT(DISTINCT document_id) AS totalDocs FROM knowledge_chunks`).first<{ totalChunks: number; totalDocs: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd_micros), 0) AS cost FROM ai_usage_log WHERE feature = 'knowledge.embed' AND created_at > datetime('now', '-30 days')`).first<{
      calls: number;
      cost: number;
    }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS searches, AVG(latency_ms) AS avgLatency, AVG(top_score) AS avgScore,
              SUM(CASE WHEN top_score IS NOT NULL AND top_score < 0.5 THEN 1 ELSE 0 END) AS lowConfCount
       FROM knowledge_search_log WHERE created_at > datetime('now', '-30 days')`
    ).first<{ searches: number; avgLatency: number | null; avgScore: number | null; lowConfCount: number }>(),
    env.DB.prepare(`SELECT model FROM ai_usage_log WHERE feature = 'knowledge.embed' AND succeeded = 1 ORDER BY id DESC LIMIT 1`).first<{ model: string }>(),
  ]);

  const countByStatus = (status: string) => statusCounts.results.find((r) => r.status === status)?.c ?? 0;
  const indexedCount = countByStatus('indexed');
  const pendingCount = countByStatus('pending');
  const failedCount = countByStatus('failed');
  const totalDocuments = statusCounts.results.reduce((sum, r) => sum + r.c, 0);

  let health: KnowledgeBaseHealth;
  let healthReason: string;
  if (!lastRunRow) {
    health = 'warning';
    healthReason = 'No indexing run has ever been performed.';
  } else if (lastRunRow.status === 'failed') {
    health = 'critical';
    healthReason = 'The most recent indexing run failed outright.';
  } else if (failedCount > 0) {
    health = 'warning';
    healthReason = `${failedCount} document(s) currently have status 'failed'.`;
  } else if (totalDocuments === 0) {
    health = 'warning';
    healthReason = 'No documents have been indexed yet.';
  } else {
    health = 'healthy';
    healthReason = 'All indexed documents are current; the most recent run completed successfully.';
  }

  const searches30d = searchRow?.searches ?? 0;

  return {
    indexedCount,
    pendingCount,
    failedCount,
    totalDocuments,
    lastRun: lastRunRow
      ? {
          id: lastRunRow.id,
          runType: lastRunRow.run_type,
          status: lastRunRow.status,
          startedAt: lastRunRow.started_at,
          completedAt: lastRunRow.completed_at,
          documentsSeen: lastRunRow.documents_seen,
          documentsIndexed: lastRunRow.documents_indexed,
          documentsUnchanged: lastRunRow.documents_unchanged,
          documentsFailed: lastRunRow.documents_failed,
          chunksCreated: lastRunRow.chunks_created,
        }
      : null,
    health,
    healthReason,
    storageStats: {
      totalChunks: chunkStats?.totalChunks ?? 0,
      totalDocumentsWithChunks: chunkStats?.totalDocs ?? 0,
      avgChunksPerDocument: chunkStats && chunkStats.totalDocs > 0 ? Math.round((chunkStats.totalChunks / chunkStats.totalDocs) * 10) / 10 : null,
    },
    embeddingStats: {
      callCount30d: embeddingRow?.calls ?? 0,
      costUsdMicros30d: embeddingRow?.cost ?? 0,
      embeddingModel: embeddingModelRow?.model ?? null,
    },
    searchStats: {
      searchCount30d: searches30d,
      avgLatencyMs30d: searchRow?.avgLatency != null ? Math.round(searchRow.avgLatency) : null,
      avgTopScore30d: searchRow?.avgScore != null ? Math.round(searchRow.avgScore * 1000) / 1000 : null,
      lowConfidenceRatio30d: searches30d > 0 ? Math.round(((searchRow!.lowConfCount / searches30d) * 100 + Number.EPSILON) * 10) / 10 : null,
    },
  };
}

export interface KnowledgeDocumentListItem {
  id: number;
  documentKey: string;
  sourceType: KnowledgeSourceType;
  sourceUrl: string | null;
  title: string;
  status: 'pending' | 'indexed' | 'failed';
  errorMessage: string | null;
  chunkCount: number;
  version: number;
  indexedAt: string | null;
  updatedAt: string;
}

export interface KnowledgeDocumentFilters {
  status?: 'pending' | 'indexed' | 'failed';
  sourceType?: KnowledgeSourceType;
  search?: string;
}

export async function listKnowledgeDocuments(
  env: Env,
  filters: KnowledgeDocumentFilters,
  page: number,
  pageSize: number
): Promise<{ items: KnowledgeDocumentListItem[]; total: number; page: number; pageSize: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  if (filters.sourceType) {
    clauses.push('source_type = ?');
    params.push(filters.sourceType);
  }
  if (filters.search && filters.search.trim().length > 0) {
    clauses.push('(title LIKE ? OR document_key LIKE ?)');
    const term = `%${filters.search.trim()}%`;
    params.push(term, term);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const offset = (page - 1) * pageSize;

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(`SELECT * FROM knowledge_documents ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .bind(...params, pageSize, offset)
      .all<{
        id: number;
        document_key: string;
        source_type: KnowledgeSourceType;
        source_url: string | null;
        title: string;
        status: 'pending' | 'indexed' | 'failed';
        error_message: string | null;
        chunk_count: number;
        version: number;
        indexed_at: string | null;
        updated_at: string;
      }>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM knowledge_documents ${where}`)
      .bind(...params)
      .first<{ total: number }>(),
  ]);

  return {
    items: rows.results.map((r) => ({
      id: r.id,
      documentKey: r.document_key,
      sourceType: r.source_type,
      sourceUrl: r.source_url,
      title: r.title,
      status: r.status,
      errorMessage: r.error_message,
      chunkCount: r.chunk_count,
      version: r.version,
      indexedAt: r.indexed_at,
      updatedAt: r.updated_at,
    })),
    total: countRow?.total ?? 0,
    page,
    pageSize,
  };
}

export interface IndexingRunListItem {
  id: number;
  runType: 'incremental' | 'full_rebuild';
  triggerType: 'admin_manual' | 'content_change';
  status: 'running' | 'completed' | 'failed';
  documentsSeen: number;
  documentsIndexed: number;
  documentsUnchanged: number;
  documentsFailed: number;
  chunksCreated: number;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export async function listIndexingRuns(env: Env, page: number, pageSize: number): Promise<{ items: IndexingRunListItem[]; total: number; page: number; pageSize: number }> {
  const offset = (page - 1) * pageSize;
  const [rows, countRow] = await Promise.all([
    env.DB.prepare(`SELECT * FROM knowledge_indexing_runs ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(pageSize, offset)
      .all<{
        id: number;
        run_type: 'incremental' | 'full_rebuild';
        trigger_type: 'admin_manual' | 'content_change';
        status: 'running' | 'completed' | 'failed';
        documents_seen: number;
        documents_indexed: number;
        documents_unchanged: number;
        documents_failed: number;
        chunks_created: number;
        started_at: string;
        completed_at: string | null;
        error_message: string | null;
      }>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM knowledge_indexing_runs`).first<{ total: number }>(),
  ]);

  return {
    items: rows.results.map((r) => ({
      id: r.id,
      runType: r.run_type,
      triggerType: r.trigger_type,
      status: r.status,
      documentsSeen: r.documents_seen,
      documentsIndexed: r.documents_indexed,
      documentsUnchanged: r.documents_unchanged,
      documentsFailed: r.documents_failed,
      chunksCreated: r.chunks_created,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      errorMessage: r.error_message,
    })),
    total: countRow?.total ?? 0,
    page,
    pageSize,
  };
}
