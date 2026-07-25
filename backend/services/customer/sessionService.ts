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

/** Revokes every active session for a customer — used after a password change/reset, mirroring admin's `revokeAllSessions()`. No "except current" variant exists yet in M1 (unlike admin's `revokeAllSessionsExcept`) since the customer dashboard's own session-management UI is a Milestone M3 concern, not M1's. */
export async function revokeAllSessions(env: Env, customerId: number): Promise<void> {
  await env.DB.prepare(`UPDATE customer_sessions SET revoked_at = datetime('now') WHERE customer_id = ? AND revoked_at IS NULL`)
    .bind(customerId)
    .run();
}
