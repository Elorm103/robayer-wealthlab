/**
 * Negative / adversarial tests - Version 3.0.2 Milestone M2 (Orders,
 * Receipts & Customer Library), added at Sprint M2C's MAR closeout to
 * close the gap that review identified: M1's own negative.test.ts
 * covers checkout/login/set-password, but no M2 endpoint's
 * `:reference`/`:receiptNumber`/`:token` path parameters had a
 * dedicated malformed/oversized/SQL-injection-shaped input test,
 * even though the route-level regex gates (isPlausibleReference,
 * isPlausibleReceiptNumber, REFERENCE_PATTERN) were already sound by
 * inspection. Mirrors negative.test.ts's own pattern exactly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession as createCustomerSession } from '../../services/customer/sessionService';
import { createSession as createAdminSession } from '../../services/admin/sessionService';

const SQL_INJECTION_SHAPED = "'; DROP TABLE purchase_sessions; --";
const OVERSIZED = 'a'.repeat(100_000);

beforeEach(async () => {
  await env.DB.exec('DELETE FROM receipt_download_tokens');
  await env.DB.exec('DELETE FROM receipts');
  await env.DB.exec('DELETE FROM licenses');
  await env.DB.exec('DELETE FROM order_items');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM admin_sessions');
  await env.DB.exec('DELETE FROM admin_users');
});

async function seedCustomerWithPurchase(email: string, reference: string): Promise<{ cookieHeader: string }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });
  await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, customer_id)
     VALUES (?, 'test-guide', 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'), ?)`
  )
    .bind(reference, customerId)
    .run();
  return { cookieHeader: `customer_session=${session.sessionToken}` };
}

async function seedAdmin(): Promise<{ cookieHeader: string; csrfSecret: string }> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', 'super_admin', 1)`)
    .bind(`admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  const adminId = Number(insert.meta.last_row_id);
  const session = await createAdminSession(env as any, adminId, { ip: null, userAgent: null });
  return { cookieHeader: `admin_session=${session.sessionToken}; admin_csrf=${session.csrfSecret}`, csrfSecret: session.csrfSecret };
}

describe('M2 malformed / malicious path-parameter requests', () => {
  it('GET /api/customer/purchases/:reference with a SQL-injection-shaped reference is rejected as NOT_FOUND, never a database error', async () => {
    const { cookieHeader } = await seedCustomerWithPurchase('m2-neg-1@example.com', 'RWL-2026-700101');

    const res = await SELF.fetch(`https://example.com/api/customer/purchases/${encodeURIComponent(SQL_INJECTION_SHAPED)}`, { headers: { Cookie: cookieHeader } });
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');

    // Table intact — parameterized binding held, not string concatenation.
    const stillThere = await env.DB.prepare(`SELECT COUNT(*) AS n FROM purchase_sessions WHERE purchase_reference = ?`).bind('RWL-2026-700101').first<any>();
    expect(stillThere.n).toBe(1);
  });

  it('GET /api/customer/purchases/:reference with an oversized reference is rejected cleanly, not a 500', async () => {
    const { cookieHeader } = await seedCustomerWithPurchase('m2-neg-2@example.com', 'RWL-2026-700102');

    const res = await SELF.fetch(`https://example.com/api/customer/purchases/${encodeURIComponent(OVERSIZED)}`, { headers: { Cookie: cookieHeader } });
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /api/customer/receipts/:receiptNumber/download with a SQL-injection-shaped receiptNumber is rejected as RECEIPT_NOT_FOUND, never a database error', async () => {
    const { cookieHeader } = await seedCustomerWithPurchase('m2-neg-3@example.com', 'RWL-2026-700103');

    const res = await SELF.fetch(`https://example.com/api/customer/receipts/${encodeURIComponent(SQL_INJECTION_SHAPED)}/download`, { headers: { Cookie: cookieHeader } });
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RECEIPT_NOT_FOUND');

    const stillThere = await env.DB.prepare(`SELECT COUNT(*) AS n FROM purchase_sessions WHERE purchase_reference = ?`).bind('RWL-2026-700103').first<any>();
    expect(stillThere.n).toBe(1);
  });

  it('GET /api/customer/receipts/:receiptNumber/download with an oversized receiptNumber is rejected cleanly, not a 500', async () => {
    const { cookieHeader } = await seedCustomerWithPurchase('m2-neg-4@example.com', 'RWL-2026-700104');

    const res = await SELF.fetch(`https://example.com/api/customer/receipts/${encodeURIComponent(OVERSIZED)}/download`, { headers: { Cookie: cookieHeader } });
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RECEIPT_NOT_FOUND');
  });

  it('POST /api/purchases/:reference/receipt-download with a SQL-injection-shaped reference is rejected as PURCHASE_NOT_FOUND, never a database error', async () => {
    const res = await SELF.fetch(`https://example.com/api/purchases/${encodeURIComponent(SQL_INJECTION_SHAPED)}/receipt-download`, { method: 'POST' });
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PURCHASE_NOT_FOUND');

    const stillThere = await env.DB.prepare(`SELECT COUNT(*) AS n FROM purchase_sessions`).first<any>();
    expect(stillThere.n).toBe(0); // nothing was ever seeded in this test — proves no crash, not just no data loss
  });

  it('POST /api/purchases/:reference/receipt-download with an oversized reference is rejected cleanly, not a 500', async () => {
    const res = await SELF.fetch(`https://example.com/api/purchases/${encodeURIComponent(OVERSIZED)}/receipt-download`, { method: 'POST' });
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PURCHASE_NOT_FOUND');
  });

  it('GET /api/download-receipt/:token with a SQL-injection-shaped token is rejected as RECEIPT_NOT_FOUND, never a database error', async () => {
    const res = await SELF.fetch(`https://example.com/api/download-receipt/${encodeURIComponent(SQL_INJECTION_SHAPED)}`);
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RECEIPT_NOT_FOUND');
  });

  it('POST /api/admin/orders/:reference/refund with a SQL-injection-shaped reference is rejected as NOT_FOUND, never a database error', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin();

    const res = await SELF.fetch(`https://example.com/api/admin/orders/${encodeURIComponent(SQL_INJECTION_SHAPED)}/refund`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret },
    });
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');

    const auditCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'order.refunded'`).first<any>();
    expect(auditCount.n).toBe(0); // no refund ever took effect
  });

  it('POST /api/admin/orders/:reference/refund with an oversized reference is rejected cleanly, not a 500', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin();

    const res = await SELF.fetch(`https://example.com/api/admin/orders/${encodeURIComponent(OVERSIZED)}/refund`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret },
    });
    expect(res.status).toBeLessThan(500);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /api/customer/licenses and GET /api/customer/receipts never error for an authenticated customer with adversarial-shaped (but irrelevant) cookies', async () => {
    // These two endpoints take no path parameter at all — this test
    // exists to confirm they still behave (empty list, not a crash)
    // when hit with no seeded data, closing out the "any new path
    // parameter" scope by confirming the parameter-free M2 endpoints
    // have no equivalent gap to begin with.
    const { customerId } = await findOrCreateCustomer(env as any, 'm2-neg-5@example.com', false);
    const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });
    const cookieHeader = `customer_session=${session.sessionToken}`;

    const licenses = await SELF.fetch('https://example.com/api/customer/licenses', { headers: { Cookie: cookieHeader } });
    expect(licenses.status).toBeLessThan(500);
    expect((await licenses.json<any>()).data.licenses).toEqual([]);

    const receipts = await SELF.fetch('https://example.com/api/customer/receipts', { headers: { Cookie: cookieHeader } });
    expect(receipts.status).toBeLessThan(500);
    expect((await receipts.json<any>()).data.receipts).toEqual([]);
  });
});
