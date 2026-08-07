/**
 * POST /api/customer/ai-assistant/ask, POST /api/customer/ai-assistant/feedback
 * — Version 5.0 Milestone 3 (Customer AI). Thin HTTP layer only; all
 * real logic lives in services/customerAi/answerService.ts.
 *
 * Deliberately public — no requireCustomerAuth/requireCustomerCsrf.
 * This is a marketing/education surface any site visitor should be
 * able to use, not an account feature; abuse protection is IP-based
 * rate limiting (middleware/rateLimit.ts), the same mechanism this
 * project already uses for newsletter/contact/consultation, its other
 * unauthenticated public endpoints.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { isNonEmptyString, isOneOf } from '../../utils/validation';
import { answerCustomerQuestion, submitFeedback, type ConversationTurn } from '../../services/customerAi/answerService';

// Deliberately tighter than most of this project's other public
// endpoints (newsletter: 5/60s) — every request here makes a real,
// governed AI Gateway call (retrieval embed + chat completion), so the
// budget-conscious posture from Milestone 1.2 extends to rate limiting
// too: enough for a genuine back-and-forth conversation, not enough for
// automated scraping.
const ASK_RATE_LIMIT = { endpoint: 'customer-ai-ask', limit: 15, windowSeconds: 5 * 60 };
const FEEDBACK_RATE_LIMIT = { endpoint: 'customer-ai-feedback', limit: 30, windowSeconds: 5 * 60 };

const MAX_QUESTION_LENGTH = 500;
const MAX_HISTORY_TURNS = 10; // generous upper bound at the route layer; answerService itself only ever uses the last 4

function isValidHistory(value: unknown): value is ConversationTurn[] {
  if (!Array.isArray(value)) return false;
  if (value.length > MAX_HISTORY_TURNS) return false;
  return value.every((turn) => typeof turn === 'object' && turn !== null && isNonEmptyString((turn as Record<string, unknown>).question, MAX_QUESTION_LENGTH) && isNonEmptyString((turn as Record<string, unknown>).answer, 4000));
}

export async function handleAskCustomerAi(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, ASK_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', "You've asked quite a few questions in a short time — please wait a few minutes and try again.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.');
  }

  const { question, history, sessionId } = (body ?? {}) as { question?: unknown; history?: unknown; sessionId?: unknown };

  if (!isNonEmptyString(question, MAX_QUESTION_LENGTH)) {
    return jsonError('VALIDATION_ERROR', `A question is required (up to ${MAX_QUESTION_LENGTH} characters).`);
  }
  if (history !== undefined && !isValidHistory(history)) {
    return jsonError('VALIDATION_ERROR', 'Conversation history, if provided, must be a valid list of prior question/answer turns.');
  }
  if (!isNonEmptyString(sessionId, 100)) {
    return jsonError('VALIDATION_ERROR', 'A sessionId is required.');
  }

  try {
    const result = await answerCustomerQuestion(env, logger, {
      question,
      history: history as ConversationTurn[] | undefined,
      sessionId,
    });
    return jsonSuccess(result);
  } catch (err) {
    // answerCustomerQuestion() already catches AI Gateway failures
    // internally and returns a graceful status: 'error' response — a
    // throw escaping it entirely means something more fundamental
    // broke (e.g. D1 itself unreachable). Still never a raw 500 with
    // an internal error message to the customer.
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('customer_ai.ask_failed', { error: message });
    return jsonError('AI_GATEWAY_ERROR', "Something went wrong on our end. Please try again in a moment.");
  }
}

export async function handleCustomerAiFeedback(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, FEEDBACK_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.');
  }

  const { messageId, feedback } = (body ?? {}) as { messageId?: unknown; feedback?: unknown };

  if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId <= 0) {
    return jsonError('VALIDATION_ERROR', 'A valid messageId is required.');
  }
  if (!isOneOf(feedback, ['helpful', 'not_helpful'] as const)) {
    return jsonError('VALIDATION_ERROR', 'feedback must be "helpful" or "not_helpful".');
  }

  const result = await submitFeedback(env, logger, messageId, feedback);
  return jsonSuccess({ recorded: result.ok });
}
