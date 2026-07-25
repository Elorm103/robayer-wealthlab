/**
 * Integration tests: customer purchase/receipt/license APIs -
 * Version 3.0.2 Milestone M2 (Orders, Receipts & Customer Library).
 * Exercises the Customer Library's data layer through the real Worker
 * fetch handler, with ownership enforcement as the central concern -
 * see docs/v3.0.2-m2-api-planning-report.md's Security review.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession } from '../../services/customer/sessionService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM receipt_download_tokens');
  await env.DB.exec('DELETE FROM receipts');
  await env.DB.exec('DELETE FROM licenses');
  await env.DB.exec('DELETE FROM order_items');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
});

async function seedCustomerWithPurchase(email: string, reference: string): Promise<{ customerId: number; cookieHeader: string }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const session = await createSession(env as any, customerId, { ip: null, userAgent: null });

  const purchaseInsert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, customer_id)
     VALUES (?, 'test-guide', 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'), ?)`
  )
    .bind(reference, customerId)
    .run();
  const purchaseSessionId = Number(purchaseInsert.meta.last_row_id);

  await env.DB.prepare(`INSERT INTO receipts (receipt_number, purchase_session_id, customer_id, line_items, subtotal_pesewas, total_pesewas, tax_behavior)
     VALUES (?, ?, ?, '[]', 3900, 3900, 'inclusive')`)
    .bind(`RWL-RCT-2026-${String(purchaseSessionId).padStart(6, '0')}`, purchaseSessionId, customerId)
    .run();

  await env.DB.prepare(`INSERT INTO licenses (purchase_session_id, product_id, customer_id, license_key) VALUES (?, 'prod-test-guide', ?, ?)`)
    .bind(purchaseSessionId, customerId, `key-${reference}`)
    .run();

  return { customerId, cookieHeader: `customer_session=${session.sessionToken}` };
}

describe('GET /api/customer/purchases', () => {
  it("returns only the authenticated customer's own purchases", async () => {
    const { cookieHeader } = await seedCustomerWithPurchase('owner@example.com', 'RWL-2026-600001');
    await seedCustomerWithPurchase('other@example.com', 'RWL-2026-600002');

    const res = await SELF.fetch('https://example.com/api/customer/purchases', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.purchases.length).toBe(1);
    expect(body.data.purchases[0].purchaseReference).toBe('RWL-2026-600001');
  });

  it('returns a clean empty array, not an error, for a customer with zero purchases', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'zero-purchases@example.com', false);
    const session = await createSession(env as any, customerId, { ip: null, userAgent: null });

    const res = await SELF.fetch('https://example.com/api/customer/purchases', { headers: { Cookie: `customer_session=${session.sessionToken}` } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.purchases).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/purchases');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/customer/purchases/:reference', () => {
  it("returns NOT_FOUND (not a distinct forbidden signal) for a reference belonging to a different customer", async () => {
    const { cookieHeader } = await seedCustomerWithPurchase('me@example.com', 'RWL-2026-600003');
    await seedCustomerWithPurchase('someone-else@example.com', 'RWL-2026-600004');

    const res = await SELF.fetch('https://example.com/api/customer/purchases/RWL-2026-600004', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(res.status).toBe(404);
  });

  it('returns the purchase for its real owner', async () => {
    const { cookieHeader } = await seedCustomerWithPurchase('genuine-owner@example.com', 'RWL-2026-600005');

    const res = await SELF.fetch('https://example.com/api/customer/purchases/RWL-2026-600005', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.purchaseReference).toBe('RWL-2026-600005');
  });
});

describe('GET /api/customer/receipts/:receiptNumber/download', () => {
  it("streams the PDF for the receipt's real owner", async () => {
    const { cookieHeader } = await seedCustomerWithPurchase('receipt-owner@example.com', 'RWL-2026-600006');
    const receipt = await env.DB.prepare('SELECT receipt_number AS receiptNumber FROM receipts WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)')
      .bind('RWL-2026-600006')
      .first<any>();

    const res = await SELF.fetch(`https://example.com/api/customer/receipts/${receipt.receiptNumber}/download`, { headers: { Cookie: cookieHeader } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('denies a different customer from downloading the receipt', async () => {
    await seedCustomerWithPurchase('real-owner@example.com', 'RWL-2026-600007');
    const { cookieHeader: otherCookie } = await seedCustomerWithPurchase('not-the-owner@example.com', 'RWL-2026-600008');
    const receipt = await env.DB.prepare('SELECT receipt_number AS receiptNumber FROM receipts WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = ?)')
      .bind('RWL-2026-600007')
      .first<any>();

    const res = await SELF.fetch(`https://example.com/api/customer/receipts/${receipt.receiptNumber}/download`, { headers: { Cookie: otherCookie } });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RECEIPT_NOT_FOUND');
  });
});

describe('GET /api/customer/licenses', () => {
  it("lists only the authenticated customer's own licenses", async () => {
    const { cookieHeader } = await seedCustomerWithPurchase('license-owner@example.com', 'RWL-2026-600009');

    const res = await SELF.fetch('https://example.com/api/customer/licenses', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.licenses.length).toBe(1);
    expect(body.data.licenses[0].status).toBe('active');
  });
});
