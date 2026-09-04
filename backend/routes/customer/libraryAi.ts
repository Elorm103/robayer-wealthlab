/**
 * POST /api/customer/library/ai/ask — Digital Library Phase 7C (AI
 * Reading Assistant). Thin HTTP layer only; all real logic lives in
 * services/libraryKnowledge/answerService.ts.
 *
 * Unlike routes/customer/aiAssistant.ts's public, unauthenticated
 * `/api/customer/ai-assistant/ask` (deliberately public by design —
 * see that file's own header comment), this route REQUIRES
 * requireCustomerAuth — the private assistant only ever answers about
 * a resource a specific, logged-in customer actually owns, and
 * answerService.ts's checkEntitlement() call re-verifies that on every
 * single request regardless of what this route already checked.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireCustomerAuth } from '../../middleware/requireCustomerAuth';
import { isNonEmptyString, isOneOf } from '../../utils/validation';
import { answerLibraryQuestion, type LibraryAiMode } from '../../services/libraryKnowledge/answerService';

/** Same "never let logging break the real operation" no-store posture as routes/customer/purchases.ts. */
function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(response.body, { status: response.status, headers });
}

const REFERENCE_PATTERN = /^RWL-\d{4}-\d{6,}$/;
function isPlausibleReference(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value);
}

const MODES: LibraryAiMode[] = ['explain', 'summarize', 'teach', 'example', 'quiz', 'key_takeaways', 'ask'];
const MAX_QUESTION_LENGTH = 500;

// Deliberately tighter than the public assistant's own 15/5min: every
// call here can trigger a real extraction+embedding pass on top of the
// chat completion (the first question about a resource), so the
// per-customer ceiling stays conservative. The real cost ceiling is
// still the AI Gateway's own shared daily/monthly/provider budgets
// (aiGatewayConfig.ts) — this limit exists to stop one customer from
// being able to exhaust that shared budget alone, not as the primary
// cost control.
const ASK_RATE_LIMIT = { endpoint: 'customer-library-ai-ask', limit: 10, windowSeconds: 5 * 60 };

interface AskBody {
  purchaseReference?: unknown;
  assetId?: unknown;
  mode?: unknown;
  question?: unknown;
  currentPage?: unknown;
  /** EPUB only — the reader's current chapter section href; see answerService.ts's own header comment on the 5-level context hierarchy this feeds LEVEL 1 (current chapter) from. */
  currentHref?: unknown;
}

export async function handleAskLibraryAi(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, ASK_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', "You've asked quite a few questions in a short time — please wait a few minutes and try again."));
  }

  let body: AskBody;
  try {
    body = await request.json();
  } catch {
    return withNoStore(jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.'));
  }

  if (!isPlausibleReference(body.purchaseReference)) {
    return withNoStore(jsonError('NOT_FOUND', 'This resource could not be found.'));
  }
  if (typeof body.assetId !== 'string' || body.assetId.length === 0) {
    return withNoStore(jsonError('VALIDATION_ERROR', 'A valid assetId is required.'));
  }
  if (!isOneOf(body.mode, MODES)) {
    return withNoStore(jsonError('VALIDATION_ERROR', `mode must be one of: ${MODES.join(', ')}.`));
  }
  const mode = body.mode as LibraryAiMode;
  if (mode === 'ask' && !isNonEmptyString(body.question, MAX_QUESTION_LENGTH)) {
    return withNoStore(jsonError('VALIDATION_ERROR', `A question is required for "ask" mode (up to ${MAX_QUESTION_LENGTH} characters).`));
  }
  // Every mode chip in the panel (js/components/library-ai-panel.js)
  // sends `question: ''` for every non-"ask" mode - an empty string is
  // the real, expected "not provided, use the mode default" shape from
  // the actual UI, not a malformed input. Found and fixed during this
  // exact verification: only a genuinely non-empty-but-invalid value
  // (wrong type, or over length) is rejected here.
  const hasQuestion = typeof body.question === 'string' && body.question.length > 0;
  if (mode !== 'ask' && hasQuestion && !isNonEmptyString(body.question, MAX_QUESTION_LENGTH)) {
    return withNoStore(jsonError('VALIDATION_ERROR', `question, if provided, must be a non-empty string up to ${MAX_QUESTION_LENGTH} characters.`));
  }
  const currentPage = typeof body.currentPage === 'number' && Number.isInteger(body.currentPage) && body.currentPage > 0 ? body.currentPage : null;
  // Length-capped the same way an EPUB spine href realistically is
  // (see epubChapterService.ts's own manifest hrefs) — not a security
  // boundary (answerService.ts's resolveCurrentChapter() only ever
  // matches it against this SAME authorized document's own chunks), just
  // rejecting an obviously-malformed value before it reaches a DB bind.
  const currentHref = typeof body.currentHref === 'string' && body.currentHref.length > 0 && body.currentHref.length <= 500 ? body.currentHref : null;

  try {
    const result = await answerLibraryQuestion(env, logger, {
      purchaseReference: body.purchaseReference,
      assetId: body.assetId,
      customerId: auth.auth.customerId,
      mode,
      question: typeof body.question === 'string' ? body.question : '',
      currentPage,
      currentHref,
    });

    if (!result.ok) {
      // Every denial reason maps to the same handful of generic,
      // customer-safe messages — same "never reveal which specific
      // check failed" discipline entitlementService.ts's own
      // EntitlementDenialReason mapping already established.
      if (result.reason === 'not_authorized') return withNoStore(jsonError('NOT_FOUND', 'This resource could not be found.'));
      if (result.reason === 'unsupported_format') return withNoStore(jsonError('UNSUPPORTED_FILE_TYPE', "The AI Reading Assistant isn't available yet for this file type."));
      if (result.reason === 'invalid_input') return withNoStore(jsonError('VALIDATION_ERROR', 'A question is required.'));
      return withNoStore(jsonError('AI_GATEWAY_ERROR', 'Something went wrong on our end. Please try again in a moment.'));
    }

    return withNoStore(jsonSuccess(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('library_ai.ask_failed', { error: message });
    return withNoStore(jsonError('AI_GATEWAY_ERROR', 'Something went wrong on our end. Please try again in a moment.'));
  }
}
