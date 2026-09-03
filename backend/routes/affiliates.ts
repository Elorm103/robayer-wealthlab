/**
 * POST /api/affiliates/click: the one PUBLIC, unauthenticated
 * affiliate endpoint. Called by js/main.js whenever a page loads with
 * a `?ref=` query parameter present (see that file's own comment).
 * Records a durable click (affiliateAttributionService.ts's
 * recordClick()) and, if the code is real and currently eligible,
 * sets the `rwl_ref` attribution cookie so a later checkout can
 * resolve it, see services/affiliateAttributionService.ts's own
 * header comment for the full last-click, 30-day model.
 *
 * Deliberately thin and low-risk: an invalid or ineligible code is a
 * normal, silent no-op response (never an error a visitor would see),
 * and the cookie is only ever set for a code that genuinely resolves
 * to a currently-'approved' affiliate, never blindly echoed back.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonError, jsonSuccess } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';
import { serializeCookie } from '../utils/cookies';
import { recordClick, AFFILIATE_REF_COOKIE_NAME, AFFILIATE_ATTRIBUTION_WINDOW_SECONDS } from '../services/affiliateAttributionService';

// A visitor can browse many pages in one session, each carrying the
// same ?ref= link if they navigate via a bookmark/shared link more
// than once; generous enough for real browsing, tight enough to make
// a scripted click-spam attempt expensive. Matches this project's
// existing per-IP fixed-window convention (middleware/rateLimit.ts).
const CLICK_RATE_LIMIT = { endpoint: 'affiliate-click', limit: 30, windowSeconds: 60 };

function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookie);
  return new Response(response.body, { status: response.status, headers });
}

export async function handleAffiliateClick(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, CLICK_RATE_LIMIT)) {
    // A rate-limited click is still a completely normal, silent outcome
    // from the visitor's own perspective (this endpoint never blocks
    // page navigation): 429 here, but js/main.js treats any non-2xx
    // as a harmless no-op.
    return jsonError('RATE_LIMITED', 'Too many requests.');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.');
  }

  const { code, productSlug, landingPath } = (body as { code?: unknown; productSlug?: unknown; landingPath?: unknown }) ?? {};
  if (typeof landingPath !== 'string' || landingPath.length === 0 || landingPath.length > 512) {
    return jsonError('VALIDATION_ERROR', 'A valid landingPath is required.');
  }

  const result = await recordClick(env, logger, {
    codeInput: code,
    productSlug: typeof productSlug === 'string' && productSlug.length > 0 ? productSlug : null,
    landingPath,
    referrer: request.headers.get('Referer'),
    ip: request.headers.get('CF-Connecting-IP'),
  });

  if (!result.recorded) {
    // Not an error the caller needs to act on: just no attribution cookie set.
    return jsonSuccess({ attributed: false });
  }

  const response = jsonSuccess({ attributed: true });
  return withCookie(
    response,
    // HttpOnly: this cookie is never read by client JS (only by the
    // server at checkout time), and being HttpOnly means client-side
    // JS also can't be used to forge/overwrite it, one more reason
    // "never trust a browser-supplied affiliate ID" holds even before
    // the server re-validates the code again at checkout.
    serializeCookie(AFFILIATE_REF_COOKIE_NAME, result.cookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAgeSeconds: AFFILIATE_ATTRIBUTION_WINDOW_SECONDS,
    })
  );
}
