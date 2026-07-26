/**
 * Unit tests: services/admin/analyticsService.ts's getActivationSummary()
 * — Version 3.3 Milestone M5C Phase 4/6. Covers the sprint brief's
 * explicit metric list: checkout starts/completions, coupon usage,
 * review participation, dashboard usage, repeat purchases, account
 * reconciliation success.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getActivationSummary } from '../../services/admin/analyticsService';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession } from '../../services/customer/sessionService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

const RANGE = { from: '2020-01-01', to: '2030-01-01' };

async function seedVerifiedPurchase(customerId: number | null, reference: string): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, verified_at, expires_at)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', ?, datetime('now'), datetime('now', '+30 minutes'))`
  )
    .bind(reference, TEST_PRODUCT_SLUG, customerId)
    .run();
  return Number(insert.meta.last_row_id);
}

describe('analyticsService.getActivationSummary', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM audit_logs');
    await env.DB.exec('DELETE FROM coupon_redemptions');
    await env.DB.exec('DELETE FROM coupons');
    await env.DB.exec('DELETE FROM product_reviews');
    await env.DB.exec('DELETE FROM purchase_sessions');
    await env.DB.exec('DELETE FROM customer_sessions');
    await cleanupTestProduct(env as any);
    await env.DB.exec('DELETE FROM customer_profiles');
    await env.DB.exec('DELETE FROM customers');
    await env.DB.exec('DELETE FROM admin_users');
    await seedTestProduct(env as any);
  });

  it('counts every purchase_sessions row created as a checkout start, regardless of outcome', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'funnel-1@example.com', false);
    await seedVerifiedPurchase(customerId, 'RWL-ANALYTICS-0001');
    await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at)
       VALUES ('RWL-ANALYTICS-0002', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'failed', datetime('now', '+30 minutes'))`
    )
      .bind(TEST_PRODUCT_SLUG)
      .run();

    const summary = await getActivationSummary(env as any, RANGE);
    expect(summary.checkoutStarts.current).toBe(2);
    expect(summary.checkoutCompletions.current).toBe(1);
    expect(summary.checkoutCompletionRate).toBe(50);
  });

  it('checkoutCompletionRate is null when there are zero checkout starts', async () => {
    const summary = await getActivationSummary(env as any, RANGE);
    expect(summary.checkoutStarts.current).toBe(0);
    expect(summary.checkoutCompletionRate).toBeNull();
  });

  it('counts a second verified purchase by the same customer as a repeat purchase, not the first', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'repeat-buyer@example.com', false);
    await seedVerifiedPurchase(customerId, 'RWL-ANALYTICS-0003');
    await seedVerifiedPurchase(customerId, 'RWL-ANALYTICS-0004');

    const summary = await getActivationSummary(env as any, RANGE);
    expect(summary.checkoutCompletions.current).toBe(2);
    expect(summary.repeatPurchases.current).toBe(1);
  });

  it('counts distinct dashboard-active customers via customer_sessions.last_seen_at, not session count', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'dashboard-active@example.com', false);
    const s1 = await createSession(env as any, customerId, { ip: null, userAgent: null });
    await createSession(env as any, customerId, { ip: null, userAgent: null });
    void s1;

    const summary = await getActivationSummary(env as any, RANGE);
    expect(summary.dashboardActiveCustomers.current).toBe(1); // one distinct customer, two sessions
  });

  it('counts audit_logs reconciliation events as purchasesReconciled', async () => {
    await env.DB.prepare(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id) VALUES ('customer', 1, 'customer.purchases_reconciled', 'customer', 1)`
    ).run();

    const summary = await getActivationSummary(env as any, RANGE);
    expect(summary.purchasesReconciled.current).toBe(1);
  });

  it('counts product_reviews as reviewsSubmitted and coupon_redemptions as couponRedemptions', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'reviewer-analytics@example.com', false);
    const purchaseId = await seedVerifiedPurchase(customerId, 'RWL-ANALYTICS-0005');
    const product = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO product_reviews (product_id, customer_id, purchase_session_id, rating, body, status) VALUES (?, ?, ?, 5, 'Loved it', 'pending')`
    )
      .bind(product!.id, customerId, purchaseId)
      .run();

    const adminInsert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES ('analytics-test-admin@example.com', 'x:1:x', 'super_admin', 1)`).run();
    const adminId = Number(adminInsert.meta.last_row_id);
    const couponInsert = await env.DB.prepare(
      `INSERT INTO coupons (code, discount_type, discount_value, created_by) VALUES ('ANALYTICS10', 'percentage', 10, ?)`
    )
      .bind(adminId)
      .run();
    const couponId = Number(couponInsert.meta.last_row_id);
    await env.DB.prepare(
      `INSERT INTO coupon_redemptions (coupon_id, purchase_session_id, customer_email, discount_pesewas) VALUES (?, ?, 'reviewer-analytics@example.com', 390)`
    )
      .bind(couponId, purchaseId)
      .run();

    const summary = await getActivationSummary(env as any, RANGE);
    expect(summary.reviewsSubmitted.current).toBe(1);
    expect(summary.couponRedemptions.current).toBe(1);
  });
});
