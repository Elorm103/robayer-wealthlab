/**
 * Admin Authentication Service — Version 2.0 Phase 0.1 (Authentication
 * Foundation). See docs/v2-authentication-design.md's "Login flow".
 * Location matches the approved docs/v2-architecture.md folder
 * structure (`services/admin/authService.ts`) — credential
 * verification and login/logout orchestration; session-row lifecycle
 * itself lives in the sibling `sessionService.ts`.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { verifyPassword } from '../../utils/passwordHash';
import * as sessionService from './sessionService';
import * as auditService from './auditService';

/**
 * A fixed, syntactically-valid `salt:iterations:hash` value that does
 * not correspond to any real password. Used as the comparison target
 * when no matching active admin account is found, so `verifyPassword()`
 * still performs a full PBKDF2 derivation (600,000 iterations) before
 * returning — without this, a lookup miss would return almost
 * instantly while a lookup hit takes the full KDF time, letting a
 * timing attack distinguish "no such account" from "wrong password"
 * even though the response body/status are identical. See
 * docs/v2-authentication-design.md's "identical response shape/timing
 * whether the email doesn't exist or the password is wrong."
 */
const DUMMY_PASSWORD_HASH = `${'0'.repeat(32)}:600000:${'0'.repeat(64)}`;

interface AdminUserRow {
  id: number;
  email: string;
  passwordHash: string;
  role: string;
  name: string | null;
}

export type LoginDenialReason = 'invalid_credentials';

export type LoginResult =
  | {
      ok: true;
      adminId: number;
      role: string;
      email: string;
      name: string | null;
      sessionToken: string;
      csrfSecret: string;
      expiresAt: string;
    }
  | { ok: false; reason: LoginDenialReason };

export interface LoginContext {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Steps 3-6 of docs/v2-authentication-design.md's login flow (rate
 * limiting is step 2, applied by the route before this is ever called —
 * see routes/admin/auth.ts). Looks up `admin_users WHERE email = ? AND
 * is_active = 1 AND deleted_at IS NULL` exactly as specified: an
 * inactive or soft-deleted account simply doesn't match, falling into
 * the same generic "invalid credentials" outcome as a wrong password or
 * a nonexistent email — this endpoint deliberately never reveals which
 * of the three actually happened, in the response OR in its timing.
 */
export async function login(env: Env, logger: Logger, emailInput: unknown, passwordInput: unknown, context: LoginContext): Promise<LoginResult> {
  if (typeof emailInput !== 'string' || typeof passwordInput !== 'string' || passwordInput.length === 0) {
    return { ok: false, reason: 'invalid_credentials' };
  }
  const email = emailInput.trim().toLowerCase();

  const row = await env.DB.prepare(
    `SELECT id, email, password_hash AS passwordHash, role, name
     FROM admin_users WHERE email = ? AND is_active = 1 AND deleted_at IS NULL`
  )
    .bind(email)
    .first<AdminUserRow>();

  // Always runs, win or miss — see DUMMY_PASSWORD_HASH's comment above.
  const passwordValid = await verifyPassword(passwordInput, row ? row.passwordHash : DUMMY_PASSWORD_HASH);

  if (!row || !passwordValid) {
    await auditService.record(env, logger, {
      actorType: 'system',
      actorId: null,
      action: 'admin.login_failed',
      metadata: { email },
    });
    return { ok: false, reason: 'invalid_credentials' };
  }

  const session = await sessionService.createSession(env, row.id, context);

  await env.DB.prepare(`UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?`).bind(row.id).run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId: row.id,
    action: 'admin.login',
    entityType: 'admin_user',
    entityId: row.id,
  });

  logger.info('admin.login_succeeded', { adminId: row.id });

  return {
    ok: true,
    adminId: row.id,
    role: row.role,
    email: row.email,
    name: row.name,
    sessionToken: session.sessionToken,
    csrfSecret: session.csrfSecret,
    expiresAt: session.expiresAt,
  };
}

/**
 * Logout — revokes the session via `sessionService.revokeSession()`
 * (the atomic, idempotent-by-construction operation) then records the
 * audit event. Returns true only if this call actually revoked a
 * session (a second logout call for an already-revoked/nonexistent
 * token returns false, not an error — see routes/admin/auth.ts).
 */
export async function logout(env: Env, logger: Logger, tokenInput: unknown): Promise<boolean> {
  const result = await sessionService.revokeSession(env, tokenInput);
  if (!result.revoked) return false;

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId: result.adminId,
    action: 'admin.logout',
    entityType: 'admin_user',
    entityId: result.adminId,
  });

  logger.info('admin.logout', { adminId: result.adminId });

  return true;
}
