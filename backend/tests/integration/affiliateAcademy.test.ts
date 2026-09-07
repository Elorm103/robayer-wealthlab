/**
 * Integration tests: Affiliate Academy start/progress/completion —
 * Affiliate Programme 2.0. Real Worker fetch handler, real D1. Same
 * seedCustomer()/CSRF conventions as affiliateApplication.test.ts.
 *
 * Deliberately does NOT test "completing the Academy approves the
 * application" — that's not how it works, by explicit design: see
 * affiliateService.ts's completeAcademy() header comment. Completion
 * only ever changes affiliates.academy_status/academy_completed_at,
 * never affiliates.status.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession as createCustomerSession } from '../../services/customer/sessionService';
import { CURRENT_AFFILIATE_ACADEMY_VERSION } from '../../services/affiliateService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM affiliate_commissions');
  await env.DB.exec('DELETE FROM affiliate_clicks');
  await env.DB.exec('DELETE FROM affiliates');
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM email_log');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  // The 'customer-affiliate-write' rate-limit bucket (routes/customer/affiliates.ts's
  // WRITE_RATE_LIMIT, limit 10/60s) is shared by /apply, /academy/start, and
  // /academy/complete alike, and RATE_LIMIT_KV persists across tests within
  // this file (unlike D1, which the deletes above reset) — without this,
  // later tests in this file accumulate quota from earlier ones and start
  // failing with RATE_LIMITED instead of their real expected outcome.
  await env.RATE_LIMIT_KV.delete('ratelimit:customer-affiliate-write:unknown');
  await env.RATE_LIMIT_KV.delete('ratelimit:customer-affiliate-read:unknown');
});

async function seedCustomer(email: string): Promise<{ customerId: number; cookieHeader: string; csrfSecret: string }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });
  return { customerId, cookieHeader: `customer_session=${session.sessionToken}`, csrfSecret: session.csrfSecret };
}

async function applyAsAffiliate(email: string): Promise<{ customerId: number; cookieHeader: string; csrfSecret: string }> {
  const customer = await seedCustomer(email);
  await SELF.fetch('https://example.com/api/customer/affiliates/apply', {
    method: 'POST',
    headers: { Cookie: customer.cookieHeader, 'X-Customer-CSRF-Token': customer.csrfSecret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ termsAccepted: true }),
  });
  return customer;
}

function authHeaders(customer: { cookieHeader: string; csrfSecret: string }) {
  return { Cookie: customer.cookieHeader, 'X-Customer-CSRF-Token': customer.csrfSecret, 'Content-Type': 'application/json' };
}

describe('POST /api/customer/affiliates/academy/start', () => {
  it('a customer who has applied can start the Academy: status becomes in_progress with a started_at timestamp', async () => {
    const customer = await applyAsAffiliate('academy-start@example.com');

    const res = await SELF.fetch('https://example.com/api/customer/affiliates/academy/start', { method: 'POST', headers: authHeaders(customer) });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('in_progress');

    const row = await env.DB.prepare(`SELECT academy_status AS status, academy_started_at AS startedAt FROM affiliates WHERE customer_id = ?`).bind(customer.customerId).first<any>();
    expect(row.status).toBe('in_progress');
    expect(row.startedAt).toBeTruthy();
  });

  it('is idempotent: starting twice does not reset an already in_progress or completed status', async () => {
    const customer = await applyAsAffiliate('academy-idempotent@example.com');
    await SELF.fetch('https://example.com/api/customer/affiliates/academy/start', { method: 'POST', headers: authHeaders(customer) });

    const firstStarted = await env.DB.prepare(`SELECT academy_started_at AS startedAt FROM affiliates WHERE customer_id = ?`).bind(customer.customerId).first<any>();

    const second = await SELF.fetch('https://example.com/api/customer/affiliates/academy/start', { method: 'POST', headers: authHeaders(customer) });
    expect((await second.json<any>()).data.status).toBe('in_progress');

    const secondStarted = await env.DB.prepare(`SELECT academy_started_at AS startedAt FROM affiliates WHERE customer_id = ?`).bind(customer.customerId).first<any>();
    expect(secondStarted.startedAt).toBe(firstStarted.startedAt);
  });

  it('a customer who has NOT applied yet cannot start the Academy (NOT_APPLIED)', async () => {
    const customer = await seedCustomer('academy-not-applied@example.com');
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/academy/start', { method: 'POST', headers: authHeaders(customer) });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_APPLIED');
  });

  it('an unauthenticated visitor cannot start the Academy', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/academy/start', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_AUTHENTICATED');
  });
});

describe('POST /api/customer/affiliates/academy/complete', () => {
  it('records completion with a timestamp and version, without changing affiliates.status', async () => {
    const customer = await applyAsAffiliate('academy-complete@example.com');
    await SELF.fetch('https://example.com/api/customer/affiliates/academy/start', { method: 'POST', headers: authHeaders(customer) });

    const res = await SELF.fetch('https://example.com/api/customer/affiliates/academy/complete', { method: 'POST', headers: authHeaders(customer) });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('completed');

    const row = await env.DB.prepare(
      `SELECT status, academy_status AS academyStatus, academy_completed_at AS completedAt, academy_version AS academyVersion FROM affiliates WHERE customer_id = ?`
    )
      .bind(customer.customerId)
      .first<any>();
    expect(row.academyStatus).toBe('completed');
    expect(row.completedAt).toBeTruthy();
    expect(row.academyVersion).toBe(CURRENT_AFFILIATE_ACADEMY_VERSION);
    // The critical guarantee: completing the Academy never auto-approves the application.
    expect(row.status).toBe('pending');
  });

  it('is visible via GET /api/customer/affiliates/academy and GET /api/customer/affiliates/me', async () => {
    const customer = await applyAsAffiliate('academy-visible@example.com');
    await SELF.fetch('https://example.com/api/customer/affiliates/academy/start', { method: 'POST', headers: authHeaders(customer) });
    await SELF.fetch('https://example.com/api/customer/affiliates/academy/complete', { method: 'POST', headers: authHeaders(customer) });

    const academyRes = await SELF.fetch('https://example.com/api/customer/affiliates/academy', { headers: { Cookie: customer.cookieHeader } });
    const academyBody = await academyRes.json<any>();
    expect(academyBody.data.status).toBe('completed');
    expect(academyBody.data.currentVersion).toBe(CURRENT_AFFILIATE_ACADEMY_VERSION);

    const meRes = await SELF.fetch('https://example.com/api/customer/affiliates/me', { headers: { Cookie: customer.cookieHeader } });
    const meBody = await meRes.json<any>();
    expect(meBody.data.academyStatus).toBe('completed');
  });

  it('is visible to admins on the affiliate list and detail endpoints', async () => {
    const customer = await applyAsAffiliate('academy-admin-visible@example.com');
    await SELF.fetch('https://example.com/api/customer/affiliates/academy/start', { method: 'POST', headers: authHeaders(customer) });
    await SELF.fetch('https://example.com/api/customer/affiliates/academy/complete', { method: 'POST', headers: authHeaders(customer) });

    const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES ('academy-admin@example.com', 'x:1:x', 'super_admin', 1)`).run();
    const adminId = Number(insert.meta.last_row_id);
    const { createSession: createAdminSession } = await import('../../services/admin/sessionService');
    const adminSession = await createAdminSession(env as any, adminId, { ip: null, userAgent: null });
    const adminCookie = `admin_session=${adminSession.sessionToken}`;

    const listRes = await SELF.fetch('https://example.com/api/admin/affiliates', { headers: { Cookie: adminCookie } });
    const listBody = await listRes.json<any>();
    const item = listBody.data.items.find((i: any) => i.customerEmail === 'academy-admin-visible@example.com');
    expect(item).toBeTruthy();
    expect(item.academyStatus).toBe('completed');

    const detailRes = await SELF.fetch(`https://example.com/api/admin/affiliates/${item.id}`, { headers: { Cookie: adminCookie } });
    const detailBody = await detailRes.json<any>();
    expect(detailBody.data.academyStatus).toBe('completed');
    expect(detailBody.data.academyCompletedAt).toBeTruthy();
  });

  it('a customer who has NOT applied yet cannot complete the Academy (NOT_APPLIED)', async () => {
    const customer = await seedCustomer('academy-complete-not-applied@example.com');
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/academy/complete', { method: 'POST', headers: authHeaders(customer) });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_APPLIED');
  });
});
