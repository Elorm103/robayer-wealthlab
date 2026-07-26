/**
 * Integration tests: Version 3.3 Milestone M5C (Activation, Analytics
 * and Customer Reconciliation) HTTP routes. Exercises
 * /api/customer/reconcile-purchases, /api/customer/auth/login's new
 * PASSWORD_NOT_SET code, /api/customer/auth/session's isFirstSession
 * field, /api/customer/review-reminders/opt-out, and
 * /api/admin/analytics/activation-summary through the real Worker
 * fetch handler.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession as createAdminSession } from '../../services/admin/sessionService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM email_log');
  await env.DB.exec('DELETE FROM customer_password_tokens');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await env.DB.exec('DELETE FROM admin_sessions');
  await env.DB.exec('DELETE FROM admin_users');
});

function extractCookie(res: Response, name: string): string | null {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  for (const raw of setCookies) {
    const match = raw.match(new RegExp(`${name}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

async function seedAdmin(): Promise<{ cookieHeader: string }> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', 'super_admin', 1)`)
    .bind(`m5c-admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  const adminId = Number(insert.meta.last_row_id);
  const session = await createAdminSession(env as any, adminId, { ip: null, userAgent: null });
  return { cookieHeader: `admin_session=${session.sessionToken}; admin_csrf=${session.csrfSecret}` };
}

describe('POST /api/customer/reconcile-purchases', () => {
  it('returns the identical generic response whether or not the email has an unclaimed purchase (no enumeration)', async () => {
    const withPurchase = await SELF.fetch('https://example.com/api/customer/reconcile-purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.10' },
      body: JSON.stringify({ email: 'no-purchase-http@example.com' }),
    });
    const withoutPurchase = await SELF.fetch('https://example.com/api/customer/reconcile-purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.11' },
      body: JSON.stringify({ email: 'also-no-purchase-http@example.com' }),
    });
    expect(await withPurchase.json()).toEqual(await withoutPurchase.json());
    expect((await SELF.fetch('https://example.com/api/customer/reconcile-purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.12' },
      body: JSON.stringify({}),
    }).then((r) => r.json<any>())).success).toBe(true);
  });

  it('actually links a real orphaned purchase end-to-end', async () => {
    await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_email, verified_at, expires_at)
       VALUES ('RWL-HTTP-0001', 'test-guide', 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', 'http-orphan@example.com', datetime('now'), datetime('now', '+30 minutes'))`
    ).run();

    const res = await SELF.fetch('https://example.com/api/customer/reconcile-purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.20' },
      body: JSON.stringify({ email: 'http-orphan@example.com' }),
    });
    expect((await res.json<any>()).success).toBe(true);

    const purchase = await env.DB.prepare('SELECT customer_id FROM purchase_sessions WHERE purchase_reference = ?')
      .bind('RWL-HTTP-0001')
      .first<{ customer_id: number | null }>();
    expect(purchase?.customer_id).not.toBeNull();
  });
});

describe('customer login/session — Version 3.3 M5C additions', () => {
  it('login against an account with no password set returns PASSWORD_NOT_SET, not INVALID_CREDENTIALS', async () => {
    await findOrCreateCustomer(env as any, 'http-no-password@example.com', false);

    const res = await SELF.fetch('https://example.com/api/customer/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.30' },
      body: JSON.stringify({ email: 'http-no-password@example.com', password: 'whatever' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PASSWORD_NOT_SET');
  });

  it('GET /api/customer/auth/session reports isFirstSession true on the first login, false on the second', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'http-first-session@example.com', false);
    const token = 'http-first-session-token'.padEnd(64, '7');
    await env.DB.prepare('INSERT INTO customer_password_tokens (token, customer_id, expires_at) VALUES (?, ?, ?)')
      .bind(token, customerId, new Date(Date.now() + 30 * 60_000).toISOString())
      .run();
    await SELF.fetch('https://example.com/api/customer/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword: 'correct-horse-battery-staple-1' }),
    });

    const firstLogin = await SELF.fetch('https://example.com/api/customer/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.40' },
      body: JSON.stringify({ email: 'http-first-session@example.com', password: 'correct-horse-battery-staple-1' }),
    });
    const firstCookie = `customer_session=${extractCookie(firstLogin, 'customer_session')}`;
    const firstSession = await SELF.fetch('https://example.com/api/customer/auth/session', { headers: { Cookie: firstCookie } });
    expect((await firstSession.json<any>()).data.isFirstSession).toBe(true);

    const secondLogin = await SELF.fetch('https://example.com/api/customer/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.41' },
      body: JSON.stringify({ email: 'http-first-session@example.com', password: 'correct-horse-battery-staple-1' }),
    });
    const secondCookie = `customer_session=${extractCookie(secondLogin, 'customer_session')}`;
    const secondSession = await SELF.fetch('https://example.com/api/customer/auth/session', { headers: { Cookie: secondCookie } });
    expect((await secondSession.json<any>()).data.isFirstSession).toBe(false);
  });
});

describe('GET /api/customer/review-reminders/opt-out', () => {
  it('opts a customer out via their token and returns a confirmation page', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'http-opt-out@example.com', false);
    await env.DB.prepare('UPDATE customer_profiles SET review_reminder_opt_out_token = ? WHERE customer_id = ?')
      .bind('b'.repeat(64), customerId)
      .run();

    const res = await SELF.fetch('https://example.com/api/customer/review-reminders/opt-out?token=' + 'b'.repeat(64));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');

    const profile = await env.DB.prepare('SELECT review_reminder_opt_out AS optOut FROM customer_profiles WHERE customer_id = ?')
      .bind(customerId)
      .first<{ optOut: number }>();
    expect(profile?.optOut).toBe(1);
  });

  it('an invalid token still returns 200 with the same generic confirmation (no error state to enumerate)', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/review-reminders/opt-out?token=not-a-real-token');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/admin/analytics/activation-summary', () => {
  it('requires authentication', async () => {
    const res = await SELF.fetch('https://example.com/api/admin/analytics/activation-summary');
    expect(res.status).toBe(401);
  });

  it('returns the new activation metrics for an authenticated admin', async () => {
    const { cookieHeader } = await seedAdmin();
    const res = await SELF.fetch('https://example.com/api/admin/analytics/activation-summary', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('checkoutStarts');
    expect(body.data).toHaveProperty('purchasesReconciled');
    expect(body.data).toHaveProperty('checkoutCompletionRate');
  });
});
