/**
 * Integration tests: admin coupon management — Version 3.2 Milestone
 * M4 (Reviews & Coupons). Exercises GET/POST /api/admin/coupons and
 * PATCH /api/admin/coupons/:id through the real Worker fetch handler —
 * role gating (viewing open to all roles, mutation editor-only) and
 * CSRF are the central concerns, matching adminRefund.test.ts's
 * established pattern for this codebase.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createSession as createAdminSession } from '../../services/admin/sessionService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM coupon_redemptions');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM coupons');
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM admin_sessions');
  await env.DB.exec('DELETE FROM admin_users');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

async function seedAdmin(role: 'super_admin' | 'editor' | 'support' = 'super_admin'): Promise<{ cookieHeader: string; csrfSecret: string; adminId: number }> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', ?, 1)`)
    .bind(`admin-${role}-${Math.random().toString(36).slice(2)}@example.com`, role)
    .run();
  const adminId = Number(insert.meta.last_row_id);
  const session = await createAdminSession(env as any, adminId, { ip: null, userAgent: null });
  return { cookieHeader: `admin_session=${session.sessionToken}; admin_csrf=${session.csrfSecret}`, csrfSecret: session.csrfSecret, adminId };
}

describe('POST /api/admin/coupons', () => {
  it('creates a platform-wide coupon as super_admin with CSRF, and writes an audit log entry', async () => {
    const { cookieHeader, csrfSecret, adminId } = await seedAdmin('super_admin');

    const res = await SELF.fetch('https://example.com/api/admin/coupons', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'launch20', productSlug: null, discountType: 'percentage', discountValue: 20, maxRedemptions: 100, firstPurchaseOnly: false, startsAt: null, expiresAt: null }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const row = await env.DB.prepare('SELECT code, status FROM coupons WHERE id = ?').bind(body.data.id).first<any>();
    expect(row.code).toBe('LAUNCH20');
    expect(row.status).toBe('active');

    const audit = await env.DB.prepare(`SELECT actor_id AS actorId FROM audit_logs WHERE action = 'coupon.created'`).first<any>();
    expect(audit.actorId).toBe(adminId);
  });

  it('creates a product-scoped coupon by resolving productSlug', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');

    const res = await SELF.fetch('https://example.com/api/admin/coupons', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'SCOPEDTEST', productSlug: TEST_PRODUCT_SLUG, discountType: 'fixed', discountValue: 500, maxRedemptions: null, firstPurchaseOnly: false, startsAt: null, expiresAt: null }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const listRes = await SELF.fetch('https://example.com/api/admin/coupons', { headers: { Cookie: cookieHeader } });
    const listBody = await listRes.json<any>();
    const created = listBody.data.items.find((c: any) => c.code === 'SCOPEDTEST');
    expect(created.productSlug).toBe(TEST_PRODUCT_SLUG);
  });

  it('rejects a nonexistent productSlug with PRODUCT_NOT_FOUND', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    const res = await SELF.fetch('https://example.com/api/admin/coupons', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'NOPRODUCT', productSlug: 'does-not-exist', discountType: 'fixed', discountValue: 500, maxRedemptions: null, firstPurchaseOnly: false, startsAt: null, expiresAt: null }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('rejects a duplicate coupon code', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    const create = { code: 'DUPETEST', productSlug: null, discountType: 'fixed', discountValue: 100, maxRedemptions: null, firstPurchaseOnly: false, startsAt: null, expiresAt: null };
    await SELF.fetch('https://example.com/api/admin/coupons', { method: 'POST', headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' }, body: JSON.stringify(create) });

    const res = await SELF.fetch('https://example.com/api/admin/coupons', { method: 'POST', headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' }, body: JSON.stringify(create) });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a support-role admin (editor-only, matching the refund/products convention)', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('support');
    const res = await SELF.fetch('https://example.com/api/admin/coupons', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'SUPPORTTEST', productSlug: null, discountType: 'fixed', discountValue: 100, maxRedemptions: null, firstPurchaseOnly: false, startsAt: null, expiresAt: null }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a request without the CSRF header', async () => {
    const { cookieHeader } = await seedAdmin('super_admin');
    const res = await SELF.fetch('https://example.com/api/admin/coupons', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'NOCSRFTEST', productSlug: null, discountType: 'fixed', discountValue: 100, maxRedemptions: null, firstPurchaseOnly: false, startsAt: null, expiresAt: null }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/admin/coupons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ANONTEST', productSlug: null, discountType: 'fixed', discountValue: 100, maxRedemptions: null, firstPurchaseOnly: false, startsAt: null, expiresAt: null }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/coupons', () => {
  it('is open to every authenticated admin role, including support', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    await SELF.fetch('https://example.com/api/admin/coupons', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'LISTABLE1', productSlug: null, discountType: 'fixed', discountValue: 100, maxRedemptions: null, firstPurchaseOnly: false, startsAt: null, expiresAt: null }),
    });

    const { cookieHeader: supportCookie } = await seedAdmin('support');
    const res = await SELF.fetch('https://example.com/api/admin/coupons', { headers: { Cookie: supportCookie } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(1);
  });
});

describe('PATCH /api/admin/coupons/:id', () => {
  async function createCouponViaApi(cookieHeader: string, csrfSecret: string, code: string): Promise<number> {
    const res = await SELF.fetch('https://example.com/api/admin/coupons', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, productSlug: null, discountType: 'percentage', discountValue: 15, maxRedemptions: null, firstPurchaseOnly: false, startsAt: null, expiresAt: null }),
    });
    const body = await res.json<any>();
    return body.data.id;
  }

  it('updates status, maxRedemptions, and expiresAt as super_admin with CSRF', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    const id = await createCouponViaApi(cookieHeader, csrfSecret, 'UPDATABLE1');

    const res = await SELF.fetch(`https://example.com/api/admin/coupons/${id}`, {
      method: 'PATCH',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled', maxRedemptions: 25 }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const row = await env.DB.prepare('SELECT status, max_redemptions AS maxRedemptions FROM coupons WHERE id = ?').bind(id).first<any>();
    expect(row.status).toBe('disabled');
    expect(row.maxRedemptions).toBe(25);
  });

  it('never allows code or discount fields to change — not in the update body schema at all', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    const id = await createCouponViaApi(cookieHeader, csrfSecret, 'IMMUTABLETEST');

    // Even attempting to smuggle these fields in has no effect —
    // handleAdminCouponUpdate only ever reads status/maxRedemptions/expiresAt.
    await SELF.fetch(`https://example.com/api/admin/coupons/${id}`, {
      method: 'PATCH',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', code: 'HIJACKED', discountValue: 9999 }),
    });

    const row = await env.DB.prepare('SELECT code, discount_value AS discountValue FROM coupons WHERE id = ?').bind(id).first<any>();
    expect(row.code).toBe('IMMUTABLETEST');
    expect(row.discountValue).toBe(15);
  });

  it('rejects a support-role admin', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    const id = await createCouponViaApi(cookieHeader, csrfSecret, 'ROLETEST1');

    const { cookieHeader: supportCookie, csrfSecret: supportCsrf } = await seedAdmin('support');
    const res = await SELF.fetch(`https://example.com/api/admin/coupons/${id}`, {
      method: 'PATCH',
      headers: { Cookie: supportCookie, 'X-CSRF-Token': supportCsrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns NOT_FOUND for a nonexistent coupon id', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    const res = await SELF.fetch('https://example.com/api/admin/coupons/999999', {
      method: 'PATCH',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
