/**
 * GET/POST /api/newsletter/unsubscribe/:token — see
 * docs/newsletter-unsubscribe-design.md. Thin HTTP layer only: the
 * GET is a safe, non-mutating status check (what the visible footer
 * link in an email points to, and what a link-scanner/prefetcher can
 * safely hit without unsubscribing anyone); the POST is the actual
 * mutating confirm action, and is also the URL Resend's
 * `List-Unsubscribe`/`List-Unsubscribe-Post` headers point mail
 * clients' native one-click "Unsubscribe" button at (RFC 8058) — both
 * verbs share the same token-based identification, deliberately.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonError, jsonSuccess } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';
import { getUnsubscribeStatus, confirmUnsubscribe, type ConfirmUnsubscribeReason } from '../services/unsubscribeService';
import type { ApiErrorCode } from '../types/api-contracts';

const RATE_LIMIT = { endpoint: 'newsletter-unsubscribe', limit: 20, windowSeconds: 60 };

// Keyed on the broader ConfirmUnsubscribeReason (POST's reason set) —
// a strict superset of GET's TokenLookupReason, so both handlers can
// safely index into the same maps.
const REASON_TO_CODE: Record<ConfirmUnsubscribeReason, ApiErrorCode> = {
  token_not_found: 'TOKEN_NOT_FOUND',
  token_expired: 'TOKEN_EXPIRED',
  // Reuses the existing TOKEN_ALREADY_USED code (already defined for
  // download tokens) rather than adding a new one — this endpoint only
  // ever returns it for the resubscribed-since-this-token-was-used
  // case (a genuine replay now returns ok:true instead, see
  // confirmUnsubscribe()), so there's no ambiguity with any other case.
  token_stale: 'TOKEN_ALREADY_USED',
};

const REASON_TO_MESSAGE: Record<ConfirmUnsubscribeReason, string> = {
  token_not_found: 'This unsubscribe link is invalid.',
  token_expired: 'This unsubscribe link has expired. Please email hello@robayerwealthlab.com and we’ll remove you right away.',
  token_stale: 'This unsubscribe link is no longer valid because your subscription has changed. Please contact hello@robayerwealthlab.com if you would like to unsubscribe.',
};

export async function handleUnsubscribeStatus(request: Request, env: Env, logger: Logger, params: Record<string, string | undefined>): Promise<Response> {
  if (await isRateLimited(request, env, RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again in a minute.');
  }

  const result = await getUnsubscribeStatus(env, params.token);
  if (!result.ok) {
    return jsonError(REASON_TO_CODE[result.reason], REASON_TO_MESSAGE[result.reason]);
  }
  return jsonSuccess({ email: result.email, alreadyUnsubscribed: result.alreadyUnsubscribed });
}

export async function handleUnsubscribeConfirm(request: Request, env: Env, logger: Logger, params: Record<string, string | undefined>): Promise<Response> {
  if (await isRateLimited(request, env, RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again in a minute.');
  }

  const result = await confirmUnsubscribe(env, logger, params.token);
  if (!result.ok) {
    return jsonError(REASON_TO_CODE[result.reason], REASON_TO_MESSAGE[result.reason]);
  }
  return jsonSuccess({ email: result.email, alreadyUnsubscribed: result.alreadyUnsubscribed });
}
