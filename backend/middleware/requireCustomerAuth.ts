/**
 * Customer session authentication — Version 3.0.2 Milestone M1. Direct
 * mirror of `middleware/requireAuth.ts` (see that file's own header
 * comment) — verifies the customer session cookie against
 * `customer_sessions` (via `services/customer/sessionService.ts`'s
 * `validateSession()`) and attaches the acting customer to the request.
 *
 * Applies to `GET /api/customer/auth/session` and `POST
 * /api/customer/auth/logout` in Milestone M1 — the only two customer-
 * auth routes that require an existing session. Every other customer-
 * auth route (setup-password, login, forgot-password, reset-password)
 * is deliberately unauthenticated by design, exactly matching admin
 * auth's own equivalent routes.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { parseCookies } from '../utils/cookies';
import { validateSession } from '../services/customer/sessionService';
import { jsonError } from '../utils/responses';

/** HttpOnly — never readable by JS. Distinct cookie name from admin's `admin_session`, so a browser holding both an admin and a customer session (unlikely but not impossible, e.g. staff testing) never confuses the two. */
export const CUSTOMER_SESSION_COOKIE_NAME = 'customer_session';
/** Readable by JS — the frontend reads this to attach the X-Customer-CSRF-Token header. */
export const CUSTOMER_CSRF_COOKIE_NAME = 'customer_csrf';

export interface CustomerAuthContext {
  sessionId: number;
  customerId: number;
  email: string;
  csrfSecret: string;
}

export type RequireCustomerAuthResult = { ok: true; auth: CustomerAuthContext } | { ok: false; response: Response };

export async function requireCustomerAuth(request: Request, env: Env, _logger: Logger): Promise<RequireCustomerAuthResult> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[CUSTOMER_SESSION_COOKIE_NAME];

  const check = await validateSession(env, token);
  if (!check.ok) {
    return { ok: false, response: jsonError('NOT_AUTHENTICATED', 'Please log in to continue.') };
  }

  return {
    ok: true,
    auth: { sessionId: check.sessionId, customerId: check.customerId, email: check.email, csrfSecret: check.csrfSecret },
  };
}
