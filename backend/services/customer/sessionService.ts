/**
 * Customer Session Service — Version 3.0.2 Milestone M1. Direct mirror
 * of `services/admin/sessionService.ts` (see that file's own header
 * comment) — the only code that writes to `customer_sessions`. Same
 * atomic-token pattern: session validity is a single SELECT with every
 * condition in its own WHERE clause, and revocation is a single atomic
 * UPDATE gated on `revoked_at IS NULL`.
 */

import type { Env } from '../../worker/env';
import { generateCustomerSessionToken, generateCustomerCsrfSecret } from '../../utils/customerToken';

/** Matches admin_sessions' own absolute lifetime — see sessionService.ts's SESSION_TTL_HOURS for the full reasoning (fixed at creation, last_seen_at is observability only). */
const SESSION_TTL_HOURS = 12;

const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export interface CreateSessionContext {
  ip: string | null;
  userAgent: string | null;
}

export interface CreatedSession {
  sessionToken: string;
  csrfSecret: string;
  expiresAt: string;
}

/** Creates a new `customer_sessions` row for an already-authenticated customer (credential verification happens in `authService.ts`, before this is ever called). */
export async function createSession(env: Env, customerId: number, context: CreateSessionContext): Promise<CreatedSession> {
  const sessionToken = generateCustomerSessionToken();
  const csrfSecret = generateCustomerCsrfSecret();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60_000).toISOString();

  await env.DB.prepare(
    `INSERT INTO customer_sessions (token, customer_id, csrf_secret, ip_created, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(sessionToken, customerId, csrfSecret, context.ip, context.userAgent, expiresAt)
    .run();

  return { sessionToken, csrfSecret, expiresAt };
}

export type SessionCheckResult =
  | { ok: true; sessionId: number; customerId: number; email: string; csrfSecret: string }
  | { ok: false };

/**
 * The one place `requireCustomerAuth` asks "is this session currently
 * valid" — every condition (exists, not revoked, not expired, owning
 * customer still active and not soft-deleted) is in one SELECT's WHERE
 * clause, mirroring admin `validateSession()` exactly.
 */
export async function validateSession(env: Env, tokenInput: unknown): Promise<SessionCheckResult> {
  if (typeof tokenInput !== 'string' || !SESSION_TOKEN_PATTERN.test(tokenInput)) {
    return { ok: false };
  }

  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT s.id AS sessionId, s.customer_id AS customerId, s.csrf_secret AS csrfSecret, c.email AS email
     FROM customer_sessions s
     JOIN customers c ON c.id = s.customer_id
     WHERE s.token = ? AND s.revoked_at IS NULL AND s.expires_at > ?
       AND c.status = 'active' AND c.deleted_at IS NULL`
  )
    .bind(tokenInput, now)
    .first<{ sessionId: number; customerId: number; csrfSecret: string; email: string }>();

  if (!row) return { ok: false };

  await env.DB.prepare(`UPDATE customer_sessions SET last_seen_at = ? WHERE id = ?`).bind(now, row.sessionId).run();

  return { ok: true, sessionId: row.sessionId, customerId: row.customerId, email: row.email, csrfSecret: row.csrfSecret };
}

export type RevokeSessionResult = { revoked: true; customerId: number } | { revoked: false };

/** Revokes a session atomically. Idempotent: a second call for an already-revoked token returns `{ revoked: false }`, not an error. */
export async function revokeSession(env: Env, tokenInput: unknown): Promise<RevokeSessionResult> {
  if (typeof tokenInput !== 'string' || !SESSION_TOKEN_PATTERN.test(tokenInput)) {
    return { revoked: false };
  }

  const result = await env.DB.prepare(`UPDATE customer_sessions SET revoked_at = datetime('now') WHERE token = ? AND revoked_at IS NULL`)
    .bind(tokenInput)
    .run();

  if (result.meta.changes !== 1) return { revoked: false };

  const row = await env.DB.prepare(`SELECT customer_id AS customerId FROM customer_sessions WHERE token = ?`)
    .bind(tokenInput)
    .first<{ customerId: number }>();

  return row ? { revoked: true, customerId: row.customerId } : { revoked: false };
}

/** Revokes every active session for a customer — used after a password reset (no "current" session exists yet during that flow — see authService.ts's setPassword()). */
export async function revokeAllSessions(env: Env, customerId: number): Promise<void> {
  await env.DB.prepare(`UPDATE customer_sessions SET revoked_at = datetime('now') WHERE customer_id = ? AND revoked_at IS NULL`)
    .bind(customerId)
    .run();
}

// ============================================================
// Account Security (Version 3.1 Milestone M3) — a customer viewing
// and selectively revoking their own sessions. See
// docs/v3.1-m3-api-gap-analysis.md's Gap 3.
// ============================================================

export interface CustomerSessionSummary {
  id: number;
  ipCreated: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

/** Revokes every OTHER active session for a customer, preserving `exceptSessionId` — used after a change-password (unlike revokeAllSessions(), which a password *reset* uses since no session is logged in yet during that flow). Direct mirror of services/admin/sessionService.ts's own revokeAllSessionsExcept(). */
export async function revokeAllSessionsExcept(env: Env, customerId: number, exceptSessionId: number): Promise<void> {
  await env.DB.prepare(`UPDATE customer_sessions SET revoked_at = datetime('now') WHERE customer_id = ? AND id != ? AND revoked_at IS NULL`)
    .bind(customerId, exceptSessionId)
    .run();
}

/** Lists the calling customer's own non-revoked, non-expired sessions — never another customer's. Direct mirror of services/admin/sessionService.ts's own listSessions(). */
export async function listActiveSessions(env: Env, customerId: number, currentSessionId: number): Promise<CustomerSessionSummary[]> {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, ip_created AS ipCreated, user_agent AS userAgent, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt
     FROM customer_sessions
     WHERE customer_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY last_seen_at DESC`
  )
    .bind(customerId, now)
    .all<{ id: number; ipCreated: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string; expiresAt: string }>();

  return results.map((row) => ({ ...row, isCurrent: row.id === currentSessionId }));
}

export type RevokeByIdResult = { ok: true } | { ok: false; reason: 'not_found' };

/**
 * Revokes one of the calling customer's own sessions by id — verifies
 * the target session's `customer_id` matches the caller's own id
 * BEFORE revoking, the same IDOR check
 * `services/admin/sessionService.ts`'s own `revokeSessionById()`
 * already established (the one genuinely new authorization shape M3
 * introduces per docs/v3.1-m3-security-review.md - every other M1/M2
 * customer endpoint filters by customerId alone, never a second
 * resource's own id needing its own ownership check). This function
 * itself has no special-case guard against revoking the *current*
 * session (unlike the admin equivalent, that guard now lives one layer
 * up in routes/customer/sessions.ts's handleRevokeCustomerSession(),
 * added during the M3C Acceptance Review — the Security Review's
 * Session handling section explicitly required it and the initial
 * UI-only enforcement was confirmed insufficient by a direct API call).
 */
export async function revokeSessionById(env: Env, customerId: number, sessionId: number): Promise<RevokeByIdResult> {
  const result = await env.DB.prepare(`UPDATE customer_sessions SET revoked_at = datetime('now') WHERE id = ? AND customer_id = ? AND revoked_at IS NULL`)
    .bind(sessionId, customerId)
    .run();

  return result.meta.changes === 1 ? { ok: true } : { ok: false, reason: 'not_found' };
}
