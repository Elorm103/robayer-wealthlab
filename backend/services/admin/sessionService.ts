/**
 * Admin Session Service — Version 2.0 Phase 0.1 (Authentication
 * Foundation). See docs/v2-authentication-design.md's "Sessions".
 * Location matches the approved docs/v2-architecture.md folder
 * structure (`services/admin/sessionService.ts`).
 *
 * The only code that writes to `admin_sessions`. Mirrors
 * `unsubscribeService.ts`'s atomic-token pattern: the security-critical
 * decision ("is this session currently valid") is a single SELECT with
 * every condition in its own WHERE clause, and revocation is a single
 * atomic UPDATE gated on `revoked_at IS NULL` so two concurrent logout
 * requests can't double-fire the audit log.
 */

import type { Env } from '../../worker/env';
import { generateSessionToken, generateCsrfSecret } from '../../utils/adminSessionToken';

/** Absolute session lifetime — docs/v2-authentication-design.md's "Sessions". Fixed at creation, never extended: `last_seen_at` (updated on every validated request) is observability only, not an expiry-extension mechanism — the docs describe a sliding refresh "up to that cap" without specifying an idle-timeout duration, so this phase implements the one unambiguous, fully-specified part of that design (the 12h absolute cap) rather than inventing an undocumented idle-timeout number. */
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

/** Creates a new `admin_sessions` row for an already-authenticated admin (credential verification happens in `authService.ts`, before this is ever called). */
export async function createSession(env: Env, adminId: number, context: CreateSessionContext): Promise<CreatedSession> {
  const sessionToken = generateSessionToken();
  const csrfSecret = generateCsrfSecret();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60_000).toISOString();

  await env.DB.prepare(
    `INSERT INTO admin_sessions (token, admin_id, csrf_secret, ip_created, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(sessionToken, adminId, csrfSecret, context.ip, context.userAgent, expiresAt)
    .run();

  return { sessionToken, csrfSecret, expiresAt };
}

export type SessionCheckResult =
  | { ok: true; sessionId: number; adminId: number; role: string; email: string; name: string | null; csrfSecret: string; mustChangePassword: boolean }
  | { ok: false };

/**
 * The one place `requireAuth` (middleware/requireAuth.ts) asks "is this
 * session currently valid" — every condition (exists, not revoked, not
 * expired, owning admin still active and not soft-deleted) is in one
 * SELECT's WHERE clause, so there is no read-then-decide window where a
 * concurrent revocation/deactivation could be missed.
 *
 * `must_change_password` is read here (Version 2.1 Phase 3) because
 * `requireAuth()` needs it on every request to enforce the
 * force-password-change gate — a second query just for that flag would
 * be redundant.
 */
export async function validateSession(env: Env, tokenInput: unknown): Promise<SessionCheckResult> {
  if (typeof tokenInput !== 'string' || !SESSION_TOKEN_PATTERN.test(tokenInput)) {
    return { ok: false };
  }

  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT s.id AS sessionId, s.admin_id AS adminId, s.csrf_secret AS csrfSecret,
            u.role AS role, u.email AS email, u.name AS name, u.must_change_password AS mustChangePassword
     FROM admin_sessions s
     JOIN admin_users u ON u.id = s.admin_id
     WHERE s.token = ? AND s.revoked_at IS NULL AND s.expires_at > ?
       AND u.is_active = 1 AND u.deleted_at IS NULL`
  )
    .bind(tokenInput, now)
    .first<{ sessionId: number; adminId: number; csrfSecret: string; role: string; email: string; name: string | null; mustChangePassword: number }>();

  if (!row) return { ok: false };

  // Observability only (see SESSION_TTL_HOURS's comment above); does
  // not extend expires_at.
  await env.DB.prepare(`UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?`).bind(now, row.sessionId).run();

  return {
    ok: true,
    sessionId: row.sessionId,
    adminId: row.adminId,
    role: row.role,
    email: row.email,
    name: row.name,
    csrfSecret: row.csrfSecret,
    mustChangePassword: row.mustChangePassword === 1,
  };
}

