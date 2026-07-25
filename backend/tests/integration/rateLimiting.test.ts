/**
 * Integration tests: rate limiting on the customer-auth endpoints -
 * Version 3.0.2 Sprint 2B (MAR closeout). Added to close a gap the
 * Milestone Acceptance Review identified: the rate limiter itself
 * (middleware/rateLimit.ts) was implemented and wired into
 * routes/customer/auth.ts (login 5/15min, forgot-password 3/15min,
 * set-password 10/15min) but had zero automated test coverage.
 *
 * Each test uses its own distinct CF-Connecting-IP so it gets an
 * isolated ratelimit:{endpoint}:{ip} KV bucket - never sharing (and
 * therefore never being polluted by, or polluting) the default
 * "unknown" bucket every other test in this suite implicitly uses by
 * omitting that header.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM customer_password_tokens');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
});

describe('customer auth rate limiting', () => {
  it('login: the 6th attempt within the window is rejected with RATE_LIMITED (limit is 5/15min)', async () => {
    const ip = '203.0.113.10';
    const results: any[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await SELF.fetch('https://example.com/api/customer/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ email: 'no-such-account@example.com', password: 'whatever-password' }),
      });
      results.push(await res.json());
    }

    for (let i = 0; i < 5; i++) {
      expect(results[i].error.code).toBe('INVALID_CREDENTIALS');
    }
    expect(results[5].error.code).toBe('RATE_LIMITED');
  });

  it('set-password: the 11th attempt within the window is rejected with RATE_LIMITED (limit is 10/15min)', async () => {
    const ip = '203.0.113.20';
    const results: any[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await SELF.fetch('https://example.com/api/customer/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ token: 'not-a-real-token', newPassword: 'irrelevant-password-1' }),
      });
      results.push(await res.json());
    }

    for (let i = 0; i < 10; i++) {
      expect(results[i].error.code).toBe('INVALID_TOKEN');
    }
    expect(results[10].error.code).toBe('RATE_LIMITED');
  });

  it('forgot-password: the 4th attempt within the window is silently absorbed (limit is 3/15min) - same generic response, but no 4th token minted', async () => {
    const ip = '203.0.113.30';
    const { customerId } = await findOrCreateCustomer(env as any, 'rate-limited-forgot@example.com', false);
    void customerId;

    const responses: any[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await SELF.fetch('https://example.com/api/customer/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ email: 'rate-limited-forgot@example.com' }),
      });
      responses.push(await res.json());
    }

    // Every response looks identical - forgot-password never leaks
    // rate-limit state to the client, by design (no-enumeration).
    for (const body of responses) {
      expect(body).toEqual({ success: true, data: { requested: true } });
    }

    // But only the first 3 calls actually reached authService.forgotPassword()
    // and minted a token; the 4th was rejected before that ever happened.
    const tokenCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM customer_password_tokens WHERE customer_id = ?')
      .bind(customerId)
      .first<{ n: number }>();
    expect(tokenCount?.n).toBe(3);
  });
});
