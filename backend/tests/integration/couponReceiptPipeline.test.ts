/**
 * Integration test: the full coupon financial pipeline, end to end -
 * Version 3.2 Milestone M4 (Reviews & Coupons), added at M4E closeout.
 *
 * Closes the gap M4D's independent Testing Assessment identified: the
 * discount→receipt→PDF arithmetic was unit-tested in isolation
 * (orderService.test.ts, receiptPdfService.test.ts) during this same
 * closeout sprint, but no single test exercised the entire chain the
 * sprint brief itself named - Coupon -> Checkout -> Purchase Session
 * -> Webhook -> Receipt -> Receipt PDF -> Customer Download - through
 * real HTTP calls only, the way a genuine purchase actually happens.
 * This file is that test.
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

async function seedCoupon(): Promise<void> {
  const adminId = await seedAdmin();
  await env.DB.prepare(
    `INSERT INTO coupons (code, discount_type, discount_value, status, created_by) VALUES ('PIPELINE10', 'percentage', 10, 'active', ?)`
  )
    .bind(adminId)
    .run();
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

/**
 * Same decompression approach as receiptPdfService.test.ts's own
 * helper (see that file's header comment for the full explanation of
 * why raw-byte text search doesn't work against pdf-lib's compressed
 * output) - duplicated here rather than imported, matching this
 * codebase's established per-file test-helper convention.
 */
async function extractDecompressedText(bytes: Uint8Array): Promise<string> {
  const raw = new TextDecoder('latin1').decode(bytes);
  const chunks: string[] = [];
  let searchFrom = 0;

  while (true) {
    const streamIdx = raw.indexOf('stream', searchFrom);
    if (streamIdx === -1) break;
    const endIdx = raw.indexOf('endstream', streamIdx);
    if (endIdx === -1) break;

    let dataStart = streamIdx + 'stream'.length;
    if (raw[dataStart] === '\r') dataStart++;
    if (raw[dataStart] === '\n') dataStart++;
    let dataEnd = endIdx;
    if (raw[dataEnd - 1] === '\n') dataEnd--;
    if (raw[dataEnd - 1] === '\r') dataEnd--;

    try {
      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      writer.write(bytes.slice(dataStart, dataEnd));
      writer.close();
      const buf = new Uint8Array(await new Response(ds.readable).arrayBuffer());
      chunks.push(new TextDecoder('latin1').decode(buf));
    } catch {
      // Not a Flate-compressed stream this helper can read - skip it.
    }
    searchFrom = endIdx + 'endstream'.length;
  }

  const joined = chunks.join('\n');
  const hexDecoded: string[] = [];
  for (const match of joined.matchAll(/<([0-9A-Fa-f]{2,})>/g)) {
    const hex = match[1];
    if (hex.length % 2 !== 0) continue;
    let ascii = '';
    for (let i = 0; i < hex.length; i += 2) ascii += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    hexDecoded.push(ascii);
  }
  return joined + '\n' + hexDecoded.join('\n');
}

