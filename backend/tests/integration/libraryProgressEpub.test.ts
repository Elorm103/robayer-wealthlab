/**
 * Integration test: Digital Library 2.0 — EPUB progress over the real
 * HTTP route (POST/GET /api/customer/purchases/:reference/progress),
 * not just the service layer. Closes the gap Phase 9C.5 explicitly
 * deferred (EPUB resume was localStorage-only, never surviving a
 * different device/browser) by reusing the existing PDF progress
 * endpoint rather than building a second one — this test proves the
 * real route correctly accepts EPUB's {cfi, percentComplete} shape
 * alongside PDF's existing {currentPage, totalPages} shape.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession } from '../../services/customer/sessionService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG, TEST_ASSET_ID } from '../helpers';

const EPUB_ASSET_ID = 'asset-test-guide-epub-v1';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM library_progress');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);

  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('test-guide.epub', 'test-guide.epub', 'application/epub+zip', 2048, 'beadfeed2', 'ebooks/test-guide.epub', 'https://example.com/test-guide.epub', 'document', 'books', 'ready')`
  ).run();
  const mediaId = Number(mediaInsert.meta.last_row_id);
  const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
  await env.DB.prepare(`INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status) VALUES (?, ?, ?, 'Test Guide (EPUB)', 'EPUB', 'published')`)
    .bind(productRow!.id, EPUB_ASSET_ID, mediaId)
    .run();
});

async function seedCustomerWithEpubPurchase(email: string, reference: string): Promise<{ cookieHeader: string }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const session = await createSession(env as any, customerId, { ip: null, userAgent: null });

  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, expires_at)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', ?, datetime('now', '+30 minutes'))`
  )
    .bind(reference, TEST_PRODUCT_SLUG, customerId)
    .run();
  const purchaseSessionId = Number(insert.meta.last_row_id);
  await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) VALUES (?, ?, ?, 10, 0, 'delivered')`)
    .bind(purchaseSessionId, EPUB_ASSET_ID, TEST_PRODUCT_SLUG)
    .run();
  // Also grant the PDF asset, matching a real dual-format purchase — proves the two formats' progress rows never collide.
  await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) VALUES (?, ?, ?, 10, 0, 'delivered')`)
    .bind(purchaseSessionId, TEST_ASSET_ID, TEST_PRODUCT_SLUG)
    .run();

  return { cookieHeader: `customer_session=${session.sessionToken}` };
}

describe('POST/GET /api/customer/purchases/:reference/progress — EPUB', () => {
  it('accepts {cfi, percentComplete}, and a later GET (simulating a different device/browser) resumes from it — the real cross-device gain over localStorage-only', async () => {
    const { cookieHeader } = await seedCustomerWithEpubPurchase('epub-progress@example.com', 'RWL-2026-910001');

    const cfi = 'epubcfi(/6/14!/4/2/1:0)';
    const postRes = await SELF.fetch('https://example.com/api/customer/purchases/RWL-2026-910001/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ assetId: EPUB_ASSET_ID, cfi, percentComplete: 42 }),
    });
    const postBody = await postRes.json<any>();
    expect(postRes.status).toBe(200);
    expect(postBody.success).toBe(true);
    expect(postBody.data.format).toBe('EPUB');
    expect(postBody.data.cfi).toBe(cfi);
    expect(postBody.data.percentComplete).toBe(42);

    // A fresh GET with no client-side state at all (a genuinely new
    // browser/device would have no localStorage entry) still resumes
    // correctly, purely from the server.
    const getRes = await SELF.fetch(
      `https://example.com/api/customer/purchases/RWL-2026-910001/progress?assetId=${encodeURIComponent(EPUB_ASSET_ID)}`,
      { headers: { Cookie: cookieHeader } }
    );
    const getBody = await getRes.json<any>();
    expect(getRes.status).toBe(200);
    expect(getBody.data.progress.cfi).toBe(cfi);
    expect(getBody.data.progress.format).toBe('EPUB');
  });

  it("a PDF asset's progress and an EPUB asset's progress on the same purchase never collide", async () => {
    const { cookieHeader } = await seedCustomerWithEpubPurchase('dual-format-progress@example.com', 'RWL-2026-910002');

    await SELF.fetch('https://example.com/api/customer/purchases/RWL-2026-910002/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ assetId: TEST_ASSET_ID, currentPage: 10, totalPages: 40 }),
    });
    await SELF.fetch('https://example.com/api/customer/purchases/RWL-2026-910002/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ assetId: EPUB_ASSET_ID, cfi: 'epubcfi(/6/8!/4/2/1:0)', percentComplete: 15 }),
    });

    const pdfRes = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-910002/progress?assetId=${encodeURIComponent(TEST_ASSET_ID)}`, { headers: { Cookie: cookieHeader } });
    const pdfBody = await pdfRes.json<any>();
    expect(pdfBody.data.progress.format).toBe('PDF');
    expect(pdfBody.data.progress.currentPage).toBe(10);

    const epubRes = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-910002/progress?assetId=${encodeURIComponent(EPUB_ASSET_ID)}`, { headers: { Cookie: cookieHeader } });
    const epubBody = await epubRes.json<any>();
    expect(epubBody.data.progress.format).toBe('EPUB');
    expect(epubBody.data.progress.percentComplete).toBe(15);
  });

  it('rejects a request missing both {cfi, percentComplete} and {currentPage, totalPages}', async () => {
    const { cookieHeader } = await seedCustomerWithEpubPurchase('malformed-progress@example.com', 'RWL-2026-910003');
    const res = await SELF.fetch('https://example.com/api/customer/purchases/RWL-2026-910003/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ assetId: EPUB_ASSET_ID }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/purchases/RWL-2026-910004/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: EPUB_ASSET_ID, cfi: 'epubcfi(/6/2!/4)', percentComplete: 5 }),
    });
    expect(res.status).toBe(401);
  });
});
