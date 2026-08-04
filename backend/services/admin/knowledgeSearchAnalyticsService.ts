/**
 * Knowledge Base search analytics — Version 5.0 Milestone 2.2, Task 4.
 * Read-only aggregation over `knowledge_search_log` (Milestone 2's own
 * table, extended with `top_document_id` in migration 0038 — no new
 * logging mechanism, reusing what already exists). The beginning of
 * search observability: which queries are common, which return
 * nothing, how confident results tend to be, which documents actually
 * get surfaced, and whether confidence is trending down over time.
 *
 * Confidence buckets here are recomputed from the stored `top_score`
 * via services/knowledge/ranking.ts's own `scoreToConfidence()` at read
 * time, rather than a separately-stored bucket column — so this
 * dashboard automatically reflects whatever the CURRENT calibration is
 * (see the Milestone 2.2 Confidence Calibration Report), not whatever
 * bucket a score happened to fall into on the day it was searched.
 */

import type { Env } from '../../worker/env';
import { scoreToConfidence, CONFIDENCE_MEDIUM_THRESHOLD } from '../knowledge/ranking';

export interface QueryCount {
  query: string;
  count: number;
}

export interface RetrievedDocumentCount {
  documentId: number;
  title: string;
  count: number;
}

export interface ConfidenceDistribution {
  high: number;
  medium: number;
  low: number;
  /** Zero-result searches — no top score to bucket at all. */
  none: number;
}

export interface LowConfidenceTrendPoint {
  date: string;
  totalSearches: number;
  lowConfidenceCount: number;
}

export interface SearchAnalytics {
  totalSearches: number;
  mostCommonSearches: QueryCount[];
  zeroResultSearches: QueryCount[];
  avgConfidenceScore: number | null;
  confidenceDistribution: ConfidenceDistribution;
  mostRetrievedDocuments: RetrievedDocumentCount[];
  /** Percent of searches (0-100) that returned at least one result. */
  searchSuccessRate: number | null;
  latencyMs: { p50: number | null; p95: number | null; max: number | null };
  /** Last 14 days, oldest first. */
  lowConfidenceTrend: LowConfidenceTrendPoint[];
}

function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}

export async function getSearchAnalytics(env: Env): Promise<SearchAnalytics> {
  const [totalRow, mostCommonRows, zeroResultRows, avgConfRow, scoreRows, topDocRows, latencyRows, trendRows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN result_count > 0 THEN 1 ELSE 0 END) AS withResults FROM knowledge_search_log`).first<{ total: number; withResults: number }>(),
    env.DB.prepare(`SELECT query_text AS query, COUNT(*) AS count FROM knowledge_search_log GROUP BY query_text ORDER BY count DESC, query_text ASC LIMIT 10`).all<{ query: string; count: number }>(),
    env.DB.prepare(`SELECT query_text AS query, COUNT(*) AS count FROM knowledge_search_log WHERE result_count = 0 GROUP BY query_text ORDER BY count DESC, query_text ASC LIMIT 10`).all<{
      query: string;
      count: number;
    }>(),
    env.DB.prepare(`SELECT AVG(top_score) AS avg FROM knowledge_search_log WHERE top_score IS NOT NULL`).first<{ avg: number | null }>(),
    // Bucketed in JS via the single real scoreToConfidence() implementation, not duplicated SQL thresholds — capped to the most recent 2000 rows so this stays a cheap read as history grows.
    env.DB.prepare(`SELECT top_score FROM knowledge_search_log ORDER BY id DESC LIMIT 2000`).all<{ top_score: number | null }>(),
    env.DB.prepare(
      `SELECT ksl.top_document_id AS documentId, kd.title AS title, COUNT(*) AS count
       FROM knowledge_search_log ksl
       JOIN knowledge_documents kd ON kd.id = ksl.top_document_id
       WHERE ksl.top_document_id IS NOT NULL
       GROUP BY ksl.top_document_id ORDER BY count DESC LIMIT 10`
    ).all<{ documentId: number; title: string; count: number }>(),
    env.DB.prepare(`SELECT latency_ms FROM knowledge_search_log ORDER BY id DESC LIMIT 2000`).all<{ latency_ms: number }>(),
    env.DB.prepare(
      `SELECT date(created_at) AS date, COUNT(*) AS total, SUM(CASE WHEN top_score IS NOT NULL AND top_score < ? THEN 1 ELSE 0 END) AS lowCount
       FROM knowledge_search_log WHERE created_at > datetime('now', '-14 days')
       GROUP BY date(created_at) ORDER BY date ASC`
    )
      .bind(CONFIDENCE_MEDIUM_THRESHOLD)
      .all<{ date: string; total: number; lowCount: number }>(),
  ]);

  const totalSearches = totalRow?.total ?? 0;
  const withResults = totalRow?.withResults ?? 0;

  const confidenceDistribution: ConfidenceDistribution = { high: 0, medium: 0, low: 0, none: 0 };
  for (const row of scoreRows.results) {
    if (row.top_score === null) confidenceDistribution.none++;
    else confidenceDistribution[scoreToConfidence(row.top_score)]++;
  }

  const sortedLatencies = latencyRows.results.map((r) => r.latency_ms).sort((a, b) => a - b);

  return {
    totalSearches,
    mostCommonSearches: mostCommonRows.results,
    zeroResultSearches: zeroResultRows.results,
    avgConfidenceScore: avgConfRow?.avg != null ? Math.round(avgConfRow.avg * 1000) / 1000 : null,
    confidenceDistribution,
    mostRetrievedDocuments: topDocRows.results,
    searchSuccessRate: totalSearches > 0 ? Math.round(((withResults / totalSearches) * 100 + Number.EPSILON) * 10) / 10 : null,
    latencyMs: {
      p50: percentile(sortedLatencies, 0.5),
      p95: percentile(sortedLatencies, 0.95),
      max: sortedLatencies.length > 0 ? sortedLatencies[sortedLatencies.length - 1] : null,
    },
    lowConfidenceTrend: trendRows.results.map((r) => ({ date: r.date, totalSearches: r.total, lowConfidenceCount: r.lowCount })),
  };
}
