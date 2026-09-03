/**
 * Integration tests: affiliate authorization boundaries. An
 * unapproved affiliate cannot use approved-only routes, one affiliate
 * cannot see another's data, a normal customer cannot reach admin
 * routes, and admin write actions require CSRF + role.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession as createCustomerSession } from '../../services/customer/sessionService';
import { createSession as createAdminSession } from '../../services/admin/sessionService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM affiliate_commissions');
  await env.DB.exec('DELETE FROM affiliate_clicks');
  await env.DB.exec('DELETE FROM affiliates');
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

async function seedAffiliate(email: string, code: string, status: 'pending' | 'approved' = 'approved'): Promise<{ affiliateId: number; cookieHeader: string; csrfSecret: string }> {
  const customer = await seedCustomer(email);
  const insert = await env.DB.prepare(`INSERT INTO affiliates (customer_id, affiliate_code, status, default_commission_percent, data_classification) VALUES (?, ?, ?, 20, 'PRODUCTION')`)
    .bind(customer.customerId, code, status)
    .run();
  return { affiliateId: Number(insert.meta.last_row_id), cookieHeader: customer.cookieHeader, csrfSecret: customer.csrfSecret };
}

async function seedAdmin(role: 'super_admin' | 'editor' | 'support' = 'super_admin'): Promise<{ cookieHeader: string; csrfSecret: string; adminId: number }> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', ?, 1)`)
    .bind(`admin-${role}-${Math.random().toString(36).slice(2)}@example.com`, role)
    .run();
  const adminId = Number(insert.meta.last_row_id);
  const session = await createAdminSession(env as any, adminId, { ip: null, userAgent: null });
  return { cookieHeader: `admin_session=${session.sessionToken}; admin_csrf=${session.csrfSecret}`, csrfSecret: session.csrfSecret, adminId };
}

describe('Affiliate route authorization', () => {
  it('an unapproved (pending) affiliate is blocked from approved-only routes like overview', async () => {
    const { cookieHeader } = await seedAffiliate('pending-blocked@example.com', 'RWLPENDBLOCK', 'pending');
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/overview', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('AFFILIATE_NOT_APPROVED');
  });

  it('a suspended affiliate is blocked from approved-only routes with a distinct error code', async () => {
    const { affiliateId, cookieHeader } = await seedAffiliate('suspended-blocked@example.com', 'RWLSUSPBLOCK', 'approved');
    await env.DB.prepare(`UPDATE affiliates SET status = 'suspended' WHERE id = ?`).bind(affiliateId).run();

    const res = await SELF.fetch('https://example.com/api/customer/affiliates/overview', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('AFFILIATE_SUSPENDED');
  });

  it("an affiliate's commission history never includes another affiliate's rows", async () => {
    const a1 = await seedAffiliate('affiliate-one@example.com', 'RWLAFFONE');
    const a2 = await seedAffiliate('affiliate-two@example.com', 'RWLAFFTWO');

    // Seed a commission for affiliate two only.
    const insertProduct = await env.DB.prepare(
      `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
       VALUES ('prod-x', 'product-x', 'Product X', 'investing', 'ebook', 'active', 3900, 'GHS', 'one-time', 'inclusive', 'en')`
    ).run();
    const productId = Number(insertProduct.meta.last_row_id);
    const sessionInsert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at)
       VALUES ('RWL-TEST-000001', 'product-x', 'prod-x', 'Product X', 3900, 'GHS', 'verified', datetime('now', '+1 hour'))`
    ).run();
    await env.DB.prepare(`INSERT INTO affiliate_commissions (affiliate_id, purchase_session_id, product_id, gross_pesewas, commission_percent, commission_pesewas, status, data_classification) VALUES (?, ?, ?, 3900, 20, 780, 'pending', 'PRODUCTION')`)
      .bind(a2.affiliateId, Number(sessionInsert.meta.last_row_id), productId)
      .run();

    const res = await SELF.fetch('https://example.com/api/customer/affiliates/commissions', { headers: { Cookie: a1.cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.items.length).toBe(0); // affiliate one sees none of affiliate two's commissions
  });

  it('a normal customer with no affiliate record cannot reach approved-only affiliate routes', async () => {
    const { cookieHeader } = await seedCustomer('never-an-affiliate@example.com');
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/overview', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('AFFILIATE_NOT_FOUND');
  });

  it('an unauthenticated request to any affiliate customer route is rejected', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/overview');
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_AUTHENTICATED');
  });
});

describe('Admin affiliate route authorization', () => {
  it('a normal customer session cannot access any /api/admin/affiliates/* route', async () => {
    const { cookieHeader } = await seedCustomer('customer-tries-admin@example.com');
    const res = await SELF.fetch('https://example.com/api/admin/affiliates', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_AUTHENTICATED');
  });

  it('reads are open to every authenticated admin role (support included)', async () => {
    const { cookieHeader } = await seedAdmin('support');
    const res = await SELF.fetch('https://example.com/api/admin/affiliates', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
  });

  it('a write request without the CSRF header is rejected even with a valid admin session', async () => {
    const { affiliateId } = await seedAffiliate('csrf-test-target@example.com', 'RWLCSRFTEST', 'pending');
    const admin = await seedAdmin('super_admin');

    const res = await SELF.fetch(`https://example.com/api/admin/affiliates/${affiliateId}/moderate`, {
      method: 'POST',
      headers: { Cookie: admin.cookieHeader, 'Content-Type': 'application/json' }, // no X-CSRF-Token
      body: JSON.stringify({ status: 'approved' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('a manipulated affiliate id in the URL that does not exist returns AFFILIATE_NOT_FOUND, not a server error', async () => {
    const admin = await seedAdmin('super_admin');
    const res = await SELF.fetch('https://example.com/api/admin/affiliates/999999999', { headers: { Cookie: admin.cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('AFFILIATE_NOT_FOUND');
  });
});
