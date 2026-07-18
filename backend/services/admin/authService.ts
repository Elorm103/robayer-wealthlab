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
import { verifyPassword, hashPassword } from '../../utils/passwordHash';
import { generatePasswordResetToken } from '../../utils/adminSessionToken';
import { validatePasswordStrength, type PasswordValidationError } from '../../utils/passwordPolicy';
import { sendEmail } from '../emailService';
import * as sessionService from './sessionService';
import * as auditService from './auditService';
import * as loginHistoryService from './loginHistoryService';

/**
 * A fixed, syntactically-valid `salt:iterations:hash` value that does
 * not correspond to any real password. Used as the comparison target
 * when no matching active admin account is found, so `verifyPassword()`
 * still performs a full PBKDF2 derivation before returning — without
 * this, a lookup miss would return almost instantly while a lookup hit
 * takes the full KDF time, letting a timing attack distinguish "no such
 * account" from "wrong password" even though the response body/status
 * are identical. See docs/v2-authentication-design.md's "identical
 * response shape/timing whether the email doesn't exist or the
 * password is wrong."
 *
 * The embedded iteration count must match `passwordHash.ts`'s
 * `PBKDF2_ITERATIONS` (100,000 — a Cloudflare Workers `SubtleCrypto`
 * ceiling, not a design choice, see that file's comment). A mismatch
 * here isn't just a timing-consistency bug: `verifyPassword()` re-derives
 * using whatever iteration count is embedded in the string it's given,
 * so a stale value above the runtime's cap makes this exact path throw
 * `NotSupportedError` in production — precisely the bug this comment
 * now documents, found via `wrangler tail` when this constant still
 * said 600000 after `passwordHash.ts`'s own constant had already been
 * lowered to fit the real Workers ceiling.
 */
const DUMMY_PASSWORD_HASH = `${'0'.repeat(32)}:100000:${'0'.repeat(64)}`;

interface AdminUserRow {
  id: number;
  email: string;
  passwordHash: string;
  role: string;
  name: string | null;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  mustChangePassword: number;
}

/**
 * Account lockout — Version 2.1 Phase 3 (Identity & Security). A
 * time-boxed lockout, not permanent: a permanent lockout requiring
 * another admin's manual intervention is a real support burden for a
 * 1–3-person team, and 15 minutes already defeats a brute-force
 * attempt at this project's realistic threat model.
 */
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

export type LoginDenialReason = 'invalid_credentials';

