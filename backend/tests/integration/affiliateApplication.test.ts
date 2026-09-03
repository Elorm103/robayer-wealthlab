/**
 * Integration tests: affiliate application/approval lifecycle. Real
 * Worker fetch handler, real D1; same conventions as
 * adminCoupons.test.ts (admin session helper) and
 * customerPurchases.test.ts (customer session helper).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession as createCustomerSession } from '../../services/customer/sessionService';
import { createSession as createAdminSession } from '../../services/admin/sessionService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM affiliate_commissions');
  await env.DB.exec('DELETE FROM affiliate_clicks');
  await env.DB.exec('DELETE FROM affiliate_product_rates');
  await env.DB.exec('DELETE FROM affiliate_payouts');
  await env.DB.exec('DELETE FROM affiliates');
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM email_log');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await env.DB.exec('DELETE FROM admin_sessions');
  await env.DB.exec('DELETE FROM admin_users');
});

async function seedCustomer(email: string): Promise<{ customerId: number; cookieHeader: string; csrfSecret: string }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });
  return { customerId, cookieHeader: `customer_session=${session.sessionToken}`, csrfSecret: session.csrfSecret };
}

async function seedAdmin(role: 'super_admin' | 'editor' | 'support' = 'super_admin'): Promise<{ cookieHeader: string; csrfSecret: string; adminId: number }> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', ?, 1)`)
    .bind(`admin-${role}-${Math.random().toString(36).slice(2)}@example.com`, role)
    .run();
  const adminId = Number(insert.meta.last_row_id);
  const session = await createAdminSession(env as any, adminId, { ip: null, userAgent: null });
  return { cookieHeader: `admin_session=${session.sessionToken}; admin_csrf=${session.csrfSecret}`, csrfSecret: session.csrfSecret, adminId };
}

describe('POST /api/customer/affiliates/apply', () => {
  it('a logged-in customer can apply and lands in pending status', async () => {
    const { cookieHeader, csrfSecret } = await seedCustomer('applicant@example.com');

    const res = await SELF.fetch('https://example.com/api/customer/affiliates/apply', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ termsAccepted: true }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('pending');

    const row = await env.DB.prepare(`SELECT status, affiliate_code AS code FROM affiliates WHERE customer_id = (SELECT id FROM customers WHERE email = 'applicant@example.com')`).first<any>();
    expect(row.status).toBe('pending');
    expect(row.code).toMatch(/^RWL/);
  });

  it('sends an application-received confirmation email', async () => {
    const { cookieHeader, csrfSecret } = await seedCustomer('confirmation@example.com');

    await SELF.fetch('https://example.com/api/customer/affiliates/apply', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ termsAccepted: true }),
    });

    const row = await env.DB.prepare(`SELECT template, recipient FROM email_log WHERE recipient = 'confirmation@example.com' ORDER BY id DESC LIMIT 1`).first<any>();
    expect(row).toBeTruthy();
    expect(row.template).toBe('affiliate-application-received');
  });

  it('rejects an application without terms acceptance', async () => {
    const { cookieHeader, csrfSecret } = await seedCustomer('noterms@example.com');
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/apply', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ termsAccepted: false }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CONSENT_REQUIRED');
  });

  it('rejects an unauthenticated application attempt', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ termsAccepted: true }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_AUTHENTICATED');
  });

  it('rejects a duplicate application while one is already pending', async () => {
    const { cookieHeader, csrfSecret } = await seedCustomer('dupe@example.com');
    const apply = () =>
      SELF.fetch('https://example.com/api/customer/affiliates/apply', {
        method: 'POST',
        headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
        body: JSON.stringify({ termsAccepted: true }),
      });
    await apply();
    const second = await apply();
    const body = await second.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('ALREADY_AFFILIATE');
  });
});

describe('GET /api/customer/affiliates/me', () => {
  it('returns AFFILIATE_NOT_FOUND for a customer who never applied', async () => {
    const { cookieHeader } = await seedCustomer('never-applied@example.com');
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/me', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('AFFILIATE_NOT_FOUND');
  });
});

describe('Admin affiliate moderation', () => {
  async function applyAsCustomer(email: string) {
    const customer = await seedCustomer(email);
    await SELF.fetch('https://example.com/api/customer/affiliates/apply', {
      method: 'POST',
      headers: { Cookie: customer.cookieHeader, 'X-Customer-CSRF-Token': customer.csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ termsAccepted: true }),
    });
    const row = await env.DB.prepare(`SELECT id FROM affiliates WHERE customer_id = ?`).bind(customer.customerId).first<{ id: number }>();
    return { ...customer, affiliateId: row!.id };
  }

  it('an editor can approve a pending application, and it becomes visible/usable to the affiliate', async () => {
    const { affiliateId, cookieHeader: customerCookie } = await applyAsCustomer('to-approve@example.com');
    const admin = await seedAdmin('editor');

    const res = await SELF.fetch(`https://example.com/api/admin/affiliates/${affiliateId}/moderate`, {
      method: 'POST',
      headers: { Cookie: admin.cookieHeader, 'X-CSRF-Token': admin.csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    expect((await res.json<any>()).success).toBe(true);

    const meRes = await SELF.fetch('https://example.com/api/customer/affiliates/me', { headers: { Cookie: customerCookie } });
    const meBody = await meRes.json<any>();
    expect(meBody.data.status).toBe('approved');
    expect(meBody.data.affiliateCode).toBeTruthy();

    // This affiliate also has an earlier 'affiliate.applied' audit row from
    // applyAsCustomer() above; order by id descending to get the most
    // recent entry (the approval), not an unspecified one of the two.
    const audit = await env.DB.prepare(`SELECT action FROM audit_logs WHERE entity_type = 'affiliate' AND entity_id = ? ORDER BY id DESC LIMIT 1`).bind(affiliateId).first<any>();
    expect(audit.action).toBe('affiliate.approved');
  });

  it('rejecting an application records the reason and is visible to the applicant', async () => {
    const { affiliateId, cookieHeader: customerCookie } = await applyAsCustomer('to-reject@example.com');
    const admin = await seedAdmin('editor');

    await SELF.fetch(`https://example.com/api/admin/affiliates/${affiliateId}/moderate`, {
      method: 'POST',
      headers: { Cookie: admin.cookieHeader, 'X-CSRF-Token': admin.csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected', rejectionReason: 'Incomplete profile.' }),
    });

    const meRes = await SELF.fetch('https://example.com/api/customer/affiliates/me', { headers: { Cookie: customerCookie } });
    const meBody = await meRes.json<any>();
    expect(meBody.data.status).toBe('rejected');
    expect(meBody.data.rejectionReason).toBe('Incomplete profile.');
  });

  it('a support-role admin cannot moderate applications (write action requires editor/super_admin)', async () => {
    const { affiliateId } = await applyAsCustomer('support-blocked@example.com');
    const admin = await seedAdmin('support');

    const res = await SELF.fetch(`https://example.com/api/admin/affiliates/${affiliateId}/moderate`, {
      method: 'POST',
      headers: { Cookie: admin.cookieHeader, 'X-CSRF-Token': admin.csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('cannot moderate the same application twice (status-gated transition)', async () => {
    const { affiliateId } = await applyAsCustomer('double-moderate@example.com');
    const admin = await seedAdmin('super_admin');

    await SELF.fetch(`https://example.com/api/admin/affiliates/${affiliateId}/moderate`, {
      method: 'POST',
      headers: { Cookie: admin.cookieHeader, 'X-CSRF-Token': admin.csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    const second = await SELF.fetch(`https://example.com/api/admin/affiliates/${affiliateId}/moderate`, {
      method: 'POST',
      headers: { Cookie: admin.cookieHeader, 'X-CSRF-Token': admin.csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected' }),
    });
    const body = await second.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('suspend then reactivate round-trips correctly and is audited', async () => {
    const { affiliateId } = await applyAsCustomer('suspend-reactivate@example.com');
    const admin = await seedAdmin('super_admin');
    await SELF.fetch(`https://example.com/api/admin/affiliates/${affiliateId}/moderate`, {
      method: 'POST',
      headers: { Cookie: admin.cookieHeader, 'X-CSRF-Token': admin.csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });

    const suspendRes = await SELF.fetch(`https://example.com/api/admin/affiliates/${affiliateId}/suspend`, {
      method: 'POST',
      headers: { Cookie: admin.cookieHeader, 'X-CSRF-Token': admin.csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Suspicious activity' }),
    });
    expect((await suspendRes.json<any>()).success).toBe(true);

    let row = await env.DB.prepare(`SELECT status FROM affiliates WHERE id = ?`).bind(affiliateId).first<any>();
    expect(row.status).toBe('suspended');

    const reactivateRes = await SELF.fetch(`https://example.com/api/admin/affiliates/${affiliateId}/reactivate`, {
      method: 'POST',
      headers: { Cookie: admin.cookieHeader, 'X-CSRF-Token': admin.csrfSecret },
    });
    expect((await reactivateRes.json<any>()).success).toBe(true);

    row = await env.DB.prepare(`SELECT status FROM affiliates WHERE id = ?`).bind(affiliateId).first<any>();
    expect(row.status).toBe('approved');

    const auditCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'affiliate' AND action IN ('affiliate.suspended', 'affiliate.reactivated')`).first<any>();
    expect(auditCount.n).toBe(2);
  });
});
