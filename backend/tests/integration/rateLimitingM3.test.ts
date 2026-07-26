/**
 * Integration tests: rate limiting on Milestone M3's new endpoints -
 * Version 3.1, added at Sprint M3D closeout. Mirrors
 * tests/integration/rateLimitingM2.test.ts's own pattern exactly (one
 * distinct CF-Connecting-IP per test for an isolated KV bucket). The
 * rate limiter itself was already implemented and wired into all three
 * M3 endpoints below, but had zero automated test coverage - flagged as
 * a non-blocking observation in docs/v3.1-m3-acceptance-report.md
 * Section 11 Item 4, closed here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession } from '../../services/customer/sessionService';
import { setPassword } from '../../services/customer/authService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');

beforeEach(async () => {
  await env.DB.exec('DELETE FROM customer_password_tokens');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
});

async function seedLoggedInCustomer(email: string, password = 'a-real-strong-password-1'): Promise<{ cookieHeader: string; csrfSecret: string }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const token = `${email}-token`.padEnd(64, '5').slice(0, 64);
  await env.DB.prepare('INSERT INTO customer_password_tokens (token, customer_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, customerId, new Date(Date.now() + 30 * 60_000).toISOString())
    .run();
  await setPassword(env as any, logger, token, password);
  const session = await createSession(env as any, customerId, { ip: null, userAgent: null });
  return { cookieHeader: `customer_session=${session.sessionToken}; customer_csrf=${session.csrfSecret}`, csrfSecret: session.csrfSecret };
}

describe('M3 endpoint rate limiting', () => {
  it('GET /api/customer/sessions: the 61st attempt within the window is rejected with RATE_LIMITED (limit is 60/15min)', async () => {
    const ip = '203.0.113.201';
    const { cookieHeader } = await seedLoggedInCustomer('m3-ratelimit-sessions-read@example.com');

    const results: any[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await SELF.fetch('https://example.com/api/customer/sessions', { headers: { Cookie: cookieHeader, 'CF-Connecting-IP': ip } });
      results.push(await res.json());
    }

    for (let i = 0; i < 60; i++) {
      expect(results[i].success).toBe(true);
    }
    expect(results[60].error.code).toBe('RATE_LIMITED');
  }, 30_000);

  it('POST /api/customer/sessions/:sessionId/revoke: the 21st attempt within the window is rejected with RATE_LIMITED (limit is 20/15min)', async () => {
    const ip = '203.0.113.202';
    const { cookieHeader, csrfSecret } = await seedLoggedInCustomer('m3-ratelimit-sessions-write@example.com');

    const results: any[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await SELF.fetch('https://example.com/api/customer/sessions/999999/revoke', {
        method: 'POST',
        headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret, 'CF-Connecting-IP': ip },
      });
      results.push(await res.json());
    }

    for (let i = 0; i < 20; i++) {
      expect(results[i].error.code).toBe('NOT_FOUND'); // no such session id, but rate limit not yet hit
    }
    expect(results[20].error.code).toBe('RATE_LIMITED');
  }, 30_000);

  it('POST /api/customer/auth/change-password: the 11th attempt within the window is rejected with RATE_LIMITED (limit is 10/15min)', async () => {
    const ip = '203.0.113.203';
    const { cookieHeader, csrfSecret } = await seedLoggedInCustomer('m3-ratelimit-change-pw@example.com', 'the-real-password-1');

    const results: any[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await SELF.fetch('https://example.com/api/customer/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret, 'CF-Connecting-IP': ip },
        body: JSON.stringify({ currentPassword: 'totally-wrong', newPassword: 'a-new-strong-password-2' }),
      });
      results.push(await res.json());
    }

    for (let i = 0; i < 10; i++) {
      expect(results[i].error.code).toBe('INVALID_CREDENTIALS'); // wrong current password, but rate limit not yet hit
    }
    expect(results[10].error.code).toBe('RATE_LIMITED');
  }, 30_000);

  it('rate-limit buckets are per-endpoint, not shared: exhausting change-password does not affect the sessions-read limit for the same IP', async () => {
    const ip = '203.0.113.204';
    const { cookieHeader, csrfSecret } = await seedLoggedInCustomer('m3-ratelimit-isolation@example.com', 'the-real-password-1');

    for (let i = 0; i < 10; i++) {
      await SELF.fetch('https://example.com/api/customer/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret, 'CF-Connecting-IP': ip },
        body: JSON.stringify({ currentPassword: 'totally-wrong', newPassword: 'a-new-strong-password-2' }),
      });
    }
    const exhausted = await SELF.fetch('https://example.com/api/customer/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret, 'CF-Connecting-IP': ip },
      body: JSON.stringify({ currentPassword: 'totally-wrong', newPassword: 'a-new-strong-password-2' }),
    });
    expect((await exhausted.json<any>()).error.code).toBe('RATE_LIMITED');

    const stillFine = await SELF.fetch('https://example.com/api/customer/sessions', { headers: { Cookie: cookieHeader, 'CF-Connecting-IP': ip } });
    expect((await stillFine.json<any>()).success).toBe(true);
  }, 30_000);
});
