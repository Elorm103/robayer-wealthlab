/**
 * Unit tests: admin password-reset flow — Phase J.0.2. This project had
 * no test coverage at all for services/admin/authService.ts's
 * resetPassword()/forgotPassword() before this file. Written after
 * fixing the actual production defect (a frontend null-pointer crash in
 * admin-reset-password.js that stopped the request from ever being
 * sent — see that file's own comment); these tests cover the backend
 * contract the frontend fix now actually reaches.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import * as authService from '../../../services/admin/authService';
import { verifyPassword } from '../../../utils/passwordHash';
import { createLogger, type Logger, type LogContext } from '../../../utils/logger';

const logger = createLogger('test-request-id', 'test');

const STRONG_PASSWORD = 'correct-horse-battery-staple-9';
const TOO_SHORT_PASSWORD = 'short-pw-1';

async function insertAdmin(email: string, overrides: { failedLoginAttempts?: number; lockedUntil?: string | null } = {}): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO admin_users (email, password_hash, role, is_active, must_change_password, failed_login_attempts, locked_until)
     VALUES (?, ?, 'super_admin', 1, 0, ?, ?)`
  )
    .bind(email, `0${'0'.repeat(31)}:100000:${'0'.repeat(64)}`, overrides.failedLoginAttempts ?? 0, overrides.lockedUntil ?? null)
    .run();
  return Number(insert.meta.last_row_id);
}

async function insertResetToken(adminId: number, token: string, expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()): Promise<void> {
  await env.DB.prepare(`INSERT INTO password_reset_tokens (token, admin_id, expires_at) VALUES (?, ?, ?)`).bind(token, adminId, expiresAt).run();
}

/** Records every log call so tests can assert nothing sensitive was ever passed to it — never the actual password or token value. */
function createRecordingLogger(): { logger: Logger; calls: Array<{ message: string; context?: LogContext }> } {
  const calls: Array<{ message: string; context?: LogContext }> = [];
  return {
    calls,
    logger: {
      info: (message, context) => calls.push({ message, context }),
      warn: (message, context) => calls.push({ message, context }),
      error: (message, context) => calls.push({ message, context }),
    },
  };
}

