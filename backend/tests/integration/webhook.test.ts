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
import { queueVerifyResponse, queueMetaEventsResponse, queueMetaEventsResponseStickyOverride, clearMetaEventsResponseStickyOverride } from '../outboundMock';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

beforeEach(async () => {
  // Milestone M2 (Orders, Receipts & Customer Library) — every real
  // charge.success webhook now also creates order_items/licenses/
  // receipts as a side effect (see commerceService.ts's
  // createOrderArtifacts() call), so this pre-existing M1 test file's
  // own cleanup must clear those too, in dependency order, before
  // purchase_sessions itself.
  await env.DB.exec('DELETE FROM receipt_download_tokens');
  await env.DB.exec('DELETE FROM receipts');
  await env.DB.exec('DELETE FROM licenses');
  await env.DB.exec('DELETE FROM order_items');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM payment_transactions');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM email_log');
  await env.DB.exec('DELETE FROM customer_password_tokens');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  // Version 5.0 (Customer Acquisition Phase 1) — completeVerifiedPurchase()
  // now also dispatches a server-side Purchase conversion event; see
  // this file's own new test below.
  await env.DB.exec('DELETE FROM analytics_conversion_log');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
  // Only set for these tests so dispatchServerEvent() actually attempts
  // a send (metaProvider.isConfigured() gates on this being truthy) —
  // real production sets this via `wrangler secret put`, never here.
  (env as unknown as { META_CAPI_ACCESS_TOKEN: string }).META_CAPI_ACCESS_TOKEN = 'test-meta-access-token';
});

async function createPendingSession(marketingOptIn = false): Promise<string> {
  const res = await SELF.fetch('https://example.com/api/checkout/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // email — Version 3.4.3 Milestone M6.3 made this a required field
    // on the real checkout endpoint (routes/checkout.ts); this helper
    // predates that and was never updated, which silently broke every
    // test in this file before this fix (checkout itself now rejects
    // with VALIDATION_ERROR, so body.data was always undefined).
    body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, marketingOptIn, email: 'checkout-init@example.com' }),
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

  // Version 5.0 (Customer Acquisition Phase 1, Phase 7 Conversions
  // API) — the one server-side conversion event this phase fires,
  // dispatched from the exact same completeVerifiedPurchase() call
  // site as fulfilment above (services/commerceService.ts).
  it('a verified purchase dispatches a server-side Purchase conversion event with a deterministic, dedup-ready event_id', async () => {
    await queueMetaEventsResponse(env as any, { status: 200, body: { events_received: 1, fbtrace_id: 'test-fbtrace-id' } });

    const reference = await createPendingSession();
    await mockPaystackVerifySuccess(reference, 'conversion-test@example.com');
    const res = await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'conversion-test@example.com')));
    expect((await res.json<any>()).success).toBe(true);

    const row = await env.DB.prepare(
      `SELECT provider, event_name, event_id, status, provider_trace_id, request_payload FROM analytics_conversion_log WHERE event_name = 'Purchase' AND entity_type = 'purchase_session'`
    ).first<any>();

    expect(row).toBeTruthy();
    expect(row.provider).toBe('meta');
    expect(row.status).toBe('sent');
    expect(row.event_id).toBe(`purchase:${reference}`);
    expect(row.provider_trace_id).toBe('test-fbtrace-id');

    // The exact fields Phase 3 requires the Purchase event to carry —
    // and confirms raw email was never persisted (only its hash, via
    // userData.emailHash — see hashing.ts's own header comment).
    const payload = JSON.parse(row.request_payload);
    expect(payload.customData.value).toBe('39.00');
    expect(payload.customData.currency).toBe('GHS');
    expect(payload.customData.transaction_id).toBe(reference);
    expect(payload.customData.content_ids).toEqual([TEST_PRODUCT_SLUG]);
    expect(JSON.stringify(payload)).not.toContain('conversion-test@example.com');
  });

  it('a Meta Conversions API failure never blocks or undoes the purchase — fulfilment still succeeds and the failure is logged for retry', async () => {
    // Sticky, not one-shot: dispatchServerEvent() itself retries once
    // inline (services/analytics/conversionDispatchService.ts's own
    // RETRY_MAX_ATTEMPTS) — a one-shot queued response would only
    // cover the first of those two attempts, and the second would then
    // see the mock's default success, silently defeating this test.
    await queueMetaEventsResponseStickyOverride(env as any, { status: 500, body: { error: { message: 'temporary outage' } } });

    const reference = await createPendingSession();
    await mockPaystackVerifySuccess(reference, 'capi-outage@example.com');
    const res = await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'capi-outage@example.com')));
    expect((await res.json<any>()).success).toBe(true);
    await clearMetaEventsResponseStickyOverride(env as any);

    const session = await env.DB.prepare('SELECT status FROM purchase_sessions WHERE purchase_reference = ?').bind(reference).first<any>();
    expect(session.status).toBe('verified');

    const delivery = await env.DB.prepare('SELECT status FROM deliveries WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)')
      .bind(reference)
      .first<any>();
    expect(delivery.status).toBe('delivered');

    const row = await env.DB.prepare(`SELECT status, attempt_count FROM analytics_conversion_log WHERE event_name = 'Purchase'`).first<any>();
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(2); // exhausted dispatchServerEvent()'s own inline retry budget — eligible for the next cron sweep
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
