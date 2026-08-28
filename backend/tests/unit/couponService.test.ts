/**
 * Unit tests: coupon discount computation, validation, and redemption
 * — Version 3.2 Milestone M4 (Reviews & Coupons). Exercises
 * services/couponService.ts directly against a real D1 instance. The
 * true-concurrency redemption-limit race is covered separately in
 * tests/integration/couponRaceConditions.test.ts (real HTTP,
 * Promise.all) — this file covers the single-request logic paths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createLogger } from '../../utils/logger';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';
import {
  computeDiscountPesewas,
  validateCoupon,
  redeemCoupon,
  checkFirstPurchaseOnlyViolation,
  createCoupon,
  updateCoupon,
  listCoupons,
} from '../../services/couponService';

const logger = createLogger('test-request-id', 'test');

beforeEach(async () => {
  await env.DB.exec('DELETE FROM coupon_redemptions');
  await env.DB.exec('DELETE FROM coupons');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customers');
  await env.DB.exec('DELETE FROM admin_users');
  await env.DB.exec('DELETE FROM audit_logs');
  await cleanupTestProduct(env as any);
});

async function seedPurchaseSession(reference: string): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at)
     VALUES (?, 'test-guide', 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'))`
  )
    .bind(reference)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedAdmin(): Promise<number> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role) VALUES (?, 'x:1:x', 'super_admin')`)
    .bind(`admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedCoupon(overrides: Partial<{ code: string; discountType: 'percentage' | 'fixed'; discountValue: number; productId: number | null; maxRedemptions: number | null; redemptionsCount: number; startsAt: string | null; expiresAt: string | null; status: string; firstPurchaseOnly: number }> = {}): Promise<number> {
  const adminId = await seedAdmin();
  const insert = await env.DB.prepare(
    `INSERT INTO coupons (code, product_id, discount_type, discount_value, max_redemptions, redemptions_count, first_purchase_only, starts_at, expires_at, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      overrides.code ?? 'TESTCODE',
      overrides.productId ?? null,
      overrides.discountType ?? 'percentage',
      overrides.discountValue ?? 10,
      overrides.maxRedemptions ?? null,
      overrides.redemptionsCount ?? 0,
      overrides.firstPurchaseOnly ?? 0,
      overrides.startsAt ?? null,
      overrides.expiresAt ?? null,
      overrides.status ?? 'active',
      adminId
    )
    .run();
  return Number(insert.meta.last_row_id);
}

describe('computeDiscountPesewas', () => {
  it('computes a percentage discount, rounded to the nearest pesewa', () => {
    expect(computeDiscountPesewas('percentage', 10, 3900)).toBe(390);
    expect(computeDiscountPesewas('percentage', 33, 1000)).toBe(330); // 330 exact
  });

  it('caps a percentage discount at the full amount (never produces a negative charge)', () => {
    expect(computeDiscountPesewas('percentage', 100, 3900)).toBe(3900);
  });

  it('computes a fixed discount, capped at the amount so it can never exceed the price', () => {
    expect(computeDiscountPesewas('fixed', 500, 3900)).toBe(500);
    expect(computeDiscountPesewas('fixed', 10000, 3900)).toBe(3900); // capped, never negative final total
  });
});

describe('validateCoupon', () => {
  it('returns not_found for a nonexistent code', async () => {
    const result = await validateCoupon(env as any, 'NOPE', TEST_PRODUCT_SLUG, 3900);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('not_found');
  });

  it('returns not_found for a non-string or empty code (never crashes on malformed input)', async () => {
    const result1 = await validateCoupon(env as any, undefined, TEST_PRODUCT_SLUG, 3900);
    expect(result1.valid).toBe(false);
    const result2 = await validateCoupon(env as any, '   ', TEST_PRODUCT_SLUG, 3900);
    expect(result2.valid).toBe(false);
    const result3 = await validateCoupon(env as any, 'x'.repeat(65), TEST_PRODUCT_SLUG, 3900);
    expect(result3.valid).toBe(false);
  });

  it('is case-insensitive (stored uppercase, matched uppercase)', async () => {
    await seedCoupon({ code: 'SAVE10' });
    const result = await validateCoupon(env as any, 'save10', TEST_PRODUCT_SLUG, 3900);
    expect(result.valid).toBe(true);
  });

  it('returns inactive for a disabled coupon', async () => {
    await seedCoupon({ code: 'DISABLED1', status: 'disabled' });
    const result = await validateCoupon(env as any, 'DISABLED1', TEST_PRODUCT_SLUG, 3900);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('inactive');
  });

  it('returns not_started for a coupon whose starts_at is in the future', async () => {
    await seedCoupon({ code: 'FUTURE1', startsAt: new Date(Date.now() + 86400_000).toISOString() });
    const result = await validateCoupon(env as any, 'FUTURE1', TEST_PRODUCT_SLUG, 3900);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('not_started');
  });

  it('returns expired for a coupon whose expires_at is in the past', async () => {
    await seedCoupon({ code: 'EXPIRED1', expiresAt: new Date(Date.now() - 86400_000).toISOString() });
    const result = await validateCoupon(env as any, 'EXPIRED1', TEST_PRODUCT_SLUG, 3900);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('expired');
  });

  it('returns product_mismatch for a coupon scoped to a different product', async () => {
    await seedTestProduct(env as any);
    const otherProduct = await env.DB.prepare(
      `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
       VALUES ('prod-other', 'other-guide', 'Other Guide', 'investing', 'ebook', 'active', 5000, 'GHS', 'one-time', 'inclusive', 'en')`
    ).run();
    const otherProductId = Number(otherProduct.meta.last_row_id);
    await seedCoupon({ code: 'SCOPED1', productId: otherProductId });

    const result = await validateCoupon(env as any, 'SCOPED1', TEST_PRODUCT_SLUG, 3900);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('product_mismatch');
    // No manual cleanup here — the coupon row still references
    // "other-guide" (FK), and the shared beforeEach already clears
    // coupons before products on the next test.
  });

  it('returns valid for a coupon correctly scoped to the matching product', async () => {
    await seedTestProduct(env as any);
    const product = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
    await seedCoupon({ code: 'SCOPED2', productId: product!.id });

    const result = await validateCoupon(env as any, 'SCOPED2', TEST_PRODUCT_SLUG, 3900);
    expect(result.valid).toBe(true);
  });

  it('returns redemption_limit_reached when redemptions_count has reached max_redemptions', async () => {
    await seedCoupon({ code: 'LIMITED1', maxRedemptions: 5, redemptionsCount: 5 });
    const result = await validateCoupon(env as any, 'LIMITED1', TEST_PRODUCT_SLUG, 3900);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('redemption_limit_reached');
  });

  it('returns the correctly computed discount and final amount for a valid coupon', async () => {
    await seedCoupon({ code: 'VALID1', discountType: 'percentage', discountValue: 20 });
    const result = await validateCoupon(env as any, 'VALID1', TEST_PRODUCT_SLUG, 5000);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.discountPesewas).toBe(1000);
      expect(result.finalAmountPesewas).toBe(4000);
    }
  });

  it('never mutates redemptions_count (non-mutating preview, even when called repeatedly)', async () => {
    const couponId = await seedCoupon({ code: 'NOMUTATE1' });
    await validateCoupon(env as any, 'NOMUTATE1', TEST_PRODUCT_SLUG, 3900);
    await validateCoupon(env as any, 'NOMUTATE1', TEST_PRODUCT_SLUG, 3900);
    await validateCoupon(env as any, 'NOMUTATE1', TEST_PRODUCT_SLUG, 3900);

    const row = await env.DB.prepare('SELECT redemptions_count AS redemptionsCount FROM coupons WHERE id = ?').bind(couponId).first<any>();
    expect(row.redemptionsCount).toBe(0);
  });
});

describe('redeemCoupon', () => {
  it('increments redemptions_count and records a coupon_redemptions row', async () => {
    const couponId = await seedCoupon({ code: 'REDEEM1', maxRedemptions: 10 });
    const purchaseSessionId = await seedPurchaseSession('RWL-2026-800201');

    const result = await redeemCoupon(env as any, logger, couponId, purchaseSessionId, 'buyer@example.com', 500);
    expect(result.recorded).toBe(true);
    expect(result.limitEnforced).toBe(true);

    const coupon = await env.DB.prepare('SELECT redemptions_count AS redemptionsCount FROM coupons WHERE id = ?').bind(couponId).first<any>();
    expect(coupon.redemptionsCount).toBe(1);

    const redemption = await env.DB.prepare('SELECT customer_email AS customerEmail, discount_pesewas AS discountPesewas FROM coupon_redemptions WHERE coupon_id = ?')
      .bind(couponId)
      .first<any>();
    expect(redemption.customerEmail).toBe('buyer@example.com');
    expect(redemption.discountPesewas).toBe(500);
  });

  it('forensic-audit fix (2026-08-28): the redemption row inherits the COUPON\'s own data_classification, not left UNKNOWN, matching migration 0029\'s established precedent', async () => {
    const adminId = await seedAdmin();
    const couponInsert = await env.DB.prepare(
      `INSERT INTO coupons (code, discount_type, discount_value, status, created_by, data_classification) VALUES ('CLSTEST', 'fixed', 500, 'active', ?, 'DEVELOPMENT')`
    )
      .bind(adminId)
      .run();
    const couponId = Number(couponInsert.meta.last_row_id);
    const purchaseSessionId = await seedPurchaseSession('RWL-2026-800299');

    await redeemCoupon(env as any, logger, couponId, purchaseSessionId, 'internal-tester@example.com', 500);

    const redemption = await env.DB.prepare('SELECT data_classification AS cls FROM coupon_redemptions WHERE coupon_id = ?').bind(couponId).first<any>();
    expect(redemption.cls).toBe('DEVELOPMENT');
  });

  it('still records the redemption even when the redemption limit is already reached — payment already happened, it is never reversed', async () => {
    const couponId = await seedCoupon({ code: 'ATCAP1', maxRedemptions: 1, redemptionsCount: 1 });
    const purchaseSessionId = await seedPurchaseSession('RWL-2026-800202');

    const result = await redeemCoupon(env as any, logger, couponId, purchaseSessionId, 'late-buyer@example.com', 500);
    expect(result.limitEnforced).toBe(false); // the atomic increment lost — count did not increase
    expect(result.recorded).toBe(true); // but the redemption is still recorded, the charge already happened

    const coupon = await env.DB.prepare('SELECT redemptions_count AS redemptionsCount FROM coupons WHERE id = ?').bind(couponId).first<any>();
    expect(coupon.redemptionsCount).toBe(1); // unchanged — never exceeds the stored limit

    const redemption = await env.DB.prepare('SELECT id FROM coupon_redemptions WHERE coupon_id = ? AND purchase_session_id = ?').bind(couponId, purchaseSessionId).first();
    expect(redemption).toBeTruthy();
  });

  it('an unlimited coupon (max_redemptions NULL) always enforces the limit successfully', async () => {
    const couponId = await seedCoupon({ code: 'UNLIMITED1', maxRedemptions: null });
    const purchaseSessionId = await seedPurchaseSession('RWL-2026-800203');
    const result = await redeemCoupon(env as any, logger, couponId, purchaseSessionId, 'buyer2@example.com', 200);
    expect(result.limitEnforced).toBe(true);
  });
});

describe('checkFirstPurchaseOnlyViolation', () => {
  it('does nothing for a coupon without first_purchase_only set', async () => {
    const couponId = await seedCoupon({ code: 'NOTFPO1', firstPurchaseOnly: 0 });
    const customer = await env.DB.prepare(`INSERT INTO customers (email) VALUES ('fpo1@example.com')`).run();
    const customerId = Number(customer.meta.last_row_id);

    // Should not throw and should not log anything fatal — this is a
    // detection-only, void-returning function; absence of a thrown
    // error is the observable contract here.
    await expect(checkFirstPurchaseOnlyViolation(env as any, logger, couponId, customerId, 1)).resolves.toBeUndefined();
  });

  it('does not flag a customer with no prior verified purchase (their first purchase genuinely is this one)', async () => {
    const couponId = await seedCoupon({ code: 'FPO1', firstPurchaseOnly: 1 });
    const customer = await env.DB.prepare(`INSERT INTO customers (email) VALUES ('fpo2@example.com')`).run();
    const customerId = Number(customer.meta.last_row_id);

    await seedTestProduct(env as any);
    const purchase = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, customer_id)
       VALUES ('RWL-2026-800101', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'), ?)`
    )
      .bind(TEST_PRODUCT_SLUG, customerId)
      .run();
    const purchaseSessionId = Number(purchase.meta.last_row_id);

    await expect(checkFirstPurchaseOnlyViolation(env as any, logger, couponId, customerId, purchaseSessionId)).resolves.toBeUndefined();
    // No assertion on logging internals here (best-effort, detection-only) —
    // the meaningful behavior under test is that this never throws or blocks.
  });

  // Added at M4E closeout to close the gap M4D's independent Testing
  // Assessment identified: the no-violation cases were covered, but the
  // actual violation-detected case (a customer with a genuine prior
  // verified purchase using a first_purchase_only coupon again) was not.
  it('M4E closeout: flags (logs) a customer with a genuine prior verified purchase, without throwing or blocking', async () => {
    const couponId = await seedCoupon({ code: 'FPO3', firstPurchaseOnly: 1 });
    const customer = await env.DB.prepare(`INSERT INTO customers (email) VALUES ('fpo3@example.com')`).run();
    const customerId = Number(customer.meta.last_row_id);

    await seedTestProduct(env as any);
    const priorPurchase = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, customer_id)
       VALUES ('RWL-2026-800102', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'), ?)`
    )
      .bind(TEST_PRODUCT_SLUG, customerId)
      .run();
    const priorPurchaseSessionId = Number(priorPurchase.meta.last_row_id);

    const currentPurchase = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, customer_id)
       VALUES ('RWL-2026-800103', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'), ?)`
    )
      .bind(TEST_PRODUCT_SLUG, customerId)
      .run();
    const currentPurchaseSessionId = Number(currentPurchase.meta.last_row_id);

    const spyLogger = { info: () => {}, warn: () => {}, error: vi.fn() };
    await expect(
      checkFirstPurchaseOnlyViolation(env as any, spyLogger as any, couponId, customerId, currentPurchaseSessionId)
    ).resolves.toBeUndefined(); // never throws or blocks - detection-only, matching the payment that already succeeded

    expect(spyLogger.error).toHaveBeenCalledTimes(1);
    const [message, context] = spyLogger.error.mock.calls[0];
    expect(message).toBe('coupon.first_purchase_only_violated');
    expect(context).toMatchObject({ couponId, customerId, currentPurchaseSessionId, priorPurchaseSessionId });
  });
});

describe('createCoupon', () => {
  it('rejects an invalid code format', async () => {
    const adminId = await seedAdmin();
    const result = await createCoupon(env as any, logger, adminId, {
      code: 'ab', // too short
      productSlug: null,
      discountType: 'percentage',
      discountValue: 10,
      maxRedemptions: null,
      firstPurchaseOnly: false,
      startsAt: null,
      expiresAt: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_input');
  });

  it('rejects a percentage discount over 100', async () => {
    const adminId = await seedAdmin();
    const result = await createCoupon(env as any, logger, adminId, {
      code: 'OVER100',
      productSlug: null,
      discountType: 'percentage',
      discountValue: 150,
      maxRedemptions: null,
      firstPurchaseOnly: false,
      startsAt: null,
      expiresAt: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_input');
  });

  it('rejects a duplicate code', async () => {
    const adminId = await seedAdmin();
    await seedCoupon({ code: 'DUPLICATE1' });
    const result = await createCoupon(env as any, logger, adminId, {
      code: 'DUPLICATE1',
      productSlug: null,
      discountType: 'fixed',
      discountValue: 100,
      maxRedemptions: null,
      firstPurchaseOnly: false,
      startsAt: null,
      expiresAt: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('duplicate_code');
  });

  it('rejects a nonexistent productSlug', async () => {
    const adminId = await seedAdmin();
    const result = await createCoupon(env as any, logger, adminId, {
      code: 'NOPRODUCT1',
      productSlug: 'does-not-exist',
      discountType: 'fixed',
      discountValue: 100,
      maxRedemptions: null,
      firstPurchaseOnly: false,
      startsAt: null,
      expiresAt: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('product_not_found');
  });

  it('creates a valid coupon, normalizes the code to uppercase, and writes an audit log entry', async () => {
    const adminId = await seedAdmin();
    const result = await createCoupon(env as any, logger, adminId, {
      code: 'launch20',
      productSlug: null,
      discountType: 'percentage',
      discountValue: 20,
      maxRedemptions: 100,
      firstPurchaseOnly: true,
      startsAt: null,
      expiresAt: null,
    });
    expect(result.ok).toBe(true);

    const row = await env.DB.prepare('SELECT code, data_classification AS cls FROM coupons WHERE id = ?').bind((result as any).id).first<any>();
    expect(row.code).toBe('LAUNCH20');
    // Forensic-audit fix (2026-08-28): a coupon is only ever created by
    // a real authenticated admin through this one production panel —
    // no test-environment distinction applies, so it defaults to
    // PRODUCTION instead of the old UNKNOWN-forever default.
    expect(row.cls).toBe('PRODUCTION');

    const audit = await env.DB.prepare(`SELECT action FROM audit_logs WHERE action = 'coupon.created'`).first();
    expect(audit).toBeTruthy();
  });
});

describe('updateCoupon', () => {
  it('returns not_found for a nonexistent coupon', async () => {
    const adminId = await seedAdmin();
    const result = await updateCoupon(env as any, logger, adminId, 999999, { status: 'disabled' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('updates status/maxRedemptions/expiresAt and writes an audit log entry', async () => {
    const adminId = await seedAdmin();
    const couponId = await seedCoupon({ code: 'UPDATE1', status: 'active' });

    const result = await updateCoupon(env as any, logger, adminId, couponId, { status: 'disabled', maxRedemptions: 50 });
    expect(result.ok).toBe(true);

    const row = await env.DB.prepare('SELECT status, max_redemptions AS maxRedemptions FROM coupons WHERE id = ?').bind(couponId).first<any>();
    expect(row.status).toBe('disabled');
    expect(row.maxRedemptions).toBe(50);

    const audit = await env.DB.prepare(`SELECT action FROM audit_logs WHERE action = 'coupon.updated'`).first();
    expect(audit).toBeTruthy();
  });

  it('never allows code, discount type, discount value, or product to change (not part of the input type at all)', async () => {
    const adminId = await seedAdmin();
    const couponId = await seedCoupon({ code: 'IMMUTABLE1', discountType: 'percentage', discountValue: 10 });

    await updateCoupon(env as any, logger, adminId, couponId, { status: 'active' });

    const row = await env.DB.prepare('SELECT code, discount_type AS discountType, discount_value AS discountValue FROM coupons WHERE id = ?').bind(couponId).first<any>();
    expect(row.code).toBe('IMMUTABLE1');
    expect(row.discountType).toBe('percentage');
    expect(row.discountValue).toBe(10);
  });
});

describe('listCoupons', () => {
  it('paginates and includes the resolved product slug for product-scoped coupons', async () => {
    await seedTestProduct(env as any);
    const product = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
    await seedCoupon({ code: 'SCOPEDLIST1', productId: product!.id });
    await seedCoupon({ code: 'PLATFORMLIST1', productId: null });

    const result = await listCoupons(env as any, 1, 20);
    expect(result.total).toBe(2);
    const scoped = result.items.find((c) => c.code === 'SCOPEDLIST1');
    expect(scoped?.productSlug).toBe(TEST_PRODUCT_SLUG);
    const platform = result.items.find((c) => c.code === 'PLATFORMLIST1');
    expect(platform?.productSlug).toBeNull();
  });
});
