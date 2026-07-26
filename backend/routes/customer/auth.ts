/**
 * POST /api/customer/auth/set-password, POST /api/customer/auth/login,
 * POST /api/customer/auth/logout, GET /api/customer/auth/session,
 * POST /api/customer/auth/forgot-password — Version 3.0.2 Milestone M1
 * (Customer Identity & Guest Checkout). See
 * docs/v3.0.2-commerce-architecture-blueprint.md's Security Architecture
 * and docs/v3.0.2-architecture-decision-register.md's ADR-006.
 *
 * Thin HTTP layer only, per this project's established routes/
 * convention (see backend/routes/README.md): parses the request, calls
 * services/customer/authService.ts for all real logic, sets/clears
 * cookies, formats the response via the standard envelope. Never
 * touches D1 directly. Direct structural mirror of
 * routes/admin/auth.ts.
 *
 * `set-password` deliberately serves BOTH the initial post-purchase
 * setup flow (token from the welcome email) and any later self-service
 * password reset (token from forgot-password) — the underlying
 * mechanism (redeem a single-use customer_password_tokens row) is
 * identical either way; only the email that delivered the link
 * differs. See services/customer/authService.ts's setPassword().
 *
 * No public registration endpoint exists here or anywhere in this
 * scope — per ADR-006, a `customers` row is only ever created by the
 * purchase-triggered find-or-create in
 * services/customer/identityService.ts, reached either from
 * services/commerceService.ts's webhook handler (a fresh, contemporaneous
 * purchase) or, as of Version 3.3 Milestone M5C, from
 * routes/customer/reconciliation.ts (a historical, already-verified
 * purchase with no customer row yet) — never from a free-form email
 * with no purchase behind it.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { parseCookies, serializeCookie } from '../../utils/cookies';
import { requireCustomerAuth, CUSTOMER_SESSION_COOKIE_NAME, CUSTOMER_CSRF_COOKIE_NAME } from '../../middleware/requireCustomerAuth';
import { requireCustomerCsrf } from '../../middleware/customerCsrf';
import * as authService from '../../services/customer/authService';
import * as sessionService from '../../services/customer/sessionService';
import type { PasswordValidationError } from '../../utils/passwordPolicy';

// Same 5/15min/IP calibration as admin login (routes/admin/auth.ts) —
// the credential-stuffing-relevant endpoint.
const LOGIN_RATE_LIMIT = { endpoint: 'customer-login', limit: 5, windowSeconds: 15 * 60 };
// Same reasoning as admin's forgot-password limit: an unauthenticated
// endpoint that sends real email to a real inbox is itself a spam/
// harassment vector even without any credential risk.
const FORGOT_PASSWORD_RATE_LIMIT = { endpoint: 'customer-forgot-password', limit: 3, windowSeconds: 15 * 60 };
const SET_PASSWORD_RATE_LIMIT = { endpoint: 'customer-set-password', limit: 10, windowSeconds: 15 * 60 };
// Version 3.1 Milestone M3 — same calibration as SET_PASSWORD_RATE_LIMIT, this is the equally-sensitive already-logged-in equivalent.
const CHANGE_PASSWORD_RATE_LIMIT = { endpoint: 'customer-change-password', limit: 10, windowSeconds: 15 * 60 };

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

/** Matches the session cookie's own lifetime (12h) — see sessionService.ts's SESSION_TTL_HOURS. */
const SESSION_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

function withCookies(response: Response, cookies: string[]): Response {
  const headers = new Headers(response.headers);
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(response.body, { status: response.status, headers });
}

/** Same reasoning as admin routes/admin/auth.ts's withNoStore() — these responses carry session-adjacent secrets or customer PII, never cacheable. */
function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(response.body, { status: response.status, headers });
}

