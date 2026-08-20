/**
 * Integration tests: order artifacts created by a real webhook flow -
 * Version 3.0.2 Milestone M2. Extends the exact pattern
 * tests/integration/webhook.test.ts already established, verifying
 * that a genuinely verified purchase produces order_items, licenses,
 * and a receipt whose total matches the actual charged amount.
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
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_password_tokens');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

async function createPendingSession(): Promise<string> {
  const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email: 'order-buyer@example.com' }),
  });
  const body = await res.json<any>();
  return body.data.purchaseReference as string;
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

describe('Milestone M2 order artifacts, created via the real webhook flow', () => {
  it('a verified purchase produces one order_items row, one license, and a receipt whose total matches the charged amount', async () => {
    const reference = await createPendingSession();
    await mockVerifySuccess(reference, 'order-artifacts@example.com');
    const res = await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'order-artifacts@example.com')));
    expect((await res.json<any>()).success).toBe(true);

    const session = await env.DB.prepare('SELECT id, status, customer_id AS customerId FROM purchase_sessions WHERE purchase_reference = ?').bind(reference).first<any>();
    expect(session.status).toBe('verified');

    const orderItem = await env.DB.prepare('SELECT quantity, product_title AS productTitle FROM order_items WHERE purchase_session_id = ?').bind(session.id).first<any>();
    expect(orderItem).toBeTruthy();
    expect(orderItem.quantity).toBe(1);
    expect(orderItem.productTitle).toBe('Test Guide');

    const licenseCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM licenses WHERE purchase_session_id = ?').bind(session.id).first<any>();
    expect(licenseCount.n).toBe(1);

    const receipt = await env.DB.prepare('SELECT total_pesewas AS totalPesewas, customer_id AS customerId, receipt_number AS receiptNumber FROM receipts WHERE purchase_session_id = ?')
      .bind(session.id)
      .first<any>();
    expect(receipt.totalPesewas).toBe(3900);
    expect(receipt.customerId).toBe(session.customerId);
    expect(receipt.receiptNumber).toMatch(/^RWL-RCT-\d{4}-\d{6,}$/);
  });

  it('GET /api/purchases/:reference now includes the issued receiptNumber', async () => {
    const reference = await createPendingSession();
    await mockVerifySuccess(reference, 'status-receipt@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'status-receipt@example.com')));

    const res = await SELF.fetch(`https://example.com/api/purchases/${reference}`);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ready');
    expect(body.data.receiptNumber).toMatch(/^RWL-RCT-\d{4}-\d{6,}$/);
  });

  it('order-artifact creation never blocks fulfilment - the download entitlement still gets created even if inspected independently', async () => {
    const reference = await createPendingSession();
    await mockVerifySuccess(reference, 'fulfilment-unaffected@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'fulfilment-unaffected@example.com')));

    const delivery = await env.DB.prepare(
      `SELECT status FROM deliveries WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`
    )
      .bind(reference)
      .first<any>();
    expect(delivery.status).toBe('delivered');
  });
});