describe('Full financial pipeline: Coupon -> Checkout -> Purchase Session -> Webhook -> Receipt -> Receipt PDF -> Customer Download', () => {
  it('a coupon-discounted purchase produces a receipt and a downloadable PDF that both correctly reflect the discount', async () => {
    await seedCoupon();

    // Coupon -> Checkout: the real HTTP endpoint, with a real coupon code.
    const checkoutRes = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true, couponCode: 'PIPELINE10' }),
    });
    const checkoutBody = await checkoutRes.json<any>();
    expect(checkoutBody.success).toBe(true);
    const reference = checkoutBody.data.purchaseReference as string;

    // -> Purchase Session: the discounted amount is locked, confirmed directly.
    const session = await env.DB.prepare('SELECT amount_pesewas AS amountPesewas, discount_pesewas AS discountPesewas FROM purchase_sessions WHERE purchase_reference = ?')
      .bind(reference)
      .first<any>();
    expect(session.discountPesewas).toBe(390); // 10% of 3900
    expect(session.amountPesewas).toBe(3510);

    // -> Webhook: a real, signed charge.success delivery, verified against the locked, discounted amount.
    await queueVerifyResponse(env as any, reference, {
      status: true,
      message: 'ok',
      data: {
        reference,
        amount: 3510,
        currency: 'GHS',
        status: 'success',
        customer: { email: 'pipeline-buyer@example.com' },
        metadata: { purchaseReference: reference, productId: 'prod-test-guide', productSlug: TEST_PRODUCT_SLUG, productVersion: null },
      },
    });
    const webhookRes = await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'pipeline-buyer@example.com', 3510)));
    expect((await webhookRes.json<any>()).success).toBe(true);

    const verifiedSession = await env.DB.prepare('SELECT status FROM purchase_sessions WHERE purchase_reference = ?').bind(reference).first<any>();
    expect(verifiedSession.status).toBe('verified');

    // -> Receipt: created as a side effect of the webhook (createOrderArtifacts()), never hand-inserted by this test.
    const receipt = await env.DB.prepare(
      `SELECT receipt_number AS receiptNumber, subtotal_pesewas AS subtotalPesewas, discount_pesewas AS discountPesewas, total_pesewas AS totalPesewas
       FROM receipts WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`
    )
      .bind(reference)
      .first<any>();
    expect(receipt).toBeTruthy();
    expect(receipt.subtotalPesewas).toBe(3900); // original, pre-discount price recovered
    expect(receipt.discountPesewas).toBe(390);
    expect(receipt.totalPesewas).toBe(3510); // actual charged amount, unchanged invariant

    // Coupon redemption also recorded as a side effect of the same webhook.
    const redemption = await env.DB.prepare(
      `SELECT discount_pesewas AS discountPesewas FROM coupon_redemptions WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`
    )
      .bind(reference)
      .first<any>();
    expect(redemption.discountPesewas).toBe(390);

    // -> Receipt PDF -> Customer Download: the real guest mint-then-redeem
    // flow (no customer session needed), generating the PDF on-demand,
    // exactly as a real customer's download click would.
    const mintRes = await SELF.fetch(`https://example.com/api/purchases/${reference}/receipt-download`, { method: 'POST' });
    const mintBody = await mintRes.json<any>();
    expect(mintBody.success).toBe(true);

    const downloadRes = await SELF.fetch(`https://example.com${mintBody.data.downloadUrl}`);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('Content-Type')).toBe('application/pdf');

    const pdfBytes = new Uint8Array(await downloadRes.arrayBuffer());
    expect(new TextDecoder('latin1').decode(pdfBytes.slice(0, 5))).toBe('%PDF-');

    const pdfText = await extractDecompressedText(pdfBytes);
    expect(pdfText).toContain(receipt.receiptNumber);
    expect(pdfText).toContain('Discount: -GHS 3.90');
    expect(pdfText).toContain('Total: GHS 35.10');
  });

  it('an ordinary, non-coupon purchase produces a receipt and PDF with no discount line anywhere in the pipeline', async () => {
    const checkoutRes = await SELF.fetch('https://example.com/api/checkout/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: TEST_PRODUCT_SLUG, termsAccepted: true, licenseAccepted: true }),
    });
    const checkoutBody = await checkoutRes.json<any>();
    const reference = checkoutBody.data.purchaseReference as string;

    await queueVerifyResponse(env as any, reference, {
      status: true,
      message: 'ok',
      data: {
        reference,
        amount: 3900,
        currency: 'GHS',
        status: 'success',
        customer: { email: 'no-coupon-buyer@example.com' },
        metadata: { purchaseReference: reference, productId: 'prod-test-guide', productSlug: TEST_PRODUCT_SLUG, productVersion: null },
      },
    });
    await SELF.fetch(await signedWebhookRequest(chargeSuccessPayload(reference, 'no-coupon-buyer@example.com', 3900)));

    const receipt = await env.DB.prepare(
      `SELECT discount_pesewas AS discountPesewas, subtotal_pesewas AS subtotalPesewas, total_pesewas AS totalPesewas
       FROM receipts WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)`
    )
      .bind(reference)
      .first<any>();
    expect(receipt.discountPesewas).toBe(0);
    expect(receipt.subtotalPesewas).toBe(3900);
    expect(receipt.totalPesewas).toBe(3900);

    const mintRes = await SELF.fetch(`https://example.com/api/purchases/${reference}/receipt-download`, { method: 'POST' });
    const mintBody = await mintRes.json<any>();
    const downloadRes = await SELF.fetch(`https://example.com${mintBody.data.downloadUrl}`);
    const pdfBytes = new Uint8Array(await downloadRes.arrayBuffer());
    const pdfText = await extractDecompressedText(pdfBytes);
    expect(pdfText).not.toContain('Discount:');
    expect(pdfText).toContain('Subtotal: GHS 39.00');
  });
});
