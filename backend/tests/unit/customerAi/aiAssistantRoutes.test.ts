/**
 * Route-level tests: POST /api/customer/ai-assistant/ask + /feedback —
 * Version 5.0 Milestone 3, Phase 7. Calls the exported handlers
 * directly (not SELF.fetch through the real Worker) with a fake
 * Vectorize binding substituted in, the same reason
 * tests/unit/knowledge never route-test the Knowledge Base admin
 * endpoints through SELF.fetch either — see
 * tests/knowledgeTestHelpers.ts's header comment: Vectorize has no
 * local Miniflare simulation, only real bindings or this fake.
 * KV (rate limiting) and D1 both work locally, so those ARE exercised
 * for real here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createLogger } from '../../../utils/logger';
import { handleAskCustomerAi, handleCustomerAiFeedback } from '../../../routes/customer/aiAssistant';
import { createFakeVectorizeIndex } from '../../knowledgeTestHelpers';

const logger = createLogger('test-request-id', 'test');

function envWithFakeVectorize() {
  return { ...(env as any), KNOWLEDGE_INDEX: createFakeVectorizeIndex() };
}

function askRequest(body: unknown, ip: string): Request {
  return new Request('https://example.com/api/customer/ai-assistant/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

function feedbackRequest(body: unknown, ip: string): Request {
  return new Request('https://example.com/api/customer/ai-assistant/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

async function clearAll(): Promise<void> {
  await env.DB.exec('DELETE FROM customer_ai_message_citations');
  await env.DB.exec('DELETE FROM customer_ai_feedback');
  await env.DB.exec('DELETE FROM customer_ai_messages');
  await env.DB.exec('DELETE FROM knowledge_search_log');
  await env.DB.exec('DELETE FROM knowledge_chunks');
  await env.DB.exec('DELETE FROM knowledge_documents');
  await env.DB.exec('DELETE FROM ai_usage_log');
  // Rate-limit KV keys are per-IP; every test below uses its own
  // dedicated IP address, so no cleanup of RATE_LIMIT_KV is needed.
}

describe('POST /api/customer/ai-assistant/ask — validation', () => {
  beforeEach(clearAll);

  it('rejects a non-JSON body', async () => {
    const request = new Request('https://example.com/api/customer/ai-assistant/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
      body: 'not json',
    });
    const res = await handleAskCustomerAi(request, envWithFakeVectorize(), logger);
    const body = await res.json<any>();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a missing question', async () => {
    const res = await handleAskCustomerAi(askRequest({ sessionId: 'sess-1' }, '203.0.113.11'), envWithFakeVectorize(), logger);
    expect(res.status).toBe(400);
  });

  it('rejects a question over the 500-character limit', async () => {
    const res = await handleAskCustomerAi(askRequest({ question: 'x'.repeat(501), sessionId: 'sess-2' }, '203.0.113.12'), envWithFakeVectorize(), logger);
    expect(res.status).toBe(400);
  });

  it('rejects a missing sessionId', async () => {
    const res = await handleAskCustomerAi(askRequest({ question: 'What is a treasury bill?' }, '203.0.113.13'), envWithFakeVectorize(), logger);
    expect(res.status).toBe(400);
  });

  it('rejects malformed history (missing answer field)', async () => {
    const res = await handleAskCustomerAi(
      askRequest({ question: 'What is a treasury bill?', sessionId: 'sess-3', history: [{ question: 'Hi' }] }, '203.0.113.14'),
      envWithFakeVectorize(),
      logger
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/customer/ai-assistant/ask — success path', () => {
  beforeEach(clearAll);

  it('returns a declined, grounded response for a question with no matching Knowledge Base content', async () => {
    const res = await handleAskCustomerAi(askRequest({ question: 'a question matching nothing at all', sessionId: 'sess-success' }, '203.0.113.20'), envWithFakeVectorize(), logger);
    const body = await res.json<any>();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('declined');
    expect(body.data.confidenceTier).toBe('very_low');
    expect(body.data.answer).toBeNull();
    expect(body.data.messageId).toBeGreaterThan(0);
  });
});

describe('POST /api/customer/ai-assistant/ask — rate limiting', () => {
  beforeEach(clearAll);

  it('the 16th request within the window is rejected with RATE_LIMITED (limit is 15/5min)', async () => {
    const ip = '203.0.113.30';
    const testEnv = envWithFakeVectorize(); // empty index — every call declines fast, without an LLM call
    const results: any[] = [];
    for (let i = 0; i < 16; i++) {
      const res = await handleAskCustomerAi(askRequest({ question: `question number ${i}`, sessionId: 'sess-ratelimit' }, ip), testEnv, logger);
      results.push(await res.json());
    }

    for (let i = 0; i < 15; i++) {
      expect(results[i].success).toBe(true);
    }
    expect(results[15].success).toBe(false);
    expect(results[15].error.code).toBe('RATE_LIMITED');
  }, 30_000);
});

describe('POST /api/customer/ai-assistant/feedback', () => {
  beforeEach(clearAll);

  async function seedLoggedMessage(): Promise<number> {
    const insert = await env.DB.prepare(
      `INSERT INTO customer_ai_messages (session_id, question_text, answer_text, status, confidence_tier, top_score, retrieval_latency_ms, llm_latency_ms, total_latency_ms)
       VALUES ('sess-fb', 'A question', 'An answer', 'answered', 'high', 0.9, 100, 200, 300)`
    ).run();
    return Number(insert.meta.last_row_id);
  }

  it('rejects a missing/invalid messageId', async () => {
    const res = await handleCustomerAiFeedback(feedbackRequest({ messageId: 'not-a-number', feedback: 'helpful' }, '203.0.113.40'), env as any, logger);
    expect(res.status).toBe(400);
  });

  it('rejects an invalid feedback value', async () => {
    const messageId = await seedLoggedMessage();
    const res = await handleCustomerAiFeedback(feedbackRequest({ messageId, feedback: 'love it' }, '203.0.113.41'), env as any, logger);
    expect(res.status).toBe(400);
  });

  it('records valid feedback', async () => {
    const messageId = await seedLoggedMessage();
    const res = await handleCustomerAiFeedback(feedbackRequest({ messageId, feedback: 'helpful' }, '203.0.113.42'), env as any, logger);
    const body = await res.json<any>();
    expect(res.status).toBe(200);
    expect(body.data.recorded).toBe(true);
  });

  it('the 31st request within the window is rejected with RATE_LIMITED (limit is 30/5min)', async () => {
    const ip = '203.0.113.50';
    const messageId = await seedLoggedMessage();
    const results: any[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await handleCustomerAiFeedback(feedbackRequest({ messageId, feedback: 'helpful' }, ip), env as any, logger);
      results.push(await res.json());
    }

    for (let i = 0; i < 30; i++) {
      expect(results[i].success).toBe(true);
    }
    expect(results[30].success).toBe(false);
    expect(results[30].error.code).toBe('RATE_LIMITED');
  }, 30_000);
});
