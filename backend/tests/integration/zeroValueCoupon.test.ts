/**
 * Integration tests: Free Redemption (100% coupon) — the GREEN-rated,
 * narrowly-scoped implementation added to commerceService.ts's
 * createCheckoutSession(). Proves the zero-value branch (triggered only
 * when the server's own amountPesewas === 0) reuses
 * completeVerifiedPurchase() unmodified — same customer provisioning,
 * order/license/receipt/delivery creation, and Library entitlement a
 * real Paystack-verified purchase gets — while never contacting
 * Paystack, and proves every other amount (95%-discount, full price)
 * is completely unaffected and still goes through the existing
 * Paystack flow exactly as before.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { queueInitializeResponse, queueVerifyResponse } from '../outboundMock';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG, TEST_ASSET_ID } from '../helpers';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession as createCustomerSession } from '../../services/customer/sessionService';
import { generateDownloadPermission, redeemDownloadToken } from '../../services/entitlementService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');

beforeEach(async () => {
  // Same FK-safe delete order established by affiliateCommission.test.ts
  // and couponReceiptPipeline.test.ts (both exercise this exact schema
  // neighborhood already).
  await env.DB.exec('DELETE FROM affiliate_commissions');
  await env.DB.exec('DELETE FROM affiliate_clicks');
  await env.DB.exec('DELETE FROM download_tokens');
  await env.DB.exec('DELETE FROM receipt_download_tokens');
  await env.DB.exec('DELETE FROM receipts');
  await env.DB.exec('DELETE FROM licenses');
  await env.DB.exec('DELETE FROM order_items');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM payment_transactions');
  await env.DB.exec('DELETE FROM review_reminder_attempts');
  await env.DB.exec('DELETE FROM purchase_followup_attempts');
  await env.DB.exec('DELETE FROM coupon_redemptions');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM coupons');
  await env.DB.exec('DELETE FROM affiliate_product_rates');
  await env.DB.exec('DELETE FROM affiliates');
  await env.DB.exec('DELETE FROM email_log');
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM customer_password_tokens');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any); // price: 3900 pesewas, one published PDF asset (TEST_ASSET_ID)
  await env.RATE_LIMIT_KV.delete('ratelimit:checkout:unknown');
  // A queued 'paystack_initialize' trap response (used to prove the
  // zero-value branch never calls Paystack) is only ever consumed if
  // Paystack actually gets called — by design, the zero-value tests
  // never consume it. Without this, it would leak into a LATER test in
  // this same file that legitimately does call Paystack (e.g. the
  // 95%-discount/full-price tests), wrongly failing their real
  // initialize call. outboundMock.ts's own queue is otherwise "take
  // once," so this is the one key this file must reset itself.
  await env.DB.exec("DELETE FROM test_mock_responses WHERE key = 'paystack_initialize'");
});

async function seedAdmin(): Promise<number> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role) VALUES (?, 'x:1:x', 'super_admin')`)
    .bind(`admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedCoupon(overrides: Partial<{ code: string; discountValue: number; maxRedemptions: number | null }> = {}): Promise<number> {
  const adminId = await seedAdmin();
  const insert = await env.DB.prepare(
    `INSERT INTO coupons (code, discount_type, discount_value, max_redemptions, status, created_by) VALUES (?, 'percentage', ?, ?, 'active', ?)`
  )
    .bind(overrides.code ?? 'FREE100', overrides.discountValue ?? 100, overrides.maxRedemptions ?? null, adminId)
    .run();
  return Number(insert.meta.last_row_id);
}

async function checkout(body: Record<string, unknown>): Promise<any> {
  const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, ...body }),
  });
  return res.json<any>();
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

async function sessionRow(reference: string): Promise<any> {
  return env.DB.prepare(
    `SELECT id, status, amount_pesewas AS amountPesewas, discount_pesewas AS discountPesewas, provider_status AS providerStatus,
            checkout_url AS checkoutUrl, provider_reference AS providerReference, customer_id AS customerId, customer_email AS customerEmail
     FROM purchase_sessions WHERE purchase_reference = ?`
  )
    .bind(reference)
    .first<any>();
}

describe('Free Redemption (100% coupon) — zero-value branch', () => {
  it('1+2. produces amountPesewas=0 and never contacts Paystack — a queued Paystack failure is never consumed', async () => {
    await seedCoupon({ code: 'FREE100A' });
    // If the zero-value branch ever accidentally called Paystack, this
    // queued failure would be consumed and the checkout would fail with
    // PAYSTACK_API_ERROR instead of succeeding.
    await queueInitializeResponse(env as any, { status: false, message: 'Paystack must never be called for a zero-value checkout' });

    const body = await checkout({ email: 'free-buyer-1@example.com', couponCode: 'FREE100A' });
    expect(body.success).toBe(true);
    expect(body.data.checkoutUrl).toBe(`https://robayerwealthlab.com/checkout/callback/?ref=${encodeURIComponent(body.data.purchaseReference)}`);
    expect(body.data.checkoutUrl).not.toContain('paystack');

    const session = await sessionRow(body.data.purchaseReference);
    expect(session.amountPesewas).toBe(0);
    expect(session.discountPesewas).toBe(3900);
  });

  it('3. reaches the verified state, with provider_status honestly recorded as zero_value, never Paystack\'s own "success" vocabulary', async () => {
    await seedCoupon({ code: 'FREE100B' });
    const body = await checkout({ email: 'free-buyer-2@example.com', couponCode: 'FREE100B' });
    const session = await sessionRow(body.data.purchaseReference);
    expect(session.status).toBe('verified');
    expect(session.providerStatus).toBe('zero_value');
    expect(session.providerReference).toBeNull();
  });

  it('4. provisions a real customer, exactly like a paid purchase', async () => {
    await seedCoupon({ code: 'FREE100C' });
    const body = await checkout({ email: 'free-buyer-3@example.com', couponCode: 'FREE100C' });
    const session = await sessionRow(body.data.purchaseReference);
    expect(session.customerId).not.toBeNull();
    expect(session.customerEmail).toBe('free-buyer-3@example.com');

    const customer = await env.DB.prepare('SELECT email FROM customers WHERE id = ?').bind(session.customerId).first<any>();
    expect(customer.email).toBe('free-buyer-3@example.com');
  });

  it('5. creates order_items, a license, and a receipt', async () => {
    await seedCoupon({ code: 'FREE100D' });
    const body = await checkout({ email: 'free-buyer-4@example.com', couponCode: 'FREE100D' });
    const session = await sessionRow(body.data.purchaseReference);

    const orderItem = await env.DB.prepare('SELECT unit_price_pesewas AS unitPricePesewas FROM order_items WHERE purchase_session_id = ?').bind(session.id).first<any>();
    expect(orderItem).toBeTruthy();
    expect(orderItem.unitPricePesewas).toBe(3900); // original pre-discount price recovered, matching the paid-path receipt convention

    const license = await env.DB.prepare('SELECT license_key AS licenseKey FROM licenses WHERE purchase_session_id = ?').bind(session.id).first<any>();
    expect(license.licenseKey).toBeTruthy();

    const receipt = await env.DB.prepare(
      'SELECT subtotal_pesewas AS subtotalPesewas, discount_pesewas AS discountPesewas, total_pesewas AS totalPesewas FROM receipts WHERE purchase_session_id = ?'
    )
      .bind(session.id)
      .first<any>();
    expect(receipt.subtotalPesewas).toBe(3900);
    expect(receipt.discountPesewas).toBe(3900);
    expect(receipt.totalPesewas).toBe(0);
  });

  it('6. creates a delivery (entitlement) for every published digital asset', async () => {
    await seedCoupon({ code: 'FREE100E' });
    const body = await checkout({ email: 'free-buyer-5@example.com', couponCode: 'FREE100E' });
    const session = await sessionRow(body.data.purchaseReference);

    const deliveries = await env.DB.prepare('SELECT asset_id AS assetId, status FROM deliveries WHERE purchase_session_id = ?').bind(session.id).all<any>();
    expect(deliveries.results.length).toBe(1); // seedTestProduct() publishes exactly one asset
    expect(deliveries.results[0].assetId).toBe(TEST_ASSET_ID);
    expect(deliveries.results[0].status).toBe('delivered');
  });

  it('7. appears in My Library for the provisioned customer, with status "ready"', async () => {
    await seedCoupon({ code: 'FREE100F' });
    const body = await checkout({ email: 'free-buyer-6@example.com', couponCode: 'FREE100F' });
    const session = await sessionRow(body.data.purchaseReference);

    const customerSession = await createCustomerSession(env as any, session.customerId, { ip: null, userAgent: null });
    const res = await SELF.fetch('https://example.com/api/customer/purchases', {
      headers: { Cookie: `customer_session=${customerSession.sessionToken}` },
    });
    const listBody = await res.json<any>();
    expect(listBody.success).toBe(true);
    const purchase = listBody.data.purchases.find((p: any) => p.purchaseReference === body.data.purchaseReference);
    expect(purchase).toBeTruthy();
    expect(purchase.status).toBe('ready');
    expect(purchase.assets.length).toBe(1);
    expect(purchase.assets[0].revoked).toBe(false);
  });

  it('8+9. grants Read (view) entitlement, and reading never increases downloads_used', async () => {
    await seedCoupon({ code: 'FREE100G' });
    const body = await checkout({ email: 'free-buyer-7@example.com', couponCode: 'FREE100G' });
    const reference = body.data.purchaseReference;

    const before = await env.DB.prepare('SELECT downloads_used AS downloadsUsed FROM deliveries WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)').bind(reference).first<any>();
    expect(before.downloadsUsed).toBe(0);

    const viewPermission = await generateDownloadPermission(env as any, logger, reference, TEST_ASSET_ID, 'view');
    expect(viewPermission.granted).toBe(true);
    if (!viewPermission.granted) return;
    const viewRedeemed = await redeemDownloadToken(env as any, logger, viewPermission.token);
    expect(viewRedeemed.ok).toBe(true);

    const after = await env.DB.prepare('SELECT downloads_used AS downloadsUsed, last_viewed_at AS lastViewedAt FROM deliveries WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)').bind(reference).first<any>();
    expect(after.downloadsUsed).toBe(0);
    expect(after.lastViewedAt).toBeTruthy();
  });

  it('10+11. grants Download entitlement, increments downloads_used, and existing download limits still apply', async () => {
    await seedCoupon({ code: 'FREE100H' });
    const body = await checkout({ email: 'free-buyer-8@example.com', couponCode: 'FREE100H' });
    const reference = body.data.purchaseReference;
    const deliveryRow = await env.DB.prepare('SELECT id, max_downloads AS maxDownloads FROM deliveries WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)').bind(reference).first<any>();

    // First download succeeds and increments downloads_used.
    const download1 = await generateDownloadPermission(env as any, logger, reference, TEST_ASSET_ID, 'download');
    expect(download1.granted).toBe(true);
    if (download1.granted) await redeemDownloadToken(env as any, logger, download1.token);

    const afterOne = await env.DB.prepare('SELECT downloads_used AS downloadsUsed FROM deliveries WHERE id = ?').bind(deliveryRow.id).first<any>();
    expect(afterOne.downloadsUsed).toBe(1);

    // Exhaust the product's own real, unmodified download policy (whatever seedTestProduct's default max_downloads is) — force it to exactly 1 remaining, then confirm a further download is denied while view remains available, exactly like entitlementService.test.ts already proves for a paid purchase.
    await env.DB.prepare('UPDATE deliveries SET max_downloads = 1 WHERE id = ?').bind(deliveryRow.id).run();
    const download2 = await generateDownloadPermission(env as any, logger, reference, TEST_ASSET_ID, 'download');
    expect(download2.granted).toBe(false);
    if (!download2.granted) expect(download2.reason).toBe('download_limit_reached');

    const viewStillWorks = await generateDownloadPermission(env as any, logger, reference, TEST_ASSET_ID, 'view');
    expect(viewStillWorks.granted).toBe(true);
  });

  it('12. records coupon redemption correctly, and the coupon cannot be redeemed beyond its own max_redemptions', async () => {
    await seedCoupon({ code: 'FREE100I', maxRedemptions: 1 });
    const first = await checkout({ email: 'free-buyer-9a@example.com', couponCode: 'FREE100I' });
    expect(first.success).toBe(true);

    const redemption = await env.DB.prepare(
      'SELECT discount_pesewas AS discountPesewas FROM coupon_redemptions WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)'
    )
      .bind(first.data.purchaseReference)
      .first<any>();
    expect(redemption.discountPesewas).toBe(3900);

    const couponRow = await env.DB.prepare('SELECT redemptions_count AS redemptionsCount FROM coupons WHERE code = ?').bind('FREE100I').first<any>();
    expect(couponRow.redemptionsCount).toBe(1);

    // A second attempt with the same, now-exhausted coupon is rejected by the existing, unmodified validateCoupon() gate — never reaches the zero-value branch at all.
    const second = await checkout({ email: 'free-buyer-9b@example.com', couponCode: 'FREE100I' });
    expect(second.success).toBe(false);
    expect(second.error.code).toBe('COUPON_INVALID');
  });

  it('15. does not change affiliate commission policy — a $0 commission row is still created exactly as the unmodified completeVerifiedPurchase() already does for any attributed sale', async () => {
    const { customerId: affiliateCustomerId } = await findOrCreateCustomer(env as any, 'zero-value-affiliate@example.com', false);
    const affiliateInsert = await env.DB.prepare(
      `INSERT INTO affiliates (customer_id, affiliate_code, status, default_commission_percent, data_classification) VALUES (?, 'RWLZEROVALUE', 'approved', 20, 'PRODUCTION')`
    )
      .bind(affiliateCustomerId)
      .run();
    const affiliateId = Number(affiliateInsert.meta.last_row_id);

    await seedCoupon({ code: 'FREE100J' });
    const refCookieValue = `RWLZEROVALUE.${Math.floor(Date.now() / 1000)}`;
    const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `rwl_ref=${refCookieValue}` },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'zero-value-buyer@example.com', couponCode: 'FREE100J' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const session = await sessionRow(body.data.purchaseReference);
    expect(session.amountPesewas).toBe(0);

    // This documents CURRENT, UNCHANGED behavior — this implementation deliberately does not suppress it (see the follow-up policy note in the report).
    const commission = await env.DB.prepare('SELECT commission_pesewas AS commissionPesewas, gross_pesewas AS grossPesewas FROM affiliate_commissions WHERE affiliate_id = ? AND purchase_session_id = ?')
      .bind(affiliateId, session.id)
      .first<any>();
    expect(commission).toBeTruthy();
    expect(commission.grossPesewas).toBe(0);
    expect(commission.commissionPesewas).toBe(0);
  });
});

describe('Existing paid paths remain completely unchanged', () => {
  it('13. a 95%-discount coupon still goes through the real Paystack checkout+webhook flow, unaffected by the zero-value branch', async () => {
    await seedCoupon({ code: 'SAVE95', discountValue: 95 });
    const body = await checkout({ email: 'paid-95-buyer@example.com', couponCode: 'SAVE95' });
    expect(body.success).toBe(true);
    // A Paystack-shaped checkout URL (the mock's default), never the zero-value callback URL.
    expect(body.data.checkoutUrl).toBe('https://checkout.paystack.com/mock');

    const reference = body.data.purchaseReference;
    let session = await sessionRow(reference);
    expect(session.status).toBe('pending'); // still awaiting the real webhook, exactly as before this change
    expect(session.amountPesewas).toBe(195); // 5% of 3900, rounded

    await queueVerifyResponse(env as any, reference, {
      status: true,
      message: 'ok',
      data: {
        reference,
        amount: 195,
        currency: 'GHS',
        status: 'success',
        customer: { email: 'paid-95-buyer@example.com' },
        metadata: { purchaseReference: reference, productId: 'prod-test-guide', productSlug: TEST_PRODUCT_SLUG, productVersion: null },
      },
    });
    const webhookRes = await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'paid-95-buyer@example.com', 195)));
    expect((await webhookRes.json<any>()).success).toBe(true);

    session = await sessionRow(reference);
    expect(session.status).toBe('verified');
    expect(session.providerStatus).toBe('success'); // Paystack's own vocabulary, unchanged
  });

  it('14. a full-price purchase with no coupon still goes through the real Paystack checkout+webhook flow, unaffected by the zero-value branch', async () => {
    const body = await checkout({ email: 'full-price-buyer@example.com' });
    expect(body.success).toBe(true);
    expect(body.data.checkoutUrl).toBe('https://checkout.paystack.com/mock');

    const reference = body.data.purchaseReference;
    let session = await sessionRow(reference);
    expect(session.status).toBe('pending');
    expect(session.amountPesewas).toBe(3900);

    await queueVerifyResponse(env as any, reference, {
      status: true,
      message: 'ok',
      data: {
        reference,
        amount: 3900,
        currency: 'GHS',
        status: 'success',
        customer: { email: 'full-price-buyer@example.com' },
        metadata: { purchaseReference: reference, productId: 'prod-test-guide', productSlug: TEST_PRODUCT_SLUG, productVersion: null },
      },
    });
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'full-price-buyer@example.com', 3900)));

    session = await sessionRow(reference);
    expect(session.status).toBe('verified');
    expect(session.providerStatus).toBe('success');

    const receipt = await env.DB.prepare('SELECT total_pesewas AS totalPesewas FROM receipts WHERE purchase_session_id = ?').bind(session.id).first<any>();
    expect(receipt.totalPesewas).toBe(3900);
  });
});
