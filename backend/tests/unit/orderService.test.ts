/**
 * Unit tests: order artifact creation - Version 3.0.2 Milestone M2.
 * Exercises createOrderArtifacts() directly against a real D1
 * instance, independent of the full webhook flow (that end-to-end
 * path is covered separately in tests/integration/orders.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createOrderArtifacts } from '../../services/orders/orderService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');

beforeEach(async () => {
  await env.DB.exec('DELETE FROM receipt_download_tokens');
  await env.DB.exec('DELETE FROM receipts');
  await env.DB.exec('DELETE FROM licenses');
  await env.DB.exec('DELETE FROM order_items');
  await env.DB.exec('DELETE FROM purchase_sessions');
});

async function seedPurchaseSession(overrides: { amountPesewas?: number } = {}): Promise<number> {
  const amountPesewas = overrides.amountPesewas ?? 3900;
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at)
     VALUES (?, 'test-guide', 'prod-test-guide', 'Test Guide', ?, 'GHS', 'verified', datetime('now', '+30 minutes'))`
  )
    .bind(`RWL-2026-${Math.floor(Math.random() * 900000 + 100000)}`, amountPesewas)
    .run();
  return Number(insert.meta.last_row_id);
}

describe('createOrderArtifacts', () => {
  it('creates one order_items row, one license, and one receipt whose total matches the charged amount', async () => {
    const purchaseSessionId = await seedPurchaseSession({ amountPesewas: 3900 });

    const result = await createOrderArtifacts(env as any, logger, {
      purchaseSessionId,
      productId: 'prod-test-guide',
      productTitle: 'Test Guide',
      amountPesewas: 3900,
      currency: 'GHS',
      taxBehavior: 'inclusive',
      licenseTermsVersion: 'v1.0',
      customerId: null,
    });

    expect(result).not.toBeNull();
    expect(result!.licenseIds.length).toBe(1);

    const orderItem = await env.DB.prepare('SELECT quantity, unit_price_pesewas AS unitPricePesewas FROM order_items WHERE id = ?').bind(result!.orderItemId).first<any>();
    expect(orderItem.quantity).toBe(1);
    expect(orderItem.unitPricePesewas).toBe(3900);

    const receipt = await env.DB.prepare('SELECT total_pesewas AS totalPesewas, subtotal_pesewas AS subtotalPesewas, receipt_number AS receiptNumber FROM receipts WHERE id = ?')
      .bind(result!.receiptId)
      .first<any>();
    expect(receipt.totalPesewas).toBe(3900);
    expect(receipt.subtotalPesewas).toBe(3900);
    expect(receipt.receiptNumber).toMatch(/^RWL-RCT-\d{4}-\d{6,}$/);
  });

  it('creates N independent licenses for quantity = N, each with a distinct license_key (ADR-009)', async () => {
    const purchaseSessionId = await seedPurchaseSession({ amountPesewas: 7800 });

    const result = await createOrderArtifacts(env as any, logger, {
      purchaseSessionId,
      productId: 'prod-test-guide',
      productTitle: 'Test Guide',
      amountPesewas: 7800,
      currency: 'GHS',
      taxBehavior: 'inclusive',
      licenseTermsVersion: 'v1.0',
      customerId: null,
      quantity: 2,
    });

    expect(result!.licenseIds.length).toBe(2);

    const { results: licenseKeys } = await env.DB.prepare('SELECT license_key AS licenseKey FROM licenses WHERE purchase_session_id = ?')
      .bind(purchaseSessionId)
      .all<{ licenseKey: string }>();
    expect(licenseKeys.length).toBe(2);
    expect(new Set(licenseKeys.map((r) => r.licenseKey)).size).toBe(2); // genuinely distinct, not a duplicate insert
  });

  it('M2C MAR closeout: a receipt line-item total never drifts from the charged amount for a quantity that does not divide evenly (rounding edge case)', async () => {
    // 10000 / 3 = 3333.33... — the old implementation computed
    // lineTotalPesewas as Math.round(10000/3) * 3 = 3333 * 3 = 9999,
    // one pesewa short of the actual 10000 charged. This test seeds
    // exactly that non-evenly-divisible case.
    const purchaseSessionId = await seedPurchaseSession({ amountPesewas: 10000 });

    const result = await createOrderArtifacts(env as any, logger, {
      purchaseSessionId,
      productId: 'prod-test-guide',
      productTitle: 'Test Guide',
      amountPesewas: 10000,
      currency: 'GHS',
      taxBehavior: 'inclusive',
      licenseTermsVersion: 'v1.0',
      customerId: null,
      quantity: 3,
    });

    const receipt = await env.DB.prepare('SELECT line_items AS lineItems, subtotal_pesewas AS subtotalPesewas, total_pesewas AS totalPesewas FROM receipts WHERE id = ?')
      .bind(result!.receiptId)
      .first<any>();

    const lineItems = JSON.parse(receipt.lineItems);
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0].lineTotalPesewas).toBe(10000); // exact, never 9999
    expect(lineItems[0].lineTotalPesewas).toBe(receipt.subtotalPesewas);
    expect(lineItems[0].lineTotalPesewas).toBe(receipt.totalPesewas);
  });

  it('never leaves receipt_number NULL after completion, and never collides under concurrent creation for two different purchases', async () => {
    const sessionA = await seedPurchaseSession();
    const sessionB = await seedPurchaseSession();

    const [resultA, resultB] = await Promise.all([
      createOrderArtifacts(env as any, logger, {
        purchaseSessionId: sessionA,
        productId: 'prod-test-guide',
        productTitle: 'Test Guide',
        amountPesewas: 3900,
        currency: 'GHS',
        taxBehavior: 'inclusive',
        licenseTermsVersion: 'v1.0',
        customerId: null,
      }),
      createOrderArtifacts(env as any, logger, {
        purchaseSessionId: sessionB,
        productId: 'prod-test-guide',
        productTitle: 'Test Guide',
        amountPesewas: 3900,
        currency: 'GHS',
        taxBehavior: 'inclusive',
        licenseTermsVersion: 'v1.0',
        customerId: null,
      }),
    ]);

    expect(resultA!.receiptNumber).not.toBe(resultB!.receiptNumber);
    const { results } = await env.DB.prepare('SELECT receipt_number AS receiptNumber FROM receipts WHERE receipt_number IS NULL').all();
    expect(results.length).toBe(0);
  });
});
