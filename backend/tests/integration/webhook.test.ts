/**
 * Integration tests: Paystack webhook -> payment verification ->
 * customer provisioning -> fulfilment — Version 3.0.2 Milestone M1.
 * This is the sprint's central "Paystack callback / payment
 * verification / customer provisioning / existing customer purchase"
 * requirement, exercised end to end through the real Worker fetch
 * handler with both the payment provider and Resend intercepted by
 * tests/outboundMock.ts's outboundService function — never a real
 * network call.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { queueVerifyResponse } from '../outboundMock';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM payment_transactions');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM email_log');
  await env.DB.exec('DELETE FROM customer_password_tokens');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

async function createPendingSession(marketingOptIn = false): Promise<string> {
  const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, marketingOptIn }),
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

async function mockPaystackVerifySuccess(reference: string, email: string, amountPesewas = 3900) {
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

describe('POST /api/webhooks/paystack — verification, provisioning, fulfilment', () => {
  it('rejects a webhook with an invalid signature and never touches purchase_sessions', async () => {
    const reference = await createPendingSession();
    const req = new Request('https://example.com/api/webhooks/paystack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': 'not-a-real-signature' },
      body: JSON.stringify(chargeSuccessPayload(reference, 'attacker@example.com')),
    });
    const res = await SELF.fetch(req);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_SIGNATURE');

    const row = await env.DB.prepare('SELECT status FROM purchase_sessions WHERE purchase_reference = ?').bind(reference).first<any>();
    expect(row.status).toBe('pending');
  });

  it('a first-ever purchase creates a new customer, sends the welcome email, and grants a download entitlement', async () => {
    const reference = await createPendingSession(true);
    await mockPaystackVerifySuccess(reference, 'first-time@example.com');

    const res = await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'first-time@example.com')));
    expect((await res.json<any>()).success).toBe(true);

    const session = await env.DB.prepare('SELECT status, customer_id FROM purchase_sessions WHERE purchase_reference = ?').bind(reference).first<any>();
    expect(session.status).toBe('verified');
    expect(session.customer_id).toBeTruthy();

    const customer = await env.DB.prepare('SELECT email FROM customers WHERE id = ?').bind(session.customer_id).first<any>();
    expect(customer.email).toBe('first-time@example.com');

    const profile = await env.DB.prepare('SELECT marketing_opt_in FROM customer_profiles WHERE customer_id = ?').bind(session.customer_id).first<any>();
    expect(profile.marketing_opt_in).toBe(1);

    const delivery = await env.DB.prepare('SELECT status FROM deliveries WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)')
      .bind(reference)
      .first<any>();
    expect(delivery.status).toBe('delivered');

    const welcomeEmail = await env.DB.prepare("SELECT id FROM email_log WHERE template = 'customer-welcome' AND entity_id = ?").bind(session.customer_id).first<any>();
    expect(welcomeEmail).toBeTruthy();
  });

  it('a second purchase under the same email reuses the existing customer and does NOT send a second welcome email', async () => {
    const ref1 = await createPendingSession();
    await mockPaystackVerifySuccess(ref1, 'returning@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(ref1, 'returning@example.com')));

    const first = await env.DB.prepare('SELECT customer_id FROM purchase_sessions WHERE purchase_reference = ?').bind(ref1).first<any>();

    const ref2 = await createPendingSession();
    await mockPaystackVerifySuccess(ref2, 'returning@example.com');
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(ref2, 'returning@example.com')));

    const second = await env.DB.prepare('SELECT customer_id FROM purchase_sessions WHERE purchase_reference = ?').bind(ref2).first<any>();
    expect(second.customer_id).toBe(first.customer_id);

    const customerCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM customers WHERE email = ?').bind('returning@example.com').first<any>();
    expect(customerCount.n).toBe(1);

    const welcomeEmailCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_log WHERE template = 'customer-welcome' AND entity_id = ?")
      .bind(first.customer_id)
      .first<any>();
    expect(welcomeEmailCount.n).toBe(1); // still just the one, from the first purchase
  });

  it('redelivering the identical webhook is idempotent — no duplicate transaction, no duplicate entitlement', async () => {
    const reference = await createPendingSession();
    await mockPaystackVerifySuccess(reference, 'idempotent@example.com');
    const req = await signedWebhookRequest(chargeSuccessPayload(reference, 'idempotent@example.com'));
    const rawBodyForReplay = await req.clone().text();

    await SELF.fetch(req);

    // Redeliver: same signature (computed over the same body), same reference.
    const replay = new Request('https://example.com/api/webhooks/paystack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': req.headers.get('x-paystack-signature')! },
      body: rawBodyForReplay,
    });
    const replayRes = await SELF.fetch(replay);
    expect((await replayRes.json<any>()).success).toBe(true); // webhooks always ack 200 once well-formed/signed — see routes/webhooks.ts

    const txCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM payment_transactions WHERE paystack_reference = ?').bind(reference).first<any>();
    expect(txCount.n).toBe(1);

    const deliveryCount = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM deliveries WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)'
    )
      .bind(reference)
      .first<any>();
    expect(deliveryCount.n).toBe(1);
  });

  it('charge.failed transitions the session to failed and never provisions a customer', async () => {
    const reference = await createPendingSession();
    const res = await SELF.fetch(
      await signedWebhookRequest({ event: 'charge.failed', data: { reference, amount: 3900, currency: 'GHS' } })
    );
    expect((await res.json<any>()).success).toBe(true);

    const session = await env.DB.prepare('SELECT status, customer_id FROM purchase_sessions WHERE purchase_reference = ?').bind(reference).first<any>();
    expect(session.status).toBe('failed');
    expect(session.customer_id).toBeNull();
  });

  it('an amount mismatch between the locked checkout price and the provider verify response is rejected, never verified', async () => {
    const reference = await createPendingSession();
    await mockPaystackVerifySuccess(reference, 'tamper@example.com', 999999); // wildly different from the locked 3900

    const res = await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'tamper@example.com', 999999)));
    expect((await res.json<any>()).success).toBe(true); // still 200-acked — see routes/webhooks.ts

    const session = await env.DB.prepare('SELECT status, customer_id FROM purchase_sessions WHERE purchase_reference = ?').bind(reference).first<any>();
    expect(session.status).toBe('failed');
    expect(session.customer_id).toBeNull();
  });

  it('an expired pending purchase is never verified, even with a genuinely successful payment', async () => {
    const reference = await createPendingSession();
    await env.DB.prepare("UPDATE purchase_sessions SET expires_at = datetime('now', '-1 hour') WHERE purchase_reference = ?").bind(reference).run();

    await mockPaystackVerifySuccess(reference, 'too-late@example.com');
    const res = await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'too-late@example.com')));
    expect((await res.json<any>()).success).toBe(true);

    const session = await env.DB.prepare('SELECT status FROM purchase_sessions WHERE purchase_reference = ?').bind(reference).first<any>();
    expect(session.status).toBe('expired');
  });
});
