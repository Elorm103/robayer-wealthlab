/**
 * Integration tests: forensic-audit fix (2026-08-28) — every row
 * created by a real checkout/webhook flow must be classified
 * (PRODUCTION/DEVELOPMENT) at insert time from the configured
 * Paystack key mode, instead of silently defaulting to migration
 * 0028's 'UNKNOWN' forever. See database/migrations/
 * 0047_data_classification_backfill_v2.sql's header comment for the
 * incident this closes (the Executive Dashboard's default "Production
 * Only" Analytics Mode showed GH0.00/0 orders despite real revenue,
 * because no new row was ever classified PRODUCTION).
 *
 * The test environment's PAYSTACK_SECRET_KEY (.dev.vars) is a
 * sk_test_ key, so every row created here is expected to land as
 * DEVELOPMENT — proving the classification is actually being derived
 * from the key, not hardcoded or left at the old UNKNOWN default.
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

async function createPendingSession(email: string): Promise<string> {
  const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, email }),
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

describe('data_classification is stamped at insert time, not left UNKNOWN', () => {
  it('a brand-new checkout session is classified from the configured Paystack key mode immediately, before any payment completes', async () => {
    const reference = await createPendingSession('classification-pending@example.com');
    const session = await env.DB.prepare('SELECT data_classification AS cls FROM purchase_sessions WHERE purchase_reference = ?').bind(reference).first<any>();
    // The test harness's PAYSTACK_SECRET_KEY is sk_test_ — proves this
    // is genuinely derived from the key, not hardcoded to PRODUCTION.
    expect(session.cls).toBe('DEVELOPMENT');
    expect(session.cls).not.toBe('UNKNOWN');
  });

  it('a verified purchase propagates the SAME classification to every child row — customer, payment_transactions, order_items, licenses, receipts, deliveries', async () => {
    const email = 'classification-verified@example.com';
    const reference = await createPendingSession(email);
    await mockVerifySuccess(reference, email);
    const res = await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, email)));
    expect((await res.json<any>()).success).toBe(true);

    const session = await env.DB.prepare(
      'SELECT id, customer_id AS customerId, data_classification AS cls FROM purchase_sessions WHERE purchase_reference = ?'
    )
      .bind(reference)
      .first<any>();
    expect(session.cls).toBe('DEVELOPMENT');

    const customer = await env.DB.prepare('SELECT data_classification AS cls FROM customers WHERE id = ?').bind(session.customerId).first<any>();
    expect(customer.cls).toBe('DEVELOPMENT');

    const profile = await env.DB.prepare('SELECT data_classification AS cls FROM customer_profiles WHERE customer_id = ?').bind(session.customerId).first<any>();
    expect(profile.cls).toBe('DEVELOPMENT');

    const paymentTxn = await env.DB.prepare('SELECT data_classification AS cls FROM payment_transactions WHERE purchase_session_id = ?').bind(session.id).first<any>();
    expect(paymentTxn.cls).toBe('DEVELOPMENT');

    const orderItem = await env.DB.prepare('SELECT data_classification AS cls FROM order_items WHERE purchase_session_id = ?').bind(session.id).first<any>();
    expect(orderItem.cls).toBe('DEVELOPMENT');

    const license = await env.DB.prepare('SELECT data_classification AS cls FROM licenses WHERE purchase_session_id = ?').bind(session.id).first<any>();
    expect(license.cls).toBe('DEVELOPMENT');

    const receipt = await env.DB.prepare('SELECT data_classification AS cls FROM receipts WHERE purchase_session_id = ?').bind(session.id).first<any>();
    expect(receipt.cls).toBe('DEVELOPMENT');

    const delivery = await env.DB.prepare('SELECT data_classification AS cls FROM deliveries WHERE purchase_session_id = ?').bind(session.id).first<any>();
    expect(delivery.cls).toBe('DEVELOPMENT');
  });

  it('a live-key transaction is classified PRODUCTION, not DEVELOPMENT (proves the branch is live/test-sensitive, not hardcoded)', async () => {
    const original = env.PAYSTACK_SECRET_KEY;
    (env as any).PAYSTACK_SECRET_KEY = 'sk_live_test_only_never_a_real_key';
    try {
      const reference = await createPendingSession('classification-live-key@example.com');
      const session = await env.DB.prepare('SELECT data_classification AS cls FROM purchase_sessions WHERE purchase_reference = ?').bind(reference).first<any>();
      expect(session.cls).toBe('PRODUCTION');
    } finally {
      (env as any).PAYSTACK_SECRET_KEY = original;
    }
  });
});
