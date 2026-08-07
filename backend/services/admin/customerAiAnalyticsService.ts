/**
 * Customer AI analytics — Version 5.0 Milestone 3, Phase 6
 * (Observability). Read-only aggregation over `customer_ai_messages`/
 * `customer_ai_feedback` (migration 0039). Every turn already writes
 * here via services/customerAi/answerService.ts's logMessage(); this
 * only reads it back. Retrieval-level detail (which chunks, what raw
 * score) is additionally available via `knowledge_search_log`, since
 * every Customer AI turn calls the unmodified searchKnowledge(),
 * itself always logging there — reused, not duplicated.
 */

import type { Env } from '../../worker/env';

export interface CustomerAiConfidenceDistribution {
  high: number;
  medium: number;
  low: number;
  very_low: number;
}

export interface CustomerAiStatusCounts {
  answered: number;
  declined: number;
  error: number;
}

export interface RecentCustomerAiMessage {
  id: number;
  questionText: string;
  status: string;
  confidenceTier: string;
  totalLatencyMs: number;
  createdAt: string;
  feedback: 'helpful' | 'not_helpful' | null;
}

export interface CustomerAiAnalytics {
  totalMessages: number;
  statusCounts: CustomerAiStatusCounts;
  confidenceDistribution: CustomerAiConfidenceDistribution;
  feedback: { helpful: number; notHelpful: number; total: number };
  latencyMs: { avgRetrieval: number | null; avgLlm: number | null; avgTotal: number | null; p95Total: number | null };
  recentMessages: RecentCustomerAiMessage[];
}

function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

export async function getCustomerAiAnalytics(env: Env): Promise<CustomerAiAnalytics> {
  const [totalRow, statusRows, confidenceRows, feedbackRows, latencyAvgRow, totalLatencyRows, recentRows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM customer_ai_messages`).first<{ total: number }>(),
    env.DB.prepare(`SELECT status, COUNT(*) AS count FROM customer_ai_messages GROUP BY status`).all<{ status: string; count: number }>(),
    env.DB.prepare(`SELECT confidence_tier AS tier, COUNT(*) AS count FROM customer_ai_messages GROUP BY confidence_tier`).all<{ tier: string; count: number }>(),
    env.DB.prepare(`SELECT feedback, COUNT(*) AS count FROM customer_ai_feedback GROUP BY feedback`).all<{ feedback: string; count: number }>(),
    env.DB.prepare(`SELECT AVG(retrieval_latency_ms) AS avgRetrieval, AVG(llm_latency_ms) AS avgLlm, AVG(total_latency_ms) AS avgTotal FROM customer_ai_messages`).first<{
      avgRetrieval: number | null;
      avgLlm: number | null;
      avgTotal: number | null;
    }>(),
    env.DB.prepare(`SELECT total_latency_ms FROM customer_ai_messages ORDER BY id DESC LIMIT 2000`).all<{ total_latency_ms: number }>(),
    env.DB.prepare(
      `SELECT m.id, m.question_text AS questionText, m.status, m.confidence_tier AS confidenceTier, m.total_latency_ms AS totalLatencyMs, m.created_at AS createdAt, f.feedback AS feedback
       FROM customer_ai_messages m
       LEFT JOIN customer_ai_feedback f ON f.message_id = m.id
       ORDER BY m.id DESC LIMIT 25`
    ).all<RecentCustomerAiMessage>(),
  ]);

  const statusCounts: CustomerAiStatusCounts = { answered: 0, declined: 0, error: 0 };
  for (const row of statusRows.results) {
    if (row.status === 'answered' || row.status === 'declined' || row.status === 'error') statusCounts[row.status] = row.count;
  }

  const confidenceDistribution: CustomerAiConfidenceDistribution = { high: 0, medium: 0, low: 0, very_low: 0 };
  for (const row of confidenceRows.results) {
    if (row.tier in confidenceDistribution) confidenceDistribution[row.tier as keyof CustomerAiConfidenceDistribution] = row.count;
  }

  let helpful = 0;
  let notHelpful = 0;
  for (const row of feedbackRows.results) {
    if (row.feedback === 'helpful') helpful = row.count;
    if (row.feedback === 'not_helpful') notHelpful = row.count;
  }

  const sortedLatencies = totalLatencyRows.results.map((r) => r.total_latency_ms).sort((a, b) => a - b);

  return {
    totalMessages: totalRow?.total ?? 0,
    statusCounts,
    confidenceDistribution,
    feedback: { helpful, notHelpful, total: helpful + notHelpful },
    latencyMs: {
      avgRetrieval: round(latencyAvgRow?.avgRetrieval ?? null),
      avgLlm: round(latencyAvgRow?.avgLlm ?? null),
      avgTotal: round(latencyAvgRow?.avgTotal ?? null),
      p95Total: percentile(sortedLatencies, 0.95),
    },
    recentMessages: recentRows.results,
  };
}