describe('admin authService — resetPassword', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM password_reset_tokens');
    await env.DB.exec('DELETE FROM admin_sessions');
    await env.DB.exec('DELETE FROM login_history');
    await env.DB.exec('DELETE FROM admin_users');
  });

  it('a valid token + strong password succeeds, the password actually changes, and the account can log in with it', async () => {
    const adminId = await insertAdmin('reset-valid@example.com');
    const token = 'valid-reset-token-'.padEnd(64, '1');
    await insertResetToken(adminId, token);

    const result = await authService.resetPassword(env as any, logger, token, STRONG_PASSWORD);
    expect(result.ok).toBe(true);

    const row = await env.DB.prepare('SELECT password_hash FROM admin_users WHERE id = ?').bind(adminId).first<{ password_hash: string }>();
    expect(await verifyPassword(STRONG_PASSWORD, row!.password_hash)).toBe(true);

    const loginResult = await authService.login(env as any, logger, 'reset-valid@example.com', STRONG_PASSWORD, { ip: null, userAgent: null });
    expect(loginResult.ok).toBe(true);
  });

  it('clears any existing lockout as part of a successful reset', async () => {
    const adminId = await insertAdmin('reset-was-locked@example.com', {
      failedLoginAttempts: 8,
      lockedUntil: new Date(Date.now() + 15 * 60_000).toISOString(), // still locked
    });
    const token = 'unlock-on-reset-token-'.padEnd(64, '2');
    await insertResetToken(adminId, token);

    const result = await authService.resetPassword(env as any, logger, token, STRONG_PASSWORD);
    expect(result.ok).toBe(true);

    const row = await env.DB.prepare('SELECT failed_login_attempts, locked_until FROM admin_users WHERE id = ?').bind(adminId).first<{ failed_login_attempts: number; locked_until: string | null }>();
    expect(row!.failed_login_attempts).toBe(0);
    expect(row!.locked_until).toBeNull();
  });

  it('successfully invalidates the token — a second use of the same token is rejected', async () => {
    const adminId = await insertAdmin('reset-single-use@example.com');
    const token = 'single-use-token-'.padEnd(64, '3');
    await insertResetToken(adminId, token);

    const first = await authService.resetPassword(env as any, logger, token, STRONG_PASSWORD);
    expect(first.ok).toBe(true);

    const second = await authService.resetPassword(env as any, logger, token, 'a-different-strong-password-2');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('invalid_or_expired_token');

    // And the first password is still the one that works — the rejected reuse never touched it.
    const row = await env.DB.prepare('SELECT password_hash FROM admin_users WHERE id = ?').bind(adminId).first<{ password_hash: string }>();
    expect(await verifyPassword(STRONG_PASSWORD, row!.password_hash)).toBe(true);
  });

  it('an invalid/nonexistent token is rejected', async () => {
    const result = await authService.resetPassword(env as any, logger, 'this-token-was-never-issued-'.padEnd(64, '4'), STRONG_PASSWORD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_or_expired_token');
  });

  it('an expired token is rejected, and the password is left unchanged', async () => {
    const adminId = await insertAdmin('reset-expired@example.com');
    const token = 'expired-reset-token-'.padEnd(64, '5');
    await insertResetToken(adminId, token, new Date(Date.now() - 60_000).toISOString());

    const result = await authService.resetPassword(env as any, logger, token, STRONG_PASSWORD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_or_expired_token');

    const loginResult = await authService.login(env as any, logger, 'reset-expired@example.com', STRONG_PASSWORD, { ip: null, userAgent: null });
    expect(loginResult.ok).toBe(false);
  });

  it('a password shorter than 12 characters is rejected by strength validation, and the token is NOT consumed', async () => {
    const adminId = await insertAdmin('reset-weak@example.com');
    const token = 'weak-password-token-'.padEnd(64, '6');
    await insertResetToken(adminId, token);

    const result = await authService.resetPassword(env as any, logger, token, TOO_SHORT_PASSWORD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('validation');

    const tokenRow = await env.DB.prepare('SELECT used_at FROM password_reset_tokens WHERE token = ?').bind(token).first<{ used_at: string | null }>();
    expect(tokenRow?.used_at).toBeNull();

    // The token is still valid — a subsequent attempt with a strong password succeeds.
    const retry = await authService.resetPassword(env as any, logger, token, STRONG_PASSWORD);
    expect(retry.ok).toBe(true);
  });

  it('a successful reset revokes every existing admin session', async () => {
    const adminId = await insertAdmin('reset-revokes-sessions@example.com');
    await env.DB.prepare(`INSERT INTO admin_sessions (token, admin_id, csrf_secret, expires_at) VALUES (?, ?, ?, ?)`)
      .bind('pre-reset-session-token-'.padEnd(64, '7'), adminId, 'pre-reset-csrf-secret'.padEnd(64, '7'), new Date(Date.now() + 12 * 3600_000).toISOString())
      .run();

    const token = 'revokes-sessions-token-'.padEnd(64, '8');
    await insertResetToken(adminId, token);
    const result = await authService.resetPassword(env as any, logger, token, STRONG_PASSWORD);
    expect(result.ok).toBe(true);

    const sessionRow = await env.DB.prepare('SELECT revoked_at FROM admin_sessions WHERE admin_id = ?').bind(adminId).first<{ revoked_at: string | null }>();
    expect(sessionRow?.revoked_at).not.toBeNull();
  });

  it('never logs the raw password or the raw token value', async () => {
    const adminId = await insertAdmin('reset-no-leak@example.com');
    const token = 'no-leak-in-logs-token-'.padEnd(64, '9');
    await insertResetToken(adminId, token);
    const { logger: recordingLogger, calls } = createRecordingLogger();

    await authService.resetPassword(env as any, recordingLogger, token, STRONG_PASSWORD);

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(STRONG_PASSWORD);
    expect(serialized).not.toContain(token);
  });
});

describe('admin authService — forgotPassword', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM password_reset_tokens');
    await env.DB.exec('DELETE FROM admin_users');
  });

  it('never logs the submitted email in a way that leaks a password/token (defensive — forgotPassword itself never has either)', async () => {
    await insertAdmin('forgot-no-leak@example.com');
    const { logger: recordingLogger, calls } = createRecordingLogger();

    await authService.forgotPassword(env as any, recordingLogger, 'forgot-no-leak@example.com', 'https://example.test');

    for (const call of calls) {
      expect(JSON.stringify(call)).not.toMatch(/password_hash|token=[a-f0-9]{64}/);
    }
  });
});