export type RevokeSessionResult = { revoked: true; adminId: number } | { revoked: false };

/**
 * Revokes a session atomically (gated on `revoked_at IS NULL`, so two
 * concurrent logout calls for the same token can't both report success
 * or cause the caller to double-write the audit log). Idempotent from
 * the caller's perspective: a second call for an already-revoked token
 * returns `{ revoked: false }`, not an error.
 */
export async function revokeSession(env: Env, tokenInput: unknown): Promise<RevokeSessionResult> {
  if (typeof tokenInput !== 'string' || !SESSION_TOKEN_PATTERN.test(tokenInput)) {
    return { revoked: false };
  }

  const result = await env.DB.prepare(`UPDATE admin_sessions SET revoked_at = datetime('now') WHERE token = ? AND revoked_at IS NULL`)
    .bind(tokenInput)
    .run();

  if (result.meta.changes !== 1) return { revoked: false };

  const row = await env.DB.prepare(`SELECT admin_id AS adminId FROM admin_sessions WHERE token = ?`)
    .bind(tokenInput)
    .first<{ adminId: number }>();

  return row ? { revoked: true, adminId: row.adminId } : { revoked: false };
}

// ============================================================
// Sessions list / revoke-by-id — Version 2.1 Phase 3 (Identity &
// Security). Own-sessions-only by design: a session list is
// inherently personal, unlike Orders/Consultations, which are
// legitimately shared operational data even a `super_admin` reviews on
// another admin's behalf.
// ============================================================

export interface SessionListItem {
  id: number;
  ipCreated: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

/** Lists the calling admin's own non-revoked, non-expired sessions — never another admin's. */
export async function listSessions(env: Env, adminId: number, currentSessionId: number): Promise<SessionListItem[]> {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, ip_created AS ipCreated, user_agent AS userAgent, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt
     FROM admin_sessions
     WHERE admin_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY last_seen_at DESC`
  )
    .bind(adminId, now)
    .all<{ id: number; ipCreated: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string; expiresAt: string }>();

  return results.map((row) => ({ ...row, isCurrent: row.id === currentSessionId }));
}

export type RevokeByIdResult = { ok: true } | { ok: false; reason: 'not_found' };

/**
 * Revokes one of the calling admin's own sessions by id — verifies the
 * target session's `admin_id` matches the caller's own id BEFORE
 * revoking (the IDOR check the architecture review flagged: without
 * this, any authenticated admin could pass another admin's session id
 * and sign them out).
 */
export async function revokeSessionById(env: Env, adminId: number, sessionId: number): Promise<RevokeByIdResult> {
  const result = await env.DB.prepare(`UPDATE admin_sessions SET revoked_at = datetime('now') WHERE id = ? AND admin_id = ? AND revoked_at IS NULL`)
    .bind(sessionId, adminId)
    .run();

  return result.meta.changes === 1 ? { ok: true } : { ok: false, reason: 'not_found' };
}

/**
 * Revokes every active session for an admin EXCEPT one (the session
 * that just performed the action) — used by change-password: a
 * password change should invalidate every other session, but not sign
 * the admin out of the request that just made the change.
 */
export async function revokeAllSessionsExcept(env: Env, adminId: number, exceptSessionId: number): Promise<void> {
  await env.DB.prepare(`UPDATE admin_sessions SET revoked_at = datetime('now') WHERE admin_id = ? AND id != ? AND revoked_at IS NULL`)
    .bind(adminId, exceptSessionId)
    .run();
}

/**
 * Revokes every active session for an admin, with no exception — used
 * by reset-password (the admin isn't logged in during that flow, so
 * there is no "current" session to preserve) and forced logout after a
 * password reset, per the user's own explicit Phase 3 requirement.
 */
export async function revokeAllSessions(env: Env, adminId: number): Promise<void> {
  await env.DB.prepare(`UPDATE admin_sessions SET revoked_at = datetime('now') WHERE admin_id = ? AND revoked_at IS NULL`).bind(adminId).run();
}