export type LoginResult =
  | {
      ok: true;
      adminId: number;
      role: string;
      email: string;
      name: string | null;
      mustChangePassword: boolean;
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
 * RFC 5321 §4.5.3.1.3 caps a full email path (mailbox) at 254
 * characters. Rejecting anything longer here — before the value ever
 * reaches D1 — closes a real crash found during the Phase 0.1 security
 * audit: an unbounded email string bound into the `admin_users` lookup
 * causes D1 to throw `SQLITE_TOOBIG` (confirmed at ~5MB locally),
 * which `login()` had no guard against, so it propagated as an
 * unhandled exception. `errorHandler.ts` catches it and returns a safe
 * generic 500 (no stack trace leaks), so this was never an information
 * disclosure — but it IS a distinct, fast-failing code path that skips
 * the DUMMY_PASSWORD_HASH comparison entirely, meaning an attacker
 * sending an oversized email gets a measurably faster response than a
 * normal wrong-password attempt, undermining exactly the "identical
 * timing regardless of why the attempt failed" guarantee this function
 * exists to provide. See docs/v2-authentication-design.md's "identical
 * response shape/timing."
 */
const MAX_EMAIL_LENGTH = 254;
/** Generous enough for any real password; bounds the input fed into `crypto.subtle.importKey`/`deriveBits` so a maliciously huge string can't be used to inflate a single request's cost. */
const MAX_PASSWORD_LENGTH = 256;

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
  if (
    typeof emailInput !== 'string' ||
    typeof passwordInput !== 'string' ||
    passwordInput.length === 0 ||
    emailInput.length > MAX_EMAIL_LENGTH ||
    passwordInput.length > MAX_PASSWORD_LENGTH
  ) {
    return { ok: false, reason: 'invalid_credentials' };
  }
  const email = emailInput.trim().toLowerCase();

  const row = await env.DB.prepare(
    `SELECT id, email, password_hash AS passwordHash, role, name, failed_login_attempts AS failedLoginAttempts, locked_until AS lockedUntil, must_change_password AS mustChangePassword
     FROM admin_users WHERE email = ? AND is_active = 1 AND deleted_at IS NULL`
  )
    .bind(email)
    .first<AdminUserRow>();

  const now = new Date();
  const isLocked = !!row?.lockedUntil && new Date(row.lockedUntil) > now;

  // Always runs, win or miss, locked or not — see DUMMY_PASSWORD_HASH's
  // comment above. A locked account still performs the full PBKDF2
  // comparison (against the real hash, not DUMMY — the row genuinely
  // exists) so a locked-vs-wrong-password attempt is indistinguishable
  // by timing; the lockout decision below is made independently of
  // whether the password was actually correct.
  const passwordValid = await verifyPassword(passwordInput, row ? row.passwordHash : DUMMY_PASSWORD_HASH);

  if (!row) {
    await auditService.record(env, logger, { actorType: 'system', actorId: null, action: 'admin.login_failed', metadata: { email } });
    return { ok: false, reason: 'invalid_credentials' };
  }

  if (isLocked) {
    await loginHistoryService.recordLoginHistory(env, { adminId: row.id, outcome: 'failed_locked', ip: context.ip, userAgent: context.userAgent });
    await auditService.record(env, logger, { actorType: 'system', actorId: null, action: 'admin.login_failed', entityType: 'admin_user', entityId: row.id, metadata: { email, reason: 'locked' } });
    return { ok: false, reason: 'invalid_credentials' };
  }

  if (!passwordValid) {
    const nextAttempts = row.failedLoginAttempts + 1;
    const shouldLock = nextAttempts >= LOCKOUT_THRESHOLD;
    const lockedUntil = shouldLock ? new Date(now.getTime() + LOCKOUT_MINUTES * 60_000).toISOString() : null;

    await env.DB.prepare(`UPDATE admin_users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?`).bind(nextAttempts, lockedUntil, row.id).run();

    await loginHistoryService.recordLoginHistory(env, { adminId: row.id, outcome: 'failed_password', ip: context.ip, userAgent: context.userAgent });
    await auditService.record(env, logger, {
      actorType: 'system',
      actorId: null,
      action: 'admin.login_failed',
      entityType: 'admin_user',
      entityId: row.id,
      metadata: { email, failedAttempts: nextAttempts, locked: shouldLock },
    });
    return { ok: false, reason: 'invalid_credentials' };
  }

  // Success — reset the lockout counter and create the session.
  await env.DB.prepare(`UPDATE admin_users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?`).bind(row.id).run();

  const session = await sessionService.createSession(env, row.id, context);

  await loginHistoryService.recordLoginHistory(env, { adminId: row.id, outcome: 'success', ip: context.ip, userAgent: context.userAgent });
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
    mustChangePassword: row.mustChangePassword === 1,
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

// ============================================================
// Change password — Version 2.1 Phase 3 (Identity & Security).
// Requires the current password re-entered (not just an active
// session — a stolen/left-open session shouldn't be enough to change
// the password). All OTHER active sessions for this admin are revoked
// on success — a password change should invalidate every session
// except the one that just made the change.
// ============================================================

export type ChangePasswordResult = { ok: true } | { ok: false; reason: 'incorrect_current_password' } | { ok: false; reason: 'validation'; errors: PasswordValidationError[] };

export async function changePassword(
  env: Env,
  logger: Logger,
  adminId: number,
  currentSessionId: number,
  currentPasswordInput: unknown,
  newPasswordInput: unknown
): Promise<ChangePasswordResult> {
  const row = await env.DB.prepare(`SELECT email, password_hash AS passwordHash FROM admin_users WHERE id = ?`)
    .bind(adminId)
    .first<{ email: string; passwordHash: string }>();
  if (!row) return { ok: false, reason: 'incorrect_current_password' };

  if (typeof currentPasswordInput !== 'string' || !(await verifyPassword(currentPasswordInput, row.passwordHash))) {
    await auditService.record(env, logger, { actorType: 'admin', actorId: adminId, action: 'admin.change_password_failed', entityType: 'admin_user', entityId: adminId });
    return { ok: false, reason: 'incorrect_current_password' };
  }

  const strengthErrors = validatePasswordStrength(newPasswordInput, { email: row.email });
  if (typeof newPasswordInput === 'string' && newPasswordInput === currentPasswordInput) {
    strengthErrors.push({ field: 'newPassword', message: 'New password must be different from your current password.' });
  }
  if (strengthErrors.length > 0) return { ok: false, reason: 'validation', errors: strengthErrors };

  const newHash = await hashPassword(newPasswordInput as string);
  await env.DB.prepare(`UPDATE admin_users SET password_hash = ?, password_updated_at = datetime('now'), must_change_password = 0 WHERE id = ?`)
    .bind(newHash, adminId)
    .run();

  await sessionService.revokeAllSessionsExcept(env, adminId, currentSessionId);

  await auditService.record(env, logger, { actorType: 'admin', actorId: adminId, action: 'admin.password_changed', entityType: 'admin_user', entityId: adminId });
  logger.info('admin.password_changed', { adminId });

  return { ok: true };
}

// ============================================================
// Forgot / reset password — Version 2.1 Phase 3 (Identity & Security).
// The same no-user-enumeration discipline login() already established:
// forgot-password always returns the identical generic outcome
// regardless of whether the email exists, and only sends a real email
// if it does.
// ============================================================

const PASSWORD_RESET_TOKEN_TTL_MINUTES = 30;

export async function forgotPassword(env: Env, logger: Logger, emailInput: unknown, siteBaseUrl: string): Promise<void> {
  if (typeof emailInput !== 'string' || emailInput.length === 0 || emailInput.length > MAX_EMAIL_LENGTH) return;
  const email = emailInput.trim().toLowerCase();

  const row = await env.DB.prepare(`SELECT id FROM admin_users WHERE email = ? AND is_active = 1 AND deleted_at IS NULL`).bind(email).first<{ id: number }>();
  if (!row) {
    // No enumeration signal: same code path either way, just nothing
    // further happens for a nonexistent/inactive account.
    return;
  }

  const token = generatePasswordResetToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MINUTES * 60_000).toISOString();

  await env.DB.prepare(`INSERT INTO password_reset_tokens (token, admin_id, expires_at) VALUES (?, ?, ?)`).bind(token, row.id, expiresAt).run();

  await sendEmail(env, logger, {
    template: 'password-reset',
    to: email,
    data: { email, resetUrl: `${siteBaseUrl}/admin/reset-password/?token=${token}` },
    entityType: 'admin_user',
    entityId: row.id,
  });

  await auditService.record(env, logger, { actorType: 'admin', actorId: row.id, action: 'admin.password_reset_requested', entityType: 'admin_user', entityId: row.id });
}

