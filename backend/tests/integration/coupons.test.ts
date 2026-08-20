/**
 * Integration tests: public coupon preview + checkout discount
 * application — Version 3.2 Milestone M4 (Reviews & Coupons).
 * Exercises POST /api/coupons/validate and POST
 * /api/checkout/sessions through the real Worker fetch handler. The
 * redemption-limit race is covered separately, with true HTTP
 * concurrency, in tests/integration/couponRaceConditions.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM coupon_redemptions');
  // purchase_sessions.coupon_id references coupons(id) — must be
  // cleared before coupons itself, or a leftover locked session from a
  // prior test's checkout blocks the DELETE.
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM coupons');
  await env.DB.exec('DELETE FROM admin_users');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any); // default price: 3900 pesewas
});

async function seedAdmin(): Promise<number> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role) VALUES (?, 'x:1:x', 'super_admin')`)
    .bind(`admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedCoupon(overrides: Partial<{ code: string; discountType: 'percentage' | 'fixed'; discountValue: number; maxRedemptions: number | null; redemptionsCount: number; status: string }> = {}): Promise<number> {
  const adminId = await seedAdmin();
  const insert = await env.DB.prepare(
    `INSERT INTO coupons (code, discount_type, discount_value, max_redemptions, redemptions_count, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      overrides.code ?? 'SAVE10',
      overrides.discountType ?? 'percentage',
      overrides.discountValue ?? 10,
      overrides.maxRedemptions ?? null,
      overrides.redemptionsCount ?? 0,
      overrides.status ?? 'active',
      adminId
    )
    .run();
  return Number(insert.meta.last_row_id);
}

describe('POST /api/coupons/validate', () => {
  it('is public (no auth required) and returns the computed discount for a valid coupon', async () => {
    await seedCoupon({ code: 'SAVE10', discountType: 'percentage', discountValue: 10 });

    const res = await SELF.fetch('https://example.com/api/coupons/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, couponCode: 'save10' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.valid).toBe(true);
    expect(body.data.discountPesewas).toBe(390); // 10% of the seeded 3900 test-guide price
    expect(body.data.finalAmountPesewas).toBe(3510);
  });

  it('returns valid:false with a reason for an unknown code, never an error envelope', async () => {
    const res = await SELF.fetch('https://example.com/api/coupons/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, couponCode: 'DOESNOTEXIST' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.valid).toBe(false);
    expect(body.data.reason).toBe('not_found');
  });

  it('never mutates redemptions_count — this is a preview endpoint only', async () => {
    const couponId = await seedCoupon({ code: 'PREVIEWONLY' });
    await SELF.fetch('https://example.com/api/coupons/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, couponCode: 'PREVIEWONLY' }),
    });

    const row = await env.DB.prepare('SELECT redemptions_count AS redemptionsCount FROM coupons WHERE id = ?').bind(couponId).first<any>();
    expect(row.redemptionsCount).toBe(0);
  });

  it('rejects a missing/invalid productId with VALIDATION_ERROR', async () => {
    const res = await SELF.fetch('https://example.com/api/coupons/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ couponCode: 'SAVE10' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/checkout/sessions with a coupon code', () => {
  it('locks a discounted amount into the purchase_sessions row when a valid coupon is supplied', async () => {
    await seedCoupon({ code: 'CHECKOUT10', discountType: 'percentage', discountValue: 10 });

    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'buyer@example.com', couponCode: 'CHECKOUT10' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const session = await env.DB.prepare(
      'SELECT amount_pesewas AS amountPesewas, discount_pesewas AS discountPesewas, coupon_id AS couponId FROM purchase_sessions WHERE purchase_reference = ?'
    )
      .bind(body.data.purchaseReference)
      .first<any>();
    expect(session.discountPesewas).toBe(390); // 10% of the seeded 3900 test-guide price
    expect(session.amountPesewas).toBe(3510); // 3900 - 390, the actual amount that will be charged
    expect(session.couponId).not.toBeNull();
  });

  it('rejects checkout with COUPON_INVALID for an unknown coupon code, and never creates a session with a bogus discount', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'buyer@example.com', couponCode: 'BOGUS' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('COUPON_INVALID');

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM purchase_sessions').first<any>();
    expect(count.n).toBe(0);
  });

  it('checkout without a coupon code is unaffected — amount equals the full price, discount is zero', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'buyer@example.com' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const session = await env.DB.prepare('SELECT amount_pesewas AS amountPesewas, discount_pesewas AS discountPesewas FROM purchase_sessions WHERE purchase_reference = ?')
      .bind(body.data.purchaseReference)
      .first<any>();
    expect(session.discountPesewas).toBe(0);
    expect(session.amountPesewas).toBe(3900);
  });

  it('never accepts a client-supplied discount amount — only couponCode is read, any other discount field is ignored', async () => {
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: TEST_PRODUCT_SLUG,
        termsAccepted: true,
        licenseAccepted: true,
        email: 'buyer@example.com',
        discountPesewas: 999999, // attempted price tampering — must be silently ignored
        amountPesewas: 1,
      }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const session = await env.DB.prepare('SELECT amount_pesewas AS amountPesewas, discount_pesewas AS discountPesewas FROM purchase_sessions WHERE purchase_reference = ?')
      .bind(body.data.purchaseReference)
      .first<any>();
    expect(session.discountPesewas).toBe(0);
    expect(session.amountPesewas).toBe(3900); // the real product price, never the attempted 1 pesewa
  });
});
