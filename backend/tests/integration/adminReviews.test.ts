/**
 * Integration tests: admin review moderation — Version 3.2 Milestone
 * M4 (Reviews & Coupons). Exercises GET /api/admin/reviews and POST
 * /api/admin/reviews/:id/moderate through the real Worker fetch
 * handler — role gating (viewing open to all roles, moderation
 * editor-only) and CSRF are the central concerns, matching
 * adminRefund.test.ts's established pattern for this codebase.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createSession as createAdminSession } from '../../services/admin/sessionService';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM product_reviews');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
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

async function seedPendingReview(reference: string): Promise<number> {
  const { customerId } = await findOrCreateCustomer(env as any, `reviewer-${reference}@example.com`, false);
  const purchaseInsert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, customer_id)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'), ?)`
  )
    .bind(reference, TEST_PRODUCT_SLUG, customerId)
    .run();
  const purchaseSessionId = Number(purchaseInsert.meta.last_row_id);
  const product = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
  const insert = await env.DB.prepare(
    `INSERT INTO product_reviews (product_id, customer_id, purchase_session_id, rating, body, status) VALUES (?, ?, ?, 5, 'Pending review body.', 'pending')`
  )
    .bind(product!.id, customerId, purchaseSessionId)
    .run();
  return Number(insert.meta.last_row_id);
}

describe('GET /api/admin/reviews', () => {
  it('is open to every authenticated admin role, including support', async () => {
    await seedPendingReview('RWL-2026-910001');
    const { cookieHeader } = await seedAdmin('support');

    const res = await SELF.fetch('https://example.com/api/admin/reviews', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(1);
  });

  it('filters by status', async () => {
    const pendingId = await seedPendingReview('RWL-2026-910002');
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    await SELF.fetch(`https://example.com/api/admin/reviews/${pendingId}/moderate`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    await seedPendingReview('RWL-2026-910003');

    const res = await SELF.fetch('https://example.com/api/admin/reviews?status=pending', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.total).toBe(1);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/admin/reviews');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/reviews/:id/moderate', () => {
  it('approves a review as super_admin with CSRF, and it becomes publicly visible', async () => {
    const reviewId = await seedPendingReview('RWL-2026-910004');
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');

    const res = await SELF.fetch(`https://example.com/api/admin/reviews/${reviewId}/moderate`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const publicRes = await SELF.fetch(`https://example.com/api/products/${TEST_PRODUCT_SLUG}/reviews`);
    const publicBody = await publicRes.json<any>();
    expect(publicBody.data.count).toBe(1);
  });

  it('rejects a support-role admin (editor-only, matching the refund/products convention)', async () => {
    const reviewId = await seedPendingReview('RWL-2026-910005');
    const { cookieHeader, csrfSecret } = await seedAdmin('support');

    const res = await SELF.fetch(`https://example.com/api/admin/reviews/${reviewId}/moderate`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a request without the CSRF header', async () => {
    const reviewId = await seedPendingReview('RWL-2026-910006');
    const { cookieHeader } = await seedAdmin('super_admin');

    const res = await SELF.fetch(`https://example.com/api/admin/reviews/${reviewId}/moderate`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects an invalid status value', async () => {
    const reviewId = await seedPendingReview('RWL-2026-910007');
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');

    const res = await SELF.fetch(`https://example.com/api/admin/reviews/${reviewId}/moderate`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending' }), // not a valid moderation outcome
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns NOT_FOUND for a nonexistent review id', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    const res = await SELF.fetch('https://example.com/api/admin/reviews/999999/moderate', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'rejected' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
