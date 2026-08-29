/**
 * Integration test: Digital Library 2.0 — Bookmarks over the real HTTP
 * routes (POST/GET /api/customer/purchases/:reference/bookmarks,
 * GET /api/customer/bookmarks, DELETE /api/customer/bookmarks/:id).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession } from '../../services/customer/sessionService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG, TEST_ASSET_ID } from '../helpers';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM library_bookmarks');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

async function seedCustomerWithPurchase(email: string, reference: string): Promise<{ cookieHeader: string }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const session = await createSession(env as any, customerId, { ip: null, userAgent: null });
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, expires_at)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', ?, datetime('now', '+30 minutes'))`
  )
    .bind(reference, TEST_PRODUCT_SLUG, customerId)
    .run();
  await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) VALUES (?, ?, ?, 10, 0, 'delivered')`)
    .bind(Number(insert.meta.last_row_id), TEST_ASSET_ID, TEST_PRODUCT_SLUG)
    .run();
  return { cookieHeader: `customer_session=${session.sessionToken}` };
}

describe('Bookmarks — real HTTP routes', () => {
  it('creates, lists (per-asset and library-wide), and deletes a real bookmark end to end', async () => {
    const { cookieHeader } = await seedCustomerWithPurchase('bookmark-http@example.com', 'RWL-2026-930001');

    const createRes = await SELF.fetch('https://example.com/api/customer/purchases/RWL-2026-930001/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ assetId: TEST_ASSET_ID, pageNumber: 7, label: 'Key formula' }),
    });
    expect(createRes.status).toBe(201);
    const createBody = await createRes.json<any>();
    expect(createBody.data.pageNumber).toBe(7);
    const bookmarkId = createBody.data.id;

    const perAssetRes = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-930001/bookmarks?assetId=${encodeURIComponent(TEST_ASSET_ID)}`, {
      headers: { Cookie: cookieHeader },
    });
    const perAssetBody = await perAssetRes.json<any>();
    expect(perAssetBody.data.bookmarks).toHaveLength(1);

    const allRes = await SELF.fetch('https://example.com/api/customer/bookmarks', { headers: { Cookie: cookieHeader } });
    const allBody = await allRes.json<any>();
    expect(allBody.data.bookmarks).toHaveLength(1);
    expect(allBody.data.bookmarks[0].label).toBe('Key formula');

    const deleteRes = await SELF.fetch(`https://example.com/api/customer/bookmarks/${bookmarkId}`, {
      method: 'DELETE',
      headers: { Cookie: cookieHeader },
    });
    expect(deleteRes.status).toBe(200);

    const afterDeleteRes = await SELF.fetch('https://example.com/api/customer/bookmarks', { headers: { Cookie: cookieHeader } });
    const afterDeleteBody = await afterDeleteRes.json<any>();
    expect(afterDeleteBody.data.bookmarks).toHaveLength(0);
  });

  it("a customer cannot delete another customer's bookmark", async () => {
    const owner = await seedCustomerWithPurchase('bookmark-owner@example.com', 'RWL-2026-930002');
    const attacker = await findOrCreateCustomer(env as any, 'bookmark-attacker@example.com', false);
    const attackerSession = await createSession(env as any, attacker.customerId, { ip: null, userAgent: null });

    const createRes = await SELF.fetch('https://example.com/api/customer/purchases/RWL-2026-930002/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.cookieHeader },
      body: JSON.stringify({ assetId: TEST_ASSET_ID, pageNumber: 3, label: null }),
    });
    const bookmarkId = (await createRes.json<any>()).data.id;

    const deleteRes = await SELF.fetch(`https://example.com/api/customer/bookmarks/${bookmarkId}`, {
      method: 'DELETE',
      headers: { Cookie: `customer_session=${attackerSession.sessionToken}` },
    });
    expect(deleteRes.status).toBe(404);

    const stillThereRes = await SELF.fetch('https://example.com/api/customer/bookmarks', { headers: { Cookie: owner.cookieHeader } });
    expect((await stillThereRes.json<any>()).data.bookmarks).toHaveLength(1);
  });

  it('rejects an unauthenticated bookmark creation', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/purchases/RWL-2026-930003/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: TEST_ASSET_ID, pageNumber: 1, label: null }),
    });
    expect(res.status).toBe(401);
  });
});
