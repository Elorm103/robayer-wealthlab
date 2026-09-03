/**
 * Integration tests: the affiliate commission engine. Checkout ->
 * webhook verification -> commission recorded, idempotency, self-
 * referral, suspended-affiliate exclusion, and refund reversal. Real
 * Worker fetch handler, real D1, Paystack intercepted via
 * tests/outboundMock.ts; same conventions as webhook.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { queueVerifyResponse } from '../outboundMock';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { revokePurchase } from '../../services/orders/revocationService';
import { adjustCommission } from '../../services/affiliateCommissionService';
import { createLogger } from '../../utils/logger';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM affiliate_commissions');
  await env.DB.exec('DELETE FROM affiliate_clicks');
  await env.DB.exec('DELETE FROM affiliates');
  await env.DB.exec('DELETE FROM receipt_download_tokens');
  await env.DB.exec('DELETE FROM receipts');
  await env.DB.exec('DELETE FROM licenses');
  await env.DB.exec('DELETE FROM order_items');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM payment_transactions');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM email_log');
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM customer_password_tokens');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
  await env.RATE_LIMIT_KV.delete('ratelimit:checkout:unknown');
});

async function seedApprovedAffiliate(email: string, code: string, defaultPercent = 20): Promise<{ affiliateId: number; customerId: number }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const insert = await env.DB.prepare(
    `INSERT INTO affiliates (customer_id, affiliate_code, status, default_commission_percent, data_classification) VALUES (?, ?, 'approved', ?, 'PRODUCTION')`
  )
    .bind(customerId, code, defaultPercent)
    .run();
  return { affiliateId: Number(insert.meta.last_row_id), customerId };
}

/** Real rwl_ref cookie shape is `CODE.ISSUED_AT_SECONDS` (affiliateAttributionService.ts). */
function refCookie(code: string): string {
  return `${code}.${Math.floor(Date.now() / 1000)}`;
}

async function checkoutWithRef(refCode: string | null, email: string, amountPesewas = 3900, extraBody: Record<string, unknown> = {}): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (refCode) headers.Cookie = `rwl_ref=${refCookie(refCode)}`;
  const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email, ...extraBody }),
  });
  const body = await res.json<any>();
  return body.data.purchaseReference;
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

function chargeSuccessPayload(reference: string, email: string, amountPesewas = 3900) {
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

async function seedCoupon(overrides: Partial<{ code: string; discountType: 'percentage' | 'fixed'; discountValue: number }> = {}): Promise<number> {
  const adminInsert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role) VALUES (?, 'x:1:x', 'super_admin')`)
    .bind(`coupon-admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  const insert = await env.DB.prepare(
    `INSERT INTO coupons (code, discount_type, discount_value, max_redemptions, redemptions_count, status, created_by) VALUES (?, ?, ?, NULL, 0, 'active', ?)`
  )
    .bind(overrides.code ?? 'AFFCOUPON10', overrides.discountType ?? 'percentage', overrides.discountValue ?? 10, Number(adminInsert.meta.last_row_id))
    .run();
  return Number(insert.meta.last_row_id);
}

