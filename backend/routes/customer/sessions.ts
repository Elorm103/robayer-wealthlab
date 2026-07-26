/**
 * GET /api/customer/sessions, POST /api/customer/sessions/:sessionId/revoke
 * - Version 3.1 Milestone M3 (Checkout Auto-Provisioning & Dashboard
 * MVP). See docs/v3.1-m3-api-gap-analysis.md's Gap 3.
 *
 * Own sessions only, never another customer's - direct structural
 * mirror of routes/admin/auth.ts's handleListSessions/handleRevokeSession,
 * itself mirroring services/admin/sessionService.ts's own
 * already-proven IDOR-checked pattern (see
 * services/customer/sessionService.ts's revokeSessionById() for the
 * full reasoning this reuses, not reinvents).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireCustomerAuth } from '../../middleware/requireCustomerAuth';
import { requireCustomerCsrf } from '../../middleware/customerCsrf';
import * as sessionService from '../../services/customer/sessionService';

/** Same reasoning as routes/customer/auth.ts's own withNoStore() - session metadata is never cacheable. */
function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(response.body, { status: response.status, headers });
}

const READ_RATE_LIMIT = { endpoint: 'customer-sessions-read', limit: 60, windowSeconds: 15 * 60 };
const WRITE_RATE_LIMIT = { endpoint: 'customer-sessions-write', limit: 20, windowSeconds: 15 * 60 };

export async function handleListCustomerSessions(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const sessions = await sessionService.listActiveSessions(env, auth.auth.customerId, auth.auth.sessionId);
  return withNoStore(jsonSuccess({ sessions }));
}

export async function handleRevokeCustomerSession(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);
  const csrfFailure = await requireCustomerCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return withNoStore(csrfFailure);

  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const sessionId = parseInt(params.sessionId ?? '', 10);
  if (!Number.isInteger(sessionId)) return withNoStore(jsonError('NOT_FOUND', 'This session could not be found.'));

  // docs/v3.1-m3-security-review.md's Session handling section requires
  // this route never revoke the caller's OWN current session (that is
  // what POST /api/customer/auth/logout is for) — found missing during
  // the M3C Acceptance Review (confirmed live: calling this on one's own
  // current session succeeded and immediately invalidated the very
  // cookie making the request) and fixed here, since the dashboard UI
  // never offers a revoke control for the session it marks `isCurrent`,
  // this is the one server-side guard that was still missing.
  if (sessionId === auth.auth.sessionId) {
    return withNoStore(jsonError('CANNOT_REVOKE_CURRENT_SESSION', 'You cannot sign out your current session this way. Use log out instead.'));
  }

  const result = await sessionService.revokeSessionById(env, auth.auth.customerId, sessionId);
  if (!result.ok) return withNoStore(jsonError('NOT_FOUND', 'This session could not be found.'));

  return withNoStore(jsonSuccess({ revoked: true }));
}
