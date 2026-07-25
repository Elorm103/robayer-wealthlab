/**
 * Unit tests: customer authentication — Version 3.0.2 Milestone M1.
 * Covers password setup, login (including the guest-with-no-password
 * and wrong-password cases), and single-use token enforcement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import * as authService from '../../services/customer/authService';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');

async function insertToken(customerId: number, token: string, expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()) {
  await env.DB.prepare('INSERT INTO customer_password_tokens (token, customer_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, customerId, expiresAt)
    .run();
}

describe('customer authService', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM customer_password_tokens');
    await env.DB.exec('DELETE FROM customer_sessions');
    await env.DB.exec('DELETE FROM customer_profiles');
    await env.DB.exec('DELETE FROM customers');
  });

  it('a guest customer with no password set cannot log in (password_not_set, not a crash)', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'guest-only@example.com', false);
    void customerId;

    const result = await authService.login(env as any, logger, 'guest-only@example.com', 'anything-at-all', { ip: null, userAgent: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('password_not_set');
  });

  it('setPassword rejects a weak password without consuming the token', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'weak-pw@example.com', false);
    await insertToken(customerId, 'weak-pw-token-'.padEnd(64, '0'));

    const result = await authService.setPassword(env as any, logger, 'weak-pw-token-'.padEnd(64, '0'), 'short');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('validation');

    // Token still unused — a rejected weak password must not burn the single-use token.
    const tokenRow = await env.DB.prepare('SELECT used_at FROM customer_password_tokens WHERE token = ?')
      .bind('weak-pw-token-'.padEnd(64, '0'))
      .first<{ used_at: string | null }>();
    expect(tokenRow?.used_at).toBeNull();
  });

  it('setPassword with a strong password succeeds, then the token cannot be reused', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'strong-pw@example.com', false);
    const token = 'strong-pw-token-'.padEnd(64, '1');
    await insertToken(customerId, token);

    const first = await authService.setPassword(env as any, logger, token, 'correct-horse-battery-staple-1');
    expect(first.ok).toBe(true);

    const second = await authService.setPassword(env as any, logger, token, 'a-different-strong-password-2');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('invalid_or_expired_token');
  });

  it('an expired token is rejected', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'expired-token@example.com', false);
    const token = 'expired-token-'.padEnd(64, '2');
    await insertToken(customerId, token, new Date(Date.now() - 60_000).toISOString()); // already expired

    const result = await authService.setPassword(env as any, logger, token, 'correct-horse-battery-staple-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_or_expired_token');
  });

  it('login succeeds after a real password is set, and fails with the wrong password', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'login-cycle@example.com', false);
    const token = 'login-cycle-token'.padEnd(64, '3');
    await insertToken(customerId, token);
    await authService.setPassword(env as any, logger, token, 'the-real-password-123');

    const good = await authService.login(env as any, logger, 'login-cycle@example.com', 'the-real-password-123', { ip: null, userAgent: null });
    expect(good.ok).toBe(true);

    const bad = await authService.login(env as any, logger, 'login-cycle@example.com', 'totally-wrong', { ip: null, userAgent: null });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('invalid_credentials');
  });

  it('login for a nonexistent email fails with the same generic reason as a wrong password (no enumeration)', async () => {
    const result = await authService.login(env as any, logger, 'does-not-exist@example.com', 'whatever-password', { ip: null, userAgent: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_credentials');
  });

  it('concurrent redemption of the same token succeeds exactly once (Sprint 2B MAR gap: token double-redemption race)', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'concurrent-redeem@example.com', false);
    const token = 'concurrent-redeem-token'.padEnd(64, '4');
    await insertToken(customerId, token);

    const [first, second] = await Promise.all([
      authService.setPassword(env as any, logger, token, 'first-attempt-password-1'),
      authService.setPassword(env as any, logger, token, 'second-attempt-password-2'),
    ]);

    const outcomes = [first, second];
    const successes = outcomes.filter((r) => r.ok);
    const failures = outcomes.filter((r) => !r.ok);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    if (!failures[0].ok) expect(failures[0].reason).toBe('invalid_or_expired_token');

    // Exactly one of the two candidate passwords actually took effect -
    // never both, never neither.
    const loginFirst = await authService.login(env as any, logger, 'concurrent-redeem@example.com', 'first-attempt-password-1', { ip: null, userAgent: null });
    const loginSecond = await authService.login(env as any, logger, 'concurrent-redeem@example.com', 'second-attempt-password-2', { ip: null, userAgent: null });
    expect([loginFirst.ok, loginSecond.ok].filter(Boolean).length).toBe(1);

    const tokenRow = await env.DB.prepare('SELECT used_at FROM customer_password_tokens WHERE token = ?').bind(token).first<{ used_at: string | null }>();
    expect(tokenRow?.used_at).toBeTruthy();
  });
});
