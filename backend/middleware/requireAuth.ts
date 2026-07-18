/**
 * Admin session authentication — Version 2.0 Phase 0.1 (Authentication
 * Foundation). Implements this folder's own long-planned `auth.ts`
 * entry (see middleware/README.md), split into `requireAuth.ts` +
 * `requireRole.ts` to match the approved docs/v2-architecture.md folder
 * structure. Applies to every `/api/admin/*` route except login itself.
 *
 * Verifies the session cookie against `admin_sessions` (via
 * `services/admin/sessionService.ts`'s `validateSession()` — the one
 * place that decision is actually made) and attaches the acting admin
 * to the request. Called explicitly at the top of a route handler
 * (mirroring how `isRateLimited()` is already called explicitly in
 * every rate-limited route, rather than a framework-style middleware
 * chain this project's dependency-free router doesn't have).
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { parseCookies } from '../utils/cookies';
import { validateSession } from '../services/admin/sessionService';
import { record as recordAudit } from '../services/admin/auditService';
import { jsonError } from '../utils/responses';

/** HttpOnly — never readable by JS, per docs/v2-authentication-design.md's "Sessions". */
export const SESSION_COOKIE_NAME = 'admin_session';
/** Readable by JS — the frontend reads this to attach the X-CSRF-Token header, per the "CSRF" section. */
export const CSRF_COOKIE_NAME = 'admin_csrf';

export interface AdminAuthContext {
  sessionId: number;
  adminId: number;
  role: string;
  email: string;
  name: string | null;
  csrfSecret: string;
  mustChangePassword: boolean;
}

export type RequireAuthResult = { ok: true; auth: AdminAuthContext } | { ok: false; response: Response };

/**
 * The only `/api/admin/*` paths reachable while `must_change_password`
 * is set — Version 2.1 Phase 3 (Identity & Security). Session-check so
 * the frontend can learn the flag is set at all; change-password so
 * the admin can actually clear it; logout so a flagged admin isn't
 * trapped. Every other route is rejected here, centrally, rather than
 * requiring every existing and future route handler to remember to
 * check this flag itself — the one piece of this phase that genuinely
 * touches `requireAuth()`'s own logic, per the architecture plan.
 */
const MUST_CHANGE_PASSWORD_ALLOWED_PATHS = new Set(['/api/admin/auth/session', '/api/admin/auth/change-password', '/api/admin/auth/logout']);

/**
 * On failure (missing cookie, unknown token, revoked, expired, or the
 * owning admin deactivated/deleted since the session was issued — all
 * of that is `validateSession`'s single WHERE clause, see
 * sessionService.ts), records an audit event and returns the exact
 * response the route should return immediately, unmodified.
 */
export async function requireAuth(request: Request, env: Env, logger: Logger): Promise<RequireAuthResult> {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[SESSION_COOKIE_NAME];

  const check = await validateSession(env, token);
  if (!check.ok) {
    await recordAudit(env, logger, {
      actorType: 'system',
      actorId: null,
      action: 'admin.unauthorized_access',
      metadata: { path: new URL(request.url).pathname },
    });
    return { ok: false, response: jsonError('NOT_AUTHENTICATED', 'Please log in to continue.') };
  }

  if (check.mustChangePassword && !MUST_CHANGE_PASSWORD_ALLOWED_PATHS.has(new URL(request.url).pathname)) {
    return { ok: false, response: jsonError('MUST_CHANGE_PASSWORD', 'You must change your password before continuing.') };
  }

  return {
    ok: true,
    auth: {
      sessionId: check.sessionId,
      adminId: check.adminId,
      role: check.role,
      email: check.email,
      name: check.name,
      csrfSecret: check.csrfSecret,
      mustChangePassword: check.mustChangePassword,
    },
  };
}