export async function handleCustomerLogin(request: Request, env: Env, logger: Logger): Promise<Response> {
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
    if (result.reason === 'password_not_set') {
      // Version 3.3 Milestone M5C — a distinct code so the frontend
      // can render a direct activation link (see js/components/sign-in-form.js)
      // rather than a generic error. See types/api-contracts.ts's
      // PASSWORD_NOT_SET entry for why this adds no new enumeration
      // signal.
      return withNoStore(
        jsonError('PASSWORD_NOT_SET', "This account hasn't set a password yet. Check your email for a setup link, or request a new one below.")
      );
    }
    return withNoStore(jsonError('INVALID_CREDENTIALS', 'Invalid email or password.'));
  }

  const response = jsonSuccess({ customerId: result.customerId, email: result.email, expiresAt: result.expiresAt });

  return withNoStore(
    withCookies(response, [
      // SameSite=Lax — same reasoning as admin_session (same-origin
      // frontend/API, real CSRF defense is the double-submit header).
      serializeCookie(CUSTOMER_SESSION_COOKIE_NAME, result.sessionToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: SESSION_COOKIE_MAX_AGE_SECONDS,
      }),
      serializeCookie(CUSTOMER_CSRF_COOKIE_NAME, result.csrfSecret, {
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: SESSION_COOKIE_MAX_AGE_SECONDS,
      }),
    ])
  );
}

export async function handleCustomerLogout(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  const csrfFailure = await requireCustomerCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return withNoStore(csrfFailure);

  const cookies = parseCookies(request.headers.get('Cookie'));
  await authService.logout(env, logger, cookies[CUSTOMER_SESSION_COOKIE_NAME]);

  const response = jsonSuccess({ loggedOut: true });

  return withNoStore(
    withCookies(response, [
      serializeCookie(CUSTOMER_SESSION_COOKIE_NAME, '', { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAgeSeconds: 0 }),
      serializeCookie(CUSTOMER_CSRF_COOKIE_NAME, '', { httpOnly: false, secure: true, sameSite: 'Lax', path: '/', maxAgeSeconds: 0 }),
    ])
  );
}

export async function handleCustomerSession(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  // Version 3.3 Milestone M5C — see sessionService.ts's countSessionsForCustomer()
  // for why a count of 1 means this is the customer's first-ever login.
  const sessionCount = await sessionService.countSessionsForCustomer(env, auth.auth.customerId);

  return withNoStore(jsonSuccess({ customerId: auth.auth.customerId, email: auth.auth.email, isFirstSession: sessionCount <= 1 }));
}

export async function handleCustomerForgotPassword(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, FORGOT_PASSWORD_RATE_LIMIT)) {
    // Still the identical generic response — see the no-enumeration
    // discipline in authService.ts's forgotPassword().
    return withNoStore(jsonSuccess({ requested: true }));
  }

  const body = await readJsonBody(request);
  if (body) {
    await authService.forgotPassword(env, logger, body.email, env.SITE_BASE_URL);
  }

  return withNoStore(jsonSuccess({ requested: true }));
}

export async function handleCustomerSetPassword(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, SET_PASSWORD_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many attempts. Please try again shortly.'));
  }

  const body = await readJsonBody(request);
  if (!body) return withNoStore(jsonError('VALIDATION_ERROR', 'Invalid request body.'));

  const result = await authService.setPassword(env, logger, body.token, body.newPassword);

  if (!result.ok) {
    if (result.reason === 'invalid_or_expired_token') {
      return withNoStore(jsonError('INVALID_TOKEN', 'This link is invalid or has expired. Please request a new one.'));
    }
    return withNoStore(validationErrorResponse(result.errors));
  }

  return withNoStore(jsonSuccess({ passwordSet: true }));
}

/**
 * Version 3.1 Milestone M3 (Checkout Auto-Provisioning & Dashboard
 * MVP) — the Account Security page's "change password" action for an
 * already-logged-in customer. Distinct from set-password above (which
 * redeems an emailed token, no session required); this route requires
 * an active session AND the customer's current password, then revokes
 * every other session while keeping this one alive. See
 * services/customer/authService.ts's changePassword() for the full
 * reasoning.
 */
export async function handleCustomerChangePassword(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);
  const csrfFailure = await requireCustomerCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return withNoStore(csrfFailure);

  if (await isRateLimited(request, env, CHANGE_PASSWORD_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many attempts. Please try again shortly.'));
  }

  const body = await readJsonBody(request);
  if (!body) return withNoStore(jsonError('VALIDATION_ERROR', 'Invalid request body.'));

  const result = await authService.changePassword(env, logger, auth.auth.customerId, auth.auth.sessionId, body.currentPassword, body.newPassword);

  if (!result.ok) {
    if (result.reason === 'invalid_current_password') {
      return withNoStore(jsonError('INVALID_CREDENTIALS', 'Your current password is incorrect.'));
    }
    return withNoStore(validationErrorResponse(result.errors));
  }

  return withNoStore(jsonSuccess({ passwordChanged: true }));
}