export type ResetPasswordResult = { ok: true } | { ok: false; reason: 'invalid_or_expired_token' } | { ok: false; reason: 'validation'; errors: PasswordValidationError[] };

export async function resetPassword(env: Env, logger: Logger, tokenInput: unknown, newPasswordInput: unknown): Promise<ResetPasswordResult> {
  if (typeof tokenInput !== 'string' || tokenInput.length === 0) return { ok: false, reason: 'invalid_or_expired_token' };

  const now = new Date().toISOString();
  const tokenRow = await env.DB.prepare(
    `SELECT t.id AS tokenId, t.admin_id AS adminId, u.email AS email
     FROM password_reset_tokens t
     JOIN admin_users u ON u.id = t.admin_id
     WHERE t.token = ? AND t.used_at IS NULL AND t.expires_at > ? AND u.is_active = 1 AND u.deleted_at IS NULL`
  )
    .bind(tokenInput, now)
    .first<{ tokenId: number; adminId: number; email: string }>();

  if (!tokenRow) return { ok: false, reason: 'invalid_or_expired_token' };

  const strengthErrors = validatePasswordStrength(newPasswordInput, { email: tokenRow.email });
  if (strengthErrors.length > 0) return { ok: false, reason: 'validation', errors: strengthErrors };

  const newHash = await hashPassword(newPasswordInput as string);

  // Token is marked used atomically WITH the password update, gated on
  // `used_at IS NULL` — the same race the token was already selected
  // against above, closed again here so two concurrent requests for
  // the same token can't both succeed.
  const consumed = await env.DB.prepare(`UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL`).bind(tokenRow.tokenId).run();
  if (consumed.meta.changes !== 1) return { ok: false, reason: 'invalid_or_expired_token' };

  await env.DB.prepare(
    `UPDATE admin_users SET password_hash = ?, password_updated_at = datetime('now'), must_change_password = 0, failed_login_attempts = 0, locked_until = NULL WHERE id = ?`
  )
    .bind(newHash, tokenRow.adminId)
    .run();

  // Forced logout after a password reset, per the user's own explicit
  // Phase 3 requirement — the admin isn't logged in during this flow,
  // so there's no "current" session to preserve (unlike changePassword).
  await sessionService.revokeAllSessions(env, tokenRow.adminId);

  await auditService.record(env, logger, { actorType: 'admin', actorId: tokenRow.adminId, action: 'admin.password_reset_completed', entityType: 'admin_user', entityId: tokenRow.adminId });
  logger.info('admin.password_reset_completed', { adminId: tokenRow.adminId });

  return { ok: true };
}
