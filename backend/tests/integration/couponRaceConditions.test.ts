/**
 * Integration test: the coupon redemption-limit race — Version 3.2
 * Milestone M4 (Reviews & Coupons). This is the single most important
 * test in the M4C security review's threat model
 * (docs/v3.2-m4c-amendment-2-coupon-security-review.md's "Race
 * conditions" section): two genuinely simultaneous webhook deliveries
 * for two different purchases, both holding the last available
 * redemption of a max_redemptions=1 coupon.
 *
 * Uses real HTTP requests fired with Promise.all (true concurrency,
 * not sequential awaits) — matches the established pattern in
 * tests/integration/adminRefund.test.ts's own "M2C MAR closeout"
 * concurrent-refund test.
 *
 * The expected, deliberately-designed outcome (see the security
 * review): BOTH payments are verified and fulfilled — a payment is
 * never reversed once genuinely charged — but redemptions_count never
 * exceeds max_redemptions. Both redemptions are still recorded in
 * coupon_redemptions, since the discount was genuinely applied to both
 * charges; the loser is only ever detected via a logged
 * `coupon.redemption_limit_race` anomaly, never by denying the sale.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { queueVerifyResponse } from '../outboundMock';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM receipt_download_tokens');
  await env.DB.exec('DELETE FROM receipts');
  await env.DB.exec('DELETE FROM licenses');
  await env.DB.exec('DELETE FROM order_items');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM payment_transactions');
  await env.DB.exec('DELETE FROM coupon_redemptions');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM coupons');
  await env.DB.exec('DELETE FROM email_log');
  await env.DB.exec('DELETE FROM customer_password_tokens');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM admin_users');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any); // price: 3900 pesewas
});

async function seedAdmin(): Promise<number> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role) VALUES (?, 'x:1:x', 'super_admin')`)
    .bind(`admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedLimitedCoupon(): Promise<number> {
  const adminId = await seedAdmin();
  const insert = await env.DB.prepare(
    `INSERT INTO coupons (code, discount_type, discount_value, max_redemptions, redemptions_count, status, created_by)
     VALUES ('RACE10', 'percentage', 10, 1, 0, 'active', ?)`
  )
    .bind(adminId)
    .run();
  return Number(insert.meta.last_row_id);
}

async function createSessionWithCoupon(couponCode: string): Promise<{ reference: string; amountPesewas: number }> {
  const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'race-buyer@example.com', couponCode }),
  });
  const body = await res.json<any>();
  const session = await env.DB.prepare('SELECT amount_pesewas AS amountPesewas FROM purchase_sessions WHERE purchase_reference = ?')
    .bind(body.data.purchaseReference)
    .first<any>();
  return { reference: body.data.purchaseReference, amountPesewas: session.amountPesewas };
}

async function signedWebhookRequest(payload: unknown): Promise<Request> {
  const rawBody = JSON.stringify(payload);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.PAYSTACK_SECRET_KEY), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const signature = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return new Request('https://example.com/api/webhooks/paystack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
    body: rawBody,
  });
}

function chargeSuccessPayload(reference: string, email: string, amountPesewas: number) {
  return {
    event: 'charge.success',
    data: {
      reference,
      amount: amountPesewas,
      currency: 'GHS',
      customer: { email },
      metadata: { purchaseReference: reference, productId: 'prod-test-guide', productSlug: TEST_PRODUCT_SLUG, productVersion: null },
      status: 'success',
    },
  };
}

async function mockPaystackVerifySuccess(reference: string, email: string, amountPesewas: number) {
  await queueVerifyResponse(env as any, reference, {
    status: true,
    message: 'ok',
    data: {
      reference,
      amount: amountPesewas,
      currency: 'GHS',
      status: 'success',
      customer: { email },
      metadata: { purchaseReference: reference, productId: 'prod-test-guide', productSlug: TEST_PRODUCT_SLUG, productVersion: null },
    },
  });
}

describe('Coupon redemption-limit race — two simultaneous payments for a max_redemptions=1 coupon', () => {
  it('never reverses either payment, and never lets redemptions_count exceed the stored limit', async () => {
    await seedLimitedCoupon();

    // Two independent checkout sessions, both applying the same
    // limited coupon. Both succeed at checkout-creation time — the
    // soft check in validateCoupon() sees redemptions_count=0 for
    // both, exactly as the security review documents (the atomic,
    // authoritative check only ever happens in redeemCoupon(), after
    // payment).
    const [buyerA, buyerB] = await Promise.all([createSessionWithCoupon('RACE10'), createSessionWithCoupon('RACE10')]);
    expect(buyerA.amountPesewas).toBe(3510); // 3900 - 10%
    expect(buyerB.amountPesewas).toBe(3510);

    await Promise.all([
      mockPaystackVerifySuccess(buyerA.reference, 'racer-a@example.com', buyerA.amountPesewas),
      mockPaystackVerifySuccess(buyerB.reference, 'racer-b@example.com', buyerB.amountPesewas),
    ]);

    // The core of this test: two real HTTP webhook deliveries fired
    // with Promise.all, not sequential awaits — genuine concurrency,
    // not a simulated one.
    const [reqA, reqB] = await Promise.all([
      signedWebhookRequest(chargeSuccessPayload(buyerA.reference, 'racer-a@example.com', buyerA.amountPesewas)),
      signedWebhookRequest(chargeSuccessPayload(buyerB.reference, 'racer-b@example.com', buyerB.amountPesewas)),
    ]);
    const [resA, resB] = await Promise.all([SELF.fetch(reqA), SELF.fetch(reqB)]);
    const [bodyA, bodyB] = await Promise.all([resA.json<any>(), resB.json<any>()]);

    // Webhooks always ack success once well-formed/signed (see
    // routes/webhooks.ts) — the interesting assertions are on the
    // resulting database state, not the HTTP envelope.
    expect(bodyA.success).toBe(true);
    expect(bodyB.success).toBe(true);

    const [sessionA, sessionB] = await Promise.all([
      env.DB.prepare('SELECT status FROM purchase_sessions WHERE purchase_reference = ?').bind(buyerA.reference).first<any>(),
      env.DB.prepare('SELECT status FROM purchase_sessions WHERE purchase_reference = ?').bind(buyerB.reference).first<any>(),
    ]);
    // Both payments genuinely succeeded and neither is ever reversed —
    // the central invariant under test.
    expect(sessionA.status).toBe('verified');
    expect(sessionB.status).toBe('verified');

    const coupon = await env.DB.prepare('SELECT redemptions_count AS redemptionsCount, max_redemptions AS maxRedemptions FROM coupons WHERE code = ?')
      .bind('RACE10')
      .first<any>();
    // The atomic conditional UPDATE ensures the counter itself never
    // exceeds the stored limit, even though both charges succeeded.
    expect(coupon.redemptionsCount).toBeLessThanOrEqual(coupon.maxRedemptions);
    expect(coupon.redemptionsCount).toBe(1);

    // Both redemptions are still recorded — the discount was genuinely
    // applied and charged to both customers; this service never
    // silently drops a real, already-charged discount from its own
    // audit trail just because the counter lost the race.
    const redemptionCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = (SELECT id FROM coupons WHERE code = ?)')
      .bind('RACE10')
      .first<any>();
    expect(redemptionCount.n).toBe(2);
  });
});