async function mockVerifySuccess(reference: string, email: string, amountPesewas = 3900) {
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

describe('Affiliate commission recording on verified purchase', () => {
  it('a verified purchase attributed to an affiliate records a commission at the correct percentage', async () => {
    await seedApprovedAffiliate('commission-affiliate@example.com', 'RWLCOMM20', 25);

    const reference = await checkoutWithRef('RWLCOMM20', 'buyer1@example.com');
    await mockVerifySuccess(reference, 'buyer1@example.com');
    const res = await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'buyer1@example.com')));
    expect((await res.json<any>()).success).toBe(true);

    const commission = await env.DB.prepare(
      `SELECT gross_pesewas AS gross, commission_percent AS pct, commission_pesewas AS amount, status
       FROM affiliate_commissions WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`
    )
      .bind(reference)
      .first<any>();
    expect(commission).toBeTruthy();
    expect(commission.gross).toBe(3900);
    expect(commission.pct).toBe(25);
    expect(commission.amount).toBe(975); // 25% of 3900
    expect(commission.status).toBe('pending');
  });

  it('a direct (non-referred) purchase records no commission at all', async () => {
    const reference = await checkoutWithRef(null, 'organic-buyer@example.com');
    await mockVerifySuccess(reference, 'organic-buyer@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'organic-buyer@example.com')));

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM affiliate_commissions`).first<any>();
    expect(count.n).toBe(0);
  });

  it('redelivering the same webhook never creates a duplicate commission (idempotent)', async () => {
    await seedApprovedAffiliate('idempotent-affiliate@example.com', 'RWLIDEMP');
    const reference = await checkoutWithRef('RWLIDEMP', 'idempotent-buyer@example.com');
    await mockVerifySuccess(reference, 'idempotent-buyer@example.com');

    const req = await signedWebhookRequest(chargeSuccessPayload(reference, 'idempotent-buyer@example.com'));
    const rawBody = await req.clone().text();
    await SELF.fetch(req);

    const replay = new Request('https://example.com/api/webhooks/paystack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': req.headers.get('x-paystack-signature')! },
      body: rawBody,
    });
    await SELF.fetch(replay);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM affiliate_commissions WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`).bind(reference).first<any>();
    expect(count.n).toBe(1);
  });

  it('an affiliate suspended AFTER checkout but BEFORE verification never gets a commission for that sale', async () => {
    const { affiliateId } = await seedApprovedAffiliate('suspended-after-checkout@example.com', 'RWLSUSPAFTER');
    const reference = await checkoutWithRef('RWLSUSPAFTER', 'buyer-of-suspended-mid@example.com');

    await env.DB.prepare(`UPDATE affiliates SET status = 'suspended' WHERE id = ?`).bind(affiliateId).run();

    await mockVerifySuccess(reference, 'buyer-of-suspended-mid@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'buyer-of-suspended-mid@example.com')));

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM affiliate_commissions WHERE affiliate_id = ?`).bind(affiliateId).first<any>();
    expect(count.n).toBe(0);

    // The purchase itself still succeeded normally.
    const session = await env.DB.prepare(`SELECT status FROM purchase_sessions WHERE purchase_reference = ?`).bind(reference).first<any>();
    expect(session.status).toBe('verified');
  });

  it('a coupon applied at the same checkout reduces the commission base: commission is calculated on the actual post-coupon amount paid, never the pre-discount price', async () => {
    await seedApprovedAffiliate('coupon-plus-affiliate@example.com', 'RWLCOUPONAFF', 20);
    await seedCoupon({ code: 'AFFCOUPON10', discountType: 'percentage', discountValue: 10 });

    const reference = await checkoutWithRef('RWLCOUPONAFF', 'coupon-affiliate-buyer@example.com', undefined, { couponCode: 'AFFCOUPON10' });

    const session = await env.DB.prepare(`SELECT amount_pesewas AS amountPesewas, discount_pesewas AS discountPesewas FROM purchase_sessions WHERE purchase_reference = ?`).bind(reference).first<any>();
    expect(session.discountPesewas).toBe(390); // 10% of 3900
    expect(session.amountPesewas).toBe(3510); // the actual amount now due

    await mockVerifySuccess(reference, 'coupon-affiliate-buyer@example.com', 3510);
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'coupon-affiliate-buyer@example.com', 3510)));

    const commission = await env.DB.prepare(
      `SELECT gross_pesewas AS gross, commission_pesewas AS amount FROM affiliate_commissions WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`
    )
      .bind(reference)
      .first<any>();
    expect(commission.gross).toBe(3510); // post-coupon amount, never the pre-discount 3900
    expect(commission.amount).toBe(702); // 20% of 3510, not 20% of 3900 (which would be 780)
  });

  it('changing an affiliate\'s default rate AFTER checkout never alters a commission whose rate was already snapshotted', async () => {
    const { affiliateId } = await seedApprovedAffiliate('rate-change-affiliate@example.com', 'RWLRATECHANGE', 20);

    const reference = await checkoutWithRef('RWLRATECHANGE', 'rate-change-buyer@example.com');
    // Rate changes between checkout (where 20% was locked onto the purchase session) and verification.
    await env.DB.prepare(`UPDATE affiliates SET default_commission_percent = 50 WHERE id = ?`).bind(affiliateId).run();

    await mockVerifySuccess(reference, 'rate-change-buyer@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'rate-change-buyer@example.com')));

    const commission = await env.DB.prepare(`SELECT commission_percent AS pct, commission_pesewas AS amount FROM affiliate_commissions WHERE affiliate_id = ?`).bind(affiliateId).first<any>();
    expect(commission.pct).toBe(20); // the rate snapshotted at checkout, not the later 50%
    expect(commission.amount).toBe(780); // 20% of 3900, not 50%
  });

  it('a checkout typed under a decoy email, but paid through Paystack under the affiliate\'s own account, is blocked by the authoritative check even though the softer checkout-time email heuristic let it through', async () => {
    // commerceService.ts's createCheckoutSession() trims+lowercases the
    // TYPED checkout email before resolveAffiliateForCheckout() ever sees
    // it, so a mere whitespace/case variation on the typed email can never
    // slip past that heuristic; both sides normalize identically. The
    // REAL divergence this codebase has to guard against is different: the
    // email typed at OUR checkout form (what the soft heuristic checks)
    // is not necessarily the email Paystack itself reports back at
    // verification (what findOrCreateCustomer(), and so the authoritative
    // customer_id check, actually uses). An affiliate can type any
    // decoy email at checkout (passing the soft filter) and still pay
    // with their own Paystack-linked account, whose verify response
    // reports their real, own email. This proves the customer_id check
    // in recordCommission() is the one that actually matters.
    await seedApprovedAffiliate('paystack-real-email@example.com', 'RWLDECOYEMAIL');

    const reference = await checkoutWithRef('RWLDECOYEMAIL', 'totally-different-decoy@example.com');
    // The soft heuristic did not block it: attribution was still recorded at checkout,
    // because the decoy email typed at checkout does not match the affiliate's account email.
    const session = await env.DB.prepare(`SELECT affiliate_id AS affiliateId FROM purchase_sessions WHERE purchase_reference = ?`).bind(reference).first<any>();
    expect(session.affiliateId).toBeTruthy();

    // Paystack's own verify response reports the affiliate's REAL account email;
    // exactly what happens if they pay with their own Paystack-linked payment method.
    await mockVerifySuccess(reference, 'paystack-real-email@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'paystack-real-email@example.com')));

    // The authoritative customer_id check at verification time still blocks it.
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM affiliate_commissions WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`).bind(reference).first<any>();
    expect(count.n).toBe(0);
  });

  it('a product-specific commission rate overrides the affiliate default', async () => {
    const { affiliateId } = await seedApprovedAffiliate('product-rate-affiliate@example.com', 'RWLPRODRATE', 20);
    const productRow = await env.DB.prepare(`SELECT id FROM products WHERE slug = ?`).bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
    const adminInsert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES ('rate-admin@example.com', 'x:1:x', 'super_admin', 1)`).run();
    await env.DB.prepare(`INSERT INTO affiliate_product_rates (affiliate_id, product_id, commission_percent, set_by, data_classification) VALUES (?, ?, 40, ?, 'PRODUCTION')`)
      .bind(affiliateId, productRow!.id, Number(adminInsert.meta.last_row_id))
      .run();

    const reference = await checkoutWithRef('RWLPRODRATE', 'buyer-product-rate@example.com');
    await mockVerifySuccess(reference, 'buyer-product-rate@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'buyer-product-rate@example.com')));

    const commission = await env.DB.prepare(`SELECT commission_percent AS pct FROM affiliate_commissions WHERE affiliate_id = ?`).bind(affiliateId).first<any>();
    expect(commission.pct).toBe(40); // overridden rate, not the 20% default
  });
});

describe('Refund/cancellation reversal', () => {
  it('revoking a purchase (refund) reverses its associated commission and records why', async () => {
    await seedApprovedAffiliate('refund-affiliate@example.com', 'RWLREFUND');
    const reference = await checkoutWithRef('RWLREFUND', 'refund-buyer@example.com');
    await mockVerifySuccess(reference, 'refund-buyer@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'refund-buyer@example.com')));

    let commission = await env.DB.prepare(`SELECT status FROM affiliate_commissions WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`).bind(reference).first<any>();
    expect(commission.status).toBe('pending');

    const logger = createLogger('test-request-id', 'test.revoke');
    const result = await revokePurchase(env as any, logger, reference, 'refund');
    expect(result.ok).toBe(true);

    commission = await env.DB.prepare(`SELECT status, reversed_reason AS reason FROM affiliate_commissions WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`).bind(reference).first<any>();
    expect(commission.status).toBe('reversed');
    expect(commission.reason).toBe('Order refunded');
  });

  it('reversing a purchase with no attributed affiliate is a safe no-op', async () => {
    const reference = await checkoutWithRef(null, 'no-affiliate-refund@example.com');
    await mockVerifySuccess(reference, 'no-affiliate-refund@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'no-affiliate-refund@example.com')));

    const logger = createLogger('test-request-id', 'test.revoke');
    const result = await revokePurchase(env as any, logger, reference, 'refund');
    expect(result.ok).toBe(true); // does not throw or fail just because there's nothing to reverse
  });

  it('a commission already marked paid is never reversed by a refund event', async () => {
    await seedApprovedAffiliate('paid-then-refund@example.com', 'RWLPAIDREFUND');
    const reference = await checkoutWithRef('RWLPAIDREFUND', 'paid-refund-buyer@example.com');
    await mockVerifySuccess(reference, 'paid-refund-buyer@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'paid-refund-buyer@example.com')));

    await env.DB.prepare(`UPDATE affiliate_commissions SET status = 'paid', paid_at = datetime('now') WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`).bind(reference).run();

    const logger = createLogger('test-request-id', 'test.revoke');
    await revokePurchase(env as any, logger, reference, 'refund');

    const commission = await env.DB.prepare(`SELECT status FROM affiliate_commissions WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`).bind(reference).first<any>();
    expect(commission.status).toBe('paid'); // unchanged: never automatically clawed back
  });
});

describe('Manual commission adjustment: the one path outside the normal lifecycle', () => {
  async function seedAdmin(): Promise<number> {
    const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', 'super_admin', 1)`)
      .bind(`adjust-admin-${Math.random().toString(36).slice(2)}@example.com`)
      .run();
    return Number(insert.meta.last_row_id);
  }

  it('refuses an adjustment with no reason, or a reason too short to be meaningful', async () => {
    await seedApprovedAffiliate('adjust-blank-reason@example.com', 'RWLADJUSTBLANK');
    const reference = await checkoutWithRef('RWLADJUSTBLANK', 'adjust-blank-buyer@example.com');
    await mockVerifySuccess(reference, 'adjust-blank-buyer@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'adjust-blank-buyer@example.com')));

    const commission = await env.DB.prepare(`SELECT id FROM affiliate_commissions WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`).bind(reference).first<any>();
    const adminId = await seedAdmin();
    const logger = createLogger('test-request-id', 'test.adjust');

    const blank = await adjustCommission(env as any, logger, adminId, commission.id, { reason: '', newCommissionPesewas: 100 });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.reason).toBe('invalid_input');

    const tooShort = await adjustCommission(env as any, logger, adminId, commission.id, { reason: 'oops', newCommissionPesewas: 100 });
    expect(tooShort.ok).toBe(false);
  });

  it('a valid adjustment changes the amount, and records both the before and after values in audit_logs', async () => {
    await seedApprovedAffiliate('adjust-valid@example.com', 'RWLADJUSTVALID');
    const reference = await checkoutWithRef('RWLADJUSTVALID', 'adjust-valid-buyer@example.com');
    await mockVerifySuccess(reference, 'adjust-valid-buyer@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'adjust-valid-buyer@example.com')));

    const commission = await env.DB.prepare(`SELECT id, commission_pesewas AS amount FROM affiliate_commissions WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`).bind(reference).first<any>();
    expect(commission.amount).toBe(780); // 20% of 3900, before adjustment

    const adminId = await seedAdmin();
    const logger = createLogger('test-request-id', 'test.adjust');
    const result = await adjustCommission(env as any, logger, adminId, commission.id, { newCommissionPesewas: 500, reason: 'Partial refund negotiated outside the platform' });
    expect(result.ok).toBe(true);

    const updated = await env.DB.prepare(`SELECT commission_pesewas AS amount, adjustment_note AS note FROM affiliate_commissions WHERE id = ?`).bind(commission.id).first<any>();
    expect(updated.amount).toBe(500);
    expect(updated.note).toBe('Partial refund negotiated outside the platform');

    const audit = await env.DB.prepare(`SELECT actor_type AS actorType, actor_id AS actorId, metadata FROM audit_logs WHERE entity_type = 'affiliate_commission' AND entity_id = ? AND action = 'affiliate.commission_adjusted'`)
      .bind(commission.id)
      .first<any>();
    expect(audit.actorType).toBe('admin');
    expect(audit.actorId).toBe(adminId);
    const metadata = JSON.parse(audit.metadata);
    expect(metadata.reason).toBe('Partial refund negotiated outside the platform');
    expect(metadata.before.commissionPesewas).toBe(780);
    expect(metadata.after.commissionPesewas).toBe(500);
  });
});
