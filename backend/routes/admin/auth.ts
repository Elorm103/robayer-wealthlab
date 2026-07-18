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
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { parseCookies, serializeCookie } from '../../utils/cookies';
import { requireAuth, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from '../../middleware/requireAuth';
import { requireCsrf } from '../../middleware/csrf';
import * as authService from '../../services/admin/authService';
import * as sessionService from '../../services/admin/sessionService';
import * as loginHistoryService from '../../services/admin/loginHistoryService';
import type { PasswordValidationError } from '../../utils/passwordPolicy';

const LOGIN_RATE_LIMIT = { endpoint: 'admin-login', limit: 5, windowSeconds: 15 * 60 };
// Forgot-password is an unauthenticated endpoint that sends real email
// to a real inbox — an unlimited version of it is itself a spam/
// harassment vector against a real admin even without any credential
// risk (see docs/v2.1-architecture-plan.md's Phase 4 "Rate-limit
// review"). Reset-password is limited to blunt online guessing against
// a specific token (the token itself is 256-bit and already
// unguessable, but limiting the endpoint costs nothing).
const FORGOT_PASSWORD_RATE_LIMIT = { endpoint: 'admin-forgot-password', limit: 3, windowSeconds: 15 * 60 };
const RESET_PASSWORD_RATE_LIMIT = { endpoint: 'admin-reset-password', limit: 10, windowSeconds: 15 * 60 };
const CHANGE_PASSWORD_RATE_LIMIT = { endpoint: 'admin-change-password', limit: 10, windowSeconds: 15 * 60 };

function validationErrorResponse(errors: PasswordValidationError[]): Response {
  const body = {
    success: false,
    error: { code: 'VALIDATION_ERROR', message: errors[0]?.message ?? 'Validation failed.' },
    fields: errors,
  };
  return new Response(JSON.stringify(body), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

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
    mustChangePassword: result.mustChangePassword,
    expiresAt: result.expiresAt,
  });

  return withNoStore(
    withCookies(response, [
      // SameSite=Lax — the admin frontend and this Worker are same-origin
      // (robayerwealthlab.com/api/*, via the Cloudflare Workers Route in
      // wrangler.jsonc), so there is no cross-site fetch() this cookie
      // needs to survive. Lax (not Strict) avoids the "looks logged out
      // after clicking an external link" wrinkle Strict causes on
      // top-level cross-site navigation, while still blocking the
      // cross-site POSTs Strict/Lax both exist to stop. The real CSRF
      // defense remains the double-submit X-CSRF-Token header
      // (middleware/csrf.ts), unchanged by this.
      serializeCookie(SESSION_COOKIE_NAME, result.sessionToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: SESSION_COOKIE_MAX_AGE_SECONDS,
      }),
      // Deliberately NOT HttpOnly — the frontend reads this value
      // straight from document.cookie to attach it as the X-CSRF-Token
      // header (the standard double-submit-cookie pattern — see
      // middleware/csrf.ts). Readable natively now that frontend and API
      // share an origin; no separate transport is needed.
      serializeCookie(CSRF_COOKIE_NAME, result.csrfSecret, {
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
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
      serializeCookie(SESSION_COOKIE_NAME, '', { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAgeSeconds: 0 }),
      serializeCookie(CSRF_COOKIE_NAME, '', { httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAgeSeconds: 0 }),
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
      mustChangePassword: auth.auth.mustChangePassword,
    })
  );
}

// ============================================================
// Change password — Version 2.1 Phase 3 (Identity & Security)
// ============================================================

export async function handleChangePassword(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return withNoStore(csrfFailure);

  if (await isRateLimited(request, env, CHANGE_PASSWORD_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many attempts. Please try again shortly.'));
  }

  const body = await readJsonBody(request);
  if (!body) return withNoStore(jsonError('VALIDATION_ERROR', 'Invalid request body.'));

  const result = await authService.changePassword(env, logger, auth.auth.adminId, auth.auth.sessionId, body.currentPassword, body.newPassword);

  if (!result.ok) {
    if (result.reason === 'incorrect_current_password') {
      return withNoStore(jsonError('INCORRECT_PASSWORD', 'Your current password is incorrect.'));
    }
    return withNoStore(validationErrorResponse(result.errors));
  }

  return withNoStore(jsonSuccess({ changed: true }));
}

// ============================================================
// Forgot / reset password — Version 2.1 Phase 3 (Identity & Security).
// Unauthenticated by design (the whole point is recovering access
// without an active session).
// ============================================================

export async function handleForgotPassword(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, FORGOT_PASSWORD_RATE_LIMIT)) {
    // Still the identical generic response — a rate-limit response
    // distinguishable from the normal success response would itself
    // leak information about request volume against a specific email.
    return withNoStore(jsonSuccess({ requested: true }));
  }

  const body = await readJsonBody(request);
  if (body) {
    await authService.forgotPassword(env, logger, body.email, env.SITE_BASE_URL);
  }

  // Always the same response, whether or not the account exists — the
  // same no-user-enumeration discipline login() already established.
  return withNoStore(jsonSuccess({ requested: true }));
}

export async function handleResetPassword(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, RESET_PASSWORD_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many attempts. Please try again shortly.'));
  }

  const body = await readJsonBody(request);
  if (!body) return withNoStore(jsonError('VALIDATION_ERROR', 'Invalid request body.'));

  const result = await authService.resetPassword(env, logger, body.token, body.newPassword);

  if (!result.ok) {
    if (result.reason === 'invalid_or_expired_token') {
      return withNoStore(jsonError('INVALID_TOKEN', 'This reset link is invalid or has expired. Please request a new one.'));
    }
    return withNoStore(validationErrorResponse(result.errors));
  }

  return withNoStore(jsonSuccess({ reset: true }));
}

// ============================================================
// Sessions — Version 2.1 Phase 3 (Identity & Security). Own sessions
// only, never another admin's — see sessionService.ts's own comment.
// ============================================================

export async function handleListSessions(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  const sessions = await sessionService.listSessions(env, auth.auth.adminId, auth.auth.sessionId);
  return withNoStore(jsonSuccess({ sessions }));
}

export async function handleRevokeSession(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return withNoStore(csrfFailure);

  const sessionId = parseInt(params.id ?? '', 10);
  if (!Number.isInteger(sessionId)) return withNoStore(jsonError('NOT_FOUND', 'This session could not be found.'));

  const result = await sessionService.revokeSessionById(env, auth.auth.adminId, sessionId);
  if (!result.ok) return withNoStore(jsonError('NOT_FOUND', 'This session could not be found.'));

  return withNoStore(jsonSuccess({ revoked: true }));
}

// ============================================================
// Login history — Version 2.1 Phase 3 (Identity & Security). Own
// history only, same reasoning as sessions.
// ============================================================

export async function handleLoginHistory(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  const history = await loginHistoryService.listLoginHistory(env, auth.auth.adminId);
  return withNoStore(jsonSuccess({ history }));
}
