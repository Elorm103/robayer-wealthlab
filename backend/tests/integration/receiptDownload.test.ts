/**
 * Integration tests: guest, reference-scoped receipt download -
 * Version 3.0.2 Milestone M2 (Orders, Receipts & Customer Library).
 * ADR-013 tier 2 - a real action (downloading a file), so it needs
 * its own single-use token even with no customer session.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM receipt_download_tokens');
  await env.DB.exec('DELETE FROM receipts');
  await env.DB.exec('DELETE FROM purchase_sessions');
});

async function seedVerifiedPurchaseWithReceipt(reference: string): Promise<void> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at)
     VALUES (?, 'test-guide', 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'))`
  )
    .bind(reference)
    .run();
  const purchaseSessionId = Number(insert.meta.last_row_id);
  await env.DB.prepare(`INSERT INTO receipts (receipt_number, purchase_session_id, line_items, subtotal_pesewas, total_pesewas, tax_behavior)
     VALUES (?, ?, '[]', 3900, 3900, 'inclusive')`)
    .bind(`RWL-RCT-2026-${String(purchaseSessionId).padStart(6, '0')}`, purchaseSessionId)
    .run();
}

describe('guest receipt download (mint then redeem)', () => {
  it('mints a token and redeems it exactly once', async () => {
    await seedVerifiedPurchaseWithReceipt('RWL-2026-700001');

    const mintRes = await SELF.fetch('https://example.com/api/purchases/RWL-2026-700001/receipt-download', { method: 'POST' });
    const mintBody = await mintRes.json<any>();
    expect(mintBody.success).toBe(true);
    expect(mintBody.data.downloadUrl).toMatch(/^\/api\/download-receipt\//);

    const firstDownload = await SELF.fetch(`https://example.com${mintBody.data.downloadUrl}`);
    expect(firstDownload.status).toBe(200);
    expect(firstDownload.headers.get('Content-Type')).toBe('application/pdf');

    const secondDownload = await SELF.fetch(`https://example.com${mintBody.data.downloadUrl}`);
    const secondBody = await secondDownload.json<any>();
    expect(secondBody.success).toBe(false);
    expect(secondBody.error.code).toBe('RECEIPT_NOT_FOUND');
  });

  it('rejects minting a token for a reference with no issued receipt', async () => {
    const res = await SELF.fetch('https://example.com/api/purchases/RWL-2026-999999/receipt-download', { method: 'POST' });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RECEIPT_NOT_FOUND');
  });

  it('rejects a garbage token at the redeem endpoint without touching the database in a way that errors', async () => {
    const res = await SELF.fetch('https://example.com/api/download-receipt/not-a-real-token');
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RECEIPT_NOT_FOUND');
  });
});
