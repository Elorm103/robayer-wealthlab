/**
 * POST /api/admin/auth/login, POST /api/admin/auth/logout,
 * GET /api/admin/auth/session — Version 2.0 Phase 0.1 (Authentication
 * Foundation). See docs/v2-authentication-design.md's "Login flow" and
 * docs/v2-api-expansion.md's Authentication route table. Location
 * matches the approved docs/v2-architecture.md folder structure
 * (`routes/admin/auth.ts`).
 *
 * Thin HTTP layer only, per this project's established routes/
 * convention: parses the request, calls `services/admin/authService.ts`
 * for all real logic, sets/clears cookies, formats the response via the
 * standard envelope. Never touches D1 directly.
 *
 * Rate limiting: `admin-login` is limited exactly as
 * docs/v2-authentication-design.md specifies (5/15min/IP — the
 * credential-stuffing-relevant endpoint). Logout and the session check
 * are deliberately NOT additionally rate-limited here: both require an
 * already-valid session (via `requireAuth`), and the design doc's
 * broader "120/min/session" ceiling for other `/api/admin/*` routes
 * depends on a per-session rate-limit mechanism `middleware/rateLimit.ts`
 * doesn't have today (it keys strictly on `CF-Connecting-IP`, per that
 * file's own header comment) — building a new keying mechanism for two
 * low-frequency, read-cheap endpoints would be new infrastructure this
 * phase's "reuse the existing... rate limiting" scope doesn't call for.
 * A real per-session limiter is a reasonable follow-up once a route
 * that actually needs it (e.g. a data-table-heavy dashboard module) is
 * built.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { parseCookies, serializeCookie } from '../../utils/cookies';
import { requireAuth, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from '../../middleware/requireAuth';
import { requireCsrf } from '../../middleware/csrf';
import * as authService from '../../services/admin/authService';

const LOGIN_RATE_LIMIT = { endpoint: 'admin-login', limit: 5, windowSeconds: 15 * 60 };

/** Matches the session cookie's own lifetime (12h) — see sessionService.ts's SESSION_TTL_HOURS. Kept as a literal here (not imported) since the cookie's Max-Age is a client-facing concern, distinct from the server's own `admin_sessions.expires_at` enforcement, which is the actual security boundary regardless of what the cookie claims. */
const SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

function withCookies(response: Response, cookies: string[]): Response {
  const headers = new Headers(response.headers);
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Every response from these three routes carries either session-adjacent
 * secrets (login's Set-Cookie headers) or admin PII (email/role/name, on
 * login and session-check) — none of it should ever be written to a
 * shared/proxy cache or a browser's disk cache. Found during the Phase
 * 0.1 security audit: `GET /api/admin/auth/session` is otherwise a
 * plain cacheable GET with no explicit Cache-Control, meaning a shared
 * corporate proxy or the browser's own HTTP cache could legitimately
 * store and later replay the admin's email/role/name — e.g. on a shared
 * or public computer, after logout, via the browser's cache/history.
 * `Cache-Control: no-store` is the correct directive (not just
 * `private` or `no-cache`, which still permit storage under some
 * conditions) — applied uniformly to success AND error responses here
 * so no caching layer ever treats this endpoint as cacheable at all.
 */
function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(response.body, { status: response.status, headers });
}

export async function handleAdminLogin(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, LOGIN_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many login attempts. Please try again in a few minutes.'));
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withNoStore(jsonError('INVALID_CREDENTIALS', 'Invalid email or password.'));
  }

  const { email, password } = (body as { email?: unknown; password?: unknown }) ?? {};

  const result = await authService.login(env, logger, email, password, {
    ip: request.headers.get('CF-Connecting-IP'),
    userAgent: request.headers.get('User-Agent'),
  });

  if (!result.ok) {
    return withNoStore(jsonError('INVALID_CREDENTIALS', 'Invalid email or password.'));
  }

  const response = jsonSuccess({
    adminId: result.adminId,
    email: result.email,
    role: result.role,
    name: result.name,
    expiresAt: result.expiresAt,
  });

  return withNoStore(
    withCookies(response, [
      serializeCookie(SESSION_COOKIE_NAME, result.sessionToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
        path: '/',
        maxAgeSeconds: SESSION_COOKIE_MAX_AGE_SECONDS,
      }),
      // Deliberately NOT HttpOnly — the frontend must read this value to
      // attach it as the X-CSRF-Token header. See middleware/csrf.ts.
      serializeCookie(CSRF_COOKIE_NAME, result.csrfSecret, {
        httpOnly: false,
        secure: true,
        sameSite: 'Strict',
        path: '/',
        maxAgeSeconds: SESSION_COOKIE_MAX_AGE_SECONDS,
      }),
    ])
  );
}

export async function handleAdminLogout(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return withNoStore(csrfFailure);

  const cookies = parseCookies(request.headers.get('Cookie'));
  await authService.logout(env, logger, cookies[SESSION_COOKIE_NAME]);

  const response = jsonSuccess({ loggedOut: true });

  return withNoStore(
    withCookies(response, [
      serializeCookie(SESSION_COOKIE_NAME, '', { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAgeSeconds: 0 }),
      serializeCookie(CSRF_COOKIE_NAME, '', { httpOnly: false, secure: true, sameSite: 'Strict', path: '/', maxAgeSeconds: 0 }),
    ])
  );
}

export async function handleAdminSession(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  return withNoStore(
    jsonSuccess({
      adminId: auth.auth.adminId,
      email: auth.auth.email,
      role: auth.auth.role,
      name: auth.auth.name,
    })
  );
}
