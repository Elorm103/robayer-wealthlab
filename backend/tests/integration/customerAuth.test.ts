/**
 * Integration tests: customer auth HTTP routes — Version 3.0.2
 * Milestone M1. Exercises /api/customer/auth/* through the real Worker
 * fetch handler, including cookie-based session issuance and CSRF
 * enforcement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';

beforeEach(async () => {
  // Every test in this file may trigger a real email send attempt
  // (set-password/forgot-password both call sendEmail) — intercepted
  // by tests/outboundMock.ts's default handler (200 for every send),
  // so no real network call to Resend is ever made. sendEmail() never
  // throws on a failed send regardless (see services/emailService.ts).
  await env.DB.exec('DELETE FROM customer_password_tokens');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
});

function extractCookie(res: Response, name: string): string | null {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  for (const raw of setCookies) {
    const match = raw.match(new RegExp(`${name}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

describe('customer auth HTTP routes', () => {
  it('GET /api/customer/auth/session with no cookie returns NOT_AUTHENTICATED', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/auth/session');
    expect(res.status).toBe(401);
    const body = await res.json<any>();
    expect(body.error.code).toBe('NOT_AUTHENTICATED');
  });

  it('full cycle: set-password -> login -> session -> logout (with CSRF) -> session fails again', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'http-cycle@example.com', false);
    const token = 'http-cycle-token'.padEnd(64, '9');
    await env.DB.prepare('INSERT INTO customer_password_tokens (token, customer_id, expires_at) VALUES (?, ?, ?)')
      .bind(token, customerId, new Date(Date.now() + 30 * 60_000).toISOString())
      .run();

    const setRes = await SELF.fetch('https://example.com/api/customer/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword: 'correct-horse-battery-staple-1' }),
    });
    expect((await setRes.json<any>()).success).toBe(true);

    const loginRes = await SELF.fetch('https://example.com/api/customer/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'http-cycle@example.com', password: 'correct-horse-battery-staple-1' }),
    });
    expect((await loginRes.json<any>()).success).toBe(true);

    const sessionCookie = extractCookie(loginRes, 'customer_session');
    const csrfCookie = extractCookie(loginRes, 'customer_csrf');
    expect(sessionCookie).toBeTruthy();
    expect(csrfCookie).toBeTruthy();

    const cookieHeader = `customer_session=${sessionCookie}; customer_csrf=${csrfCookie}`;

    const sessionRes = await SELF.fetch('https://example.com/api/customer/auth/session', { headers: { Cookie: cookieHeader } });
    const sessionBody = await sessionRes.json<any>();
    expect(sessionBody.success).toBe(true);
    expect(sessionBody.data.email).toBe('http-cycle@example.com');

    // Logout without the CSRF header must fail.
    const logoutNoCsrf = await SELF.fetch('https://example.com/api/customer/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookieHeader },
    });
    expect((await logoutNoCsrf.json<any>()).error.code).toBe('FORBIDDEN');

    // Logout with the CSRF header succeeds.
    const logoutRes = await SELF.fetch('https://example.com/api/customer/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfCookie! },
    });
    expect((await logoutRes.json<any>()).success).toBe(true);

    const sessionAfterLogout = await SELF.fetch('https://example.com/api/customer/auth/session', { headers: { Cookie: cookieHeader } });
    expect(sessionAfterLogout.status).toBe(401);
  });

  it('forgot-password returns the identical generic response whether or not the email exists (no enumeration)', async () => {
    await findOrCreateCustomer(env as any, 'real-account@example.com', false);

    const realRes = await SELF.fetch('https://example.com/api/customer/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'real-account@example.com' }),
    });
    const fakeRes = await SELF.fetch('https://example.com/api/customer/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'no-such-account@example.com' }),
    });

    expect(await realRes.json()).toEqual(await fakeRes.json());
  });
});
