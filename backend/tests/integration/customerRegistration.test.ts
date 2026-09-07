/**
 * Integration tests: free account registration + email verification —
 * Affiliate Programme 2.0. Exercises /api/customer/auth/register and
 * /api/customer/auth/verify-email through the real Worker fetch
 * handler, same conventions as customerAuth.test.ts (cookie extraction,
 * outbound email intercepted by tests/outboundMock.ts's default 200
 * handler — no real network call to Resend is ever made).
 *
 * This is a deliberate, additive EXCEPTION to ADR-006 ("no public
 * registration endpoint") — see services/customer/authService.ts's
 * registerCustomer() header comment. The purchase-triggered
 * find-or-create path (identityService.ts) is untouched and has its
 * own existing test coverage; these tests cover only the new path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM customer_email_verification_tokens');
  await env.DB.exec('DELETE FROM customer_password_tokens');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await env.DB.exec('DELETE FROM email_log');
  await env.RATE_LIMIT_KV.delete('ratelimit:customer-register:unknown');
});

function extractCookie(res: Response, name: string): string | null {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  for (const raw of setCookies) {
    const match = raw.match(new RegExp(`${name}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

const VALID_BODY = {
  name: 'Ama Serwaa',
  email: 'ama-register@example.com',
  password: 'correct-horse-battery-staple-1',
  passwordConfirmation: 'correct-horse-battery-staple-1',
  termsAccepted: true,
};

async function register(body: Record<string, unknown>): Promise<{ res: Response; body: any }> {
  const res = await SELF.fetch('https://example.com/api/customer/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json<any>() };
}

describe('POST /api/customer/auth/register', () => {
  it('creates a free account, no purchase required, and signs it in immediately', async () => {
    const { res, body } = await register(VALID_BODY);
    expect(body.success).toBe(true);
    expect(body.data.email).toBe(VALID_BODY.email);

    const row = await env.DB.prepare(`SELECT status, password_hash AS passwordHash FROM customers WHERE email = ?`).bind(VALID_BODY.email).first<any>();
    expect(row).toBeTruthy();
    expect(row.passwordHash).toBeTruthy();

    const sessionCookie = extractCookie(res, 'customer_session');
    const csrfCookie = extractCookie(res, 'customer_csrf');
    expect(sessionCookie).toBeTruthy();
    expect(csrfCookie).toBeTruthy();
  });

  it('auth-after-registration: the session cookie issued at registration authenticates GET /api/customer/auth/session', async () => {
    const { res } = await register({ ...VALID_BODY, email: 'auth-after-register@example.com' });
    const cookieHeader = `customer_session=${extractCookie(res, 'customer_session')}; customer_csrf=${extractCookie(res, 'customer_csrf')}`;

    const sessionRes = await SELF.fetch('https://example.com/api/customer/auth/session', { headers: { Cookie: cookieHeader } });
    const sessionBody = await sessionRes.json<any>();
    expect(sessionBody.success).toBe(true);
    expect(sessionBody.data.email).toBe('auth-after-register@example.com');
  });

  it('sends a verification email and logs it in email_log', async () => {
    await register({ ...VALID_BODY, email: 'verify-email-log@example.com' });
    const row = await env.DB.prepare(`SELECT template, recipient, status FROM email_log WHERE recipient = 'verify-email-log@example.com' ORDER BY id DESC LIMIT 1`).first<any>();
    expect(row).toBeTruthy();
    expect(row.template).toBe('customer-email-verification');
  });

  it('rejects a duplicate email with DUPLICATE_EMAIL, without creating a second row', async () => {
    await register({ ...VALID_BODY, email: 'dupe-register@example.com' });
    const { body } = await register({ ...VALID_BODY, email: 'dupe-register@example.com' });
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('DUPLICATE_EMAIL');

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM customers WHERE email = 'dupe-register@example.com'`).first<any>();
    expect(count.n).toBe(1);
  });

  it('rejects a mismatched password confirmation', async () => {
    const { body } = await register({ ...VALID_BODY, email: 'mismatch@example.com', passwordConfirmation: 'something-else-entirely' });
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a password that fails the strength policy', async () => {
    const { body } = await register({ ...VALID_BODY, email: 'weak-password@example.com', password: 'short', passwordConfirmation: 'short' });
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects registration without terms acceptance', async () => {
    const { body } = await register({ ...VALID_BODY, email: 'no-terms@example.com', termsAccepted: false });
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid email address', async () => {
    const { body } = await register({ ...VALID_BODY, email: 'not-an-email' });
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('never touches the purchase-triggered customer path: a registered account has no purchase_sessions row', async () => {
    await register({ ...VALID_BODY, email: 'no-purchase-required@example.com' });
    const purchaseCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM purchase_sessions WHERE customer_email = 'no-purchase-required@example.com'`
    ).first<any>();
    expect(purchaseCount.n).toBe(0);
  });
});

describe('GET /api/customer/auth/verify-email', () => {
  it('a valid token verifies the account', async () => {
    await register({ ...VALID_BODY, email: 'verify-success@example.com' });
    const tokenRow = await env.DB.prepare(
      `SELECT token FROM customer_email_verification_tokens WHERE customer_id = (SELECT id FROM customers WHERE email = 'verify-success@example.com')`
    ).first<any>();
    expect(tokenRow).toBeTruthy();

    const res = await SELF.fetch(`https://example.com/api/customer/auth/verify-email?token=${tokenRow.token}`);
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const customer = await env.DB.prepare(`SELECT email_verified_at AS verifiedAt FROM customers WHERE email = 'verify-success@example.com'`).first<any>();
    expect(customer.verifiedAt).toBeTruthy();
  });

  it('an invalid token is rejected with INVALID_TOKEN', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/auth/verify-email?token=not-a-real-token');
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_TOKEN');
  });

  it('a token cannot be redeemed twice', async () => {
    await register({ ...VALID_BODY, email: 'verify-once@example.com' });
    const tokenRow = await env.DB.prepare(
      `SELECT token FROM customer_email_verification_tokens WHERE customer_id = (SELECT id FROM customers WHERE email = 'verify-once@example.com')`
    ).first<any>();

    const first = await SELF.fetch(`https://example.com/api/customer/auth/verify-email?token=${tokenRow.token}`);
    expect((await first.json<any>()).success).toBe(true);

    const second = await SELF.fetch(`https://example.com/api/customer/auth/verify-email?token=${tokenRow.token}`);
    const secondBody = await second.json<any>();
    expect(secondBody.success).toBe(false);
    expect(secondBody.error.code).toBe('INVALID_TOKEN');
  });

  it('the account is fully usable before verification completes (verification is not a login gate)', async () => {
    const { res } = await register({ ...VALID_BODY, email: 'unverified-still-usable@example.com' });
    const cookieHeader = `customer_session=${extractCookie(res, 'customer_session')}; customer_csrf=${extractCookie(res, 'customer_csrf')}`;

    const sessionRes = await SELF.fetch('https://example.com/api/customer/auth/session', { headers: { Cookie: cookieHeader } });
    expect((await sessionRes.json<any>()).success).toBe(true);

    const customer = await env.DB.prepare(`SELECT email_verified_at AS verifiedAt FROM customers WHERE email = 'unverified-still-usable@example.com'`).first<any>();
    expect(customer.verifiedAt).toBeNull();
  });
});
