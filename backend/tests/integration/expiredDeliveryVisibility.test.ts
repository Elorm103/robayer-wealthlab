/**
 * Integration tests: access-window (access_expires_at) display gap.
 *
 * Found during a live production smoke test: a real delivery whose
 * access_expires_at had passed was still listed as available in both
 * the Customer Library (resolveAssetsWithDeliveryInfo()) and the guest
 * fulfilment status page (getFulfilmentStatus()), because neither
 * function checked access_expires_at at all — only delivery existence
 * and revoked status. Clicking it correctly failed at checkEntitlement()
 * with 'access_expired', but the button itself shouldn't have appeared —
 * the same "advertise something the entitlement layer will reject"
 * class of bug already fixed twice this project for missing/revoked
 * deliveries, now closed for the third denial reason.
 *
 * The fix extracts isDeliveryRevoked()/isDeliveryAccessExpired() out of
 * entitlementService.ts's checkEntitlement() itself (byte-identical
 * logic, just named and exported) so both display surfaces reuse the
 * exact same predicate checkEntitlement() evaluates — never a
 * hand-copied second rule that could drift.
 *
 * Display treatment differs deliberately by field: a REVOKED delivery
 * stays visible in the Library, marked `revoked: true` (existing,
 * unchanged behavior — the Library has a UI state for "why did this
 * disappear"). An EXPIRED delivery has no such display state, so it is
 * omitted entirely, the same treatment as a missing delivery, on both
 * surfaces.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resolveAssetsWithDeliveryInfo, getFulfilmentStatus } from '../../services/fulfilmentService';
import { checkEntitlement } from '../../services/entitlementService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG, TEST_ASSET_ID } from '../helpers';

async function addSecondPdfFile(assetId: string): Promise<void> {
  const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('test-guide-mobile.pdf', 'test-guide-mobile.pdf', 'application/pdf', 4096, 'mobilehash3', 'media/documents/uncategorized/test-guide-mobile3.pdf', 'https://example.com/test-guide-mobile3.pdf', 'document', 'books', 'ready')`
  ).run();
  const mediaId = Number(mediaInsert.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status, sort_order)
     VALUES (?, ?, ?, 'Test Guide (Mobile PDF)', 'PDF', 'published', 1)`
  )
    .bind(productRow!.id, assetId, mediaId)
    .run();
}

async function seedVerifiedPurchase(reference: string): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'))`
  )
    .bind(reference, TEST_PRODUCT_SLUG)
    .run();
  return Number(insert.meta.last_row_id);
}

/** accessExpiresAt: null = never expires; an ISO string in the past or future to test the boundary. */
async function insertDelivery(
  purchaseSessionId: number,
  assetId: string,
  options: { status?: 'delivered' | 'revoked'; accessExpiresAt?: string | null } = {}
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status, access_expires_at) VALUES (?, ?, ?, 10, 0, ?, ?)`
  )
    .bind(purchaseSessionId, assetId, TEST_PRODUCT_SLUG, options.status ?? 'delivered', options.accessExpiresAt ?? null)
    .run();
}

const PAST = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago — genuinely expired, no boundary ambiguity
const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString(); // 1 hour from now — genuinely still valid

beforeEach(async () => {
  await env.DB.exec('DELETE FROM download_tokens');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

describe('Case 1 — delivery exists, no expiry at all: visible on both surfaces', () => {
  it('resolveAssetsWithDeliveryInfo() shows it', async () => {
    const id = await seedVerifiedPurchase('RWL-2026-992001');
    await insertDelivery(id, TEST_ASSET_ID, { accessExpiresAt: null });
    const assets = await resolveAssetsWithDeliveryInfo(env as any, id, TEST_PRODUCT_SLUG);
    expect(assets.map((a) => a.assetId)).toEqual([TEST_ASSET_ID]);
    expect(assets[0].revoked).toBe(false);
  });

  it('getFulfilmentStatus() shows it', async () => {
    const id = await seedVerifiedPurchase('RWL-2026-992002');
    await insertDelivery(id, TEST_ASSET_ID, { accessExpiresAt: null });
    const status = await getFulfilmentStatus(env as any, 'RWL-2026-992002');
    expect(status!.assets.map((a) => a.assetId)).toEqual([TEST_ASSET_ID]);
  });
});

describe('Case 2 — delivery exists, expiry in the future: visible on both surfaces', () => {
  it('resolveAssetsWithDeliveryInfo() shows it', async () => {
    const id = await seedVerifiedPurchase('RWL-2026-992003');
    await insertDelivery(id, TEST_ASSET_ID, { accessExpiresAt: FUTURE });
    const assets = await resolveAssetsWithDeliveryInfo(env as any, id, TEST_PRODUCT_SLUG);
    expect(assets.map((a) => a.assetId)).toEqual([TEST_ASSET_ID]);
  });

  it('getFulfilmentStatus() shows it', async () => {
    const id = await seedVerifiedPurchase('RWL-2026-992004');
    await insertDelivery(id, TEST_ASSET_ID, { accessExpiresAt: FUTURE });
    const status = await getFulfilmentStatus(env as any, 'RWL-2026-992004');
    expect(status!.assets.map((a) => a.assetId)).toEqual([TEST_ASSET_ID]);
  });
});

describe('Case 3 — delivery exists, expiry already past: hidden on both surfaces (this is the fix)', () => {
  it('resolveAssetsWithDeliveryInfo() omits it, same as a missing delivery', async () => {
    const id = await seedVerifiedPurchase('RWL-2026-992005');
    await insertDelivery(id, TEST_ASSET_ID, { accessExpiresAt: PAST });
    const assets = await resolveAssetsWithDeliveryInfo(env as any, id, TEST_PRODUCT_SLUG);
    expect(assets).toHaveLength(0);
  });

  it('getFulfilmentStatus() omits it, same as a missing delivery', async () => {
    const id = await seedVerifiedPurchase('RWL-2026-992006');
    await insertDelivery(id, TEST_ASSET_ID, { accessExpiresAt: PAST });
    const status = await getFulfilmentStatus(env as any, 'RWL-2026-992006');
    expect(status!.assets).toHaveLength(0);
  });
});

describe('Case 4 — revoked delivery: existing behavior fully preserved (not conflated with expiry)', () => {
  it('resolveAssetsWithDeliveryInfo() still returns a revoked asset marked revoked:true, even with no expiry set', async () => {
    const id = await seedVerifiedPurchase('RWL-2026-992007');
    await insertDelivery(id, TEST_ASSET_ID, { status: 'revoked', accessExpiresAt: null });
    const assets = await resolveAssetsWithDeliveryInfo(env as any, id, TEST_PRODUCT_SLUG);
    expect(assets).toHaveLength(1);
    expect(assets[0].revoked).toBe(true);
  });

  it('getFulfilmentStatus() omits a revoked delivery, exactly as before this change', async () => {
    const id = await seedVerifiedPurchase('RWL-2026-992008');
    await insertDelivery(id, TEST_ASSET_ID, { status: 'revoked', accessExpiresAt: null });
    const status = await getFulfilmentStatus(env as any, 'RWL-2026-992008');
    expect(status!.assets).toHaveLength(0);
  });
});

describe('Case 5 — missing delivery: still hidden, unaffected by this change', () => {
  it('resolveAssetsWithDeliveryInfo() and getFulfilmentStatus() both omit it', async () => {
    const id = await seedVerifiedPurchase('RWL-2026-992009');
    const assets = await resolveAssetsWithDeliveryInfo(env as any, id, TEST_PRODUCT_SLUG);
    expect(assets).toHaveLength(0);
    const status = await getFulfilmentStatus(env as any, 'RWL-2026-992009');
    expect(status!.assets).toHaveLength(0);
  });
});

describe('Case 6 — mixed assets: only currently-authorized ones are visible', () => {
  it('a purchase with a valid PDF, an already-expired second PDF, and no EPUB delivery returns exactly the valid PDF', async () => {
    const mobilePdfAssetId = 'asset-test-guide-mobile-pdf-expired';
    await addSecondPdfFile(mobilePdfAssetId);
    const id = await seedVerifiedPurchase('RWL-2026-992010');
    await insertDelivery(id, TEST_ASSET_ID, { accessExpiresAt: null });
    await insertDelivery(id, mobilePdfAssetId, { accessExpiresAt: PAST });

    const libraryAssets = await resolveAssetsWithDeliveryInfo(env as any, id, TEST_PRODUCT_SLUG);
    expect(libraryAssets.map((a) => a.assetId)).toEqual([TEST_ASSET_ID]);

    const status = await getFulfilmentStatus(env as any, 'RWL-2026-992010');
    expect(status!.assets.map((a) => a.assetId)).toEqual([TEST_ASSET_ID]);
  });
});

describe('Case 7 — Library and guest fulfilment status agree on availability', () => {
  it('for a mix of valid/expired/revoked/missing assets, both surfaces expose the exact same usable asset set', async () => {
    const expiredAssetId = 'asset-test-guide-mobile-pdf-agree';
    await addSecondPdfFile(expiredAssetId);
    const id = await seedVerifiedPurchase('RWL-2026-992011');
    await insertDelivery(id, TEST_ASSET_ID, { accessExpiresAt: FUTURE });
    await insertDelivery(id, expiredAssetId, { accessExpiresAt: PAST });

    const libraryAssets = await resolveAssetsWithDeliveryInfo(env as any, id, TEST_PRODUCT_SLUG);
    const status = await getFulfilmentStatus(env as any, 'RWL-2026-992011');

    const libraryIds = libraryAssets.filter((a) => !a.revoked).map((a) => a.assetId).sort();
    const statusIds = status!.assets.map((a) => a.assetId).sort();
    expect(libraryIds).toEqual(statusIds);
    expect(libraryIds).toEqual([TEST_ASSET_ID]);
  });
});

describe('Case 8 — every asset either surface exposes passes the real checkEntitlement() decision', () => {
  it('holds for a purchase with a valid, an expired, and a missing asset', async () => {
    const expiredAssetId = 'asset-test-guide-mobile-pdf-invariant3';
    await addSecondPdfFile(expiredAssetId);
    const id = await seedVerifiedPurchase('RWL-2026-992012');
    await insertDelivery(id, TEST_ASSET_ID, { accessExpiresAt: FUTURE });
    await insertDelivery(id, expiredAssetId, { accessExpiresAt: PAST });
    // A third published asset is added by addSecondPdfFile's sibling helper pattern is not needed here —
    // TEST_ASSET_ID's own product already has no third asset by default, so "missing" is implicit for anything else.

    const libraryAssets = await resolveAssetsWithDeliveryInfo(env as any, id, TEST_PRODUCT_SLUG);
    const status = await getFulfilmentStatus(env as any, 'RWL-2026-992012');

    for (const asset of [...libraryAssets.filter((a) => !a.revoked), ...status!.assets]) {
      const result = await checkEntitlement(env as any, 'RWL-2026-992012', asset.assetId, 'view');
      expect(result.granted).toBe(true);
    }
  });
});

describe('Case 9 — direct access to the expired asset remains denied', () => {
  it('checkEntitlement() still returns access_expired, unchanged by this display-layer fix', async () => {
    const id = await seedVerifiedPurchase('RWL-2026-992013');
    await insertDelivery(id, TEST_ASSET_ID, { accessExpiresAt: PAST });

    const result = await checkEntitlement(env as any, 'RWL-2026-992013', TEST_ASSET_ID, 'view');
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe('access_expired');
  });

  it('the real GET /api/purchases/:reference/read-access route denies it the same way', async () => {
    const id = await seedVerifiedPurchase('RWL-2026-992014');
    await insertDelivery(id, TEST_ASSET_ID, { accessExpiresAt: PAST });

    const res = await SELF.fetch('https://example.com/api/purchases/RWL-2026-992014/read-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: TEST_ASSET_ID }),
    });
    expect(res.status).toBe(403);
    const body = await res.json<any>();
    expect(body.success).toBe(false);
  });
});

describe('Case 10 — valid access remains completely unchanged', () => {
  it('a non-expiring delivery is still fully readable end-to-end via the real route', async () => {
    const id = await seedVerifiedPurchase('RWL-2026-992015');
    await insertDelivery(id, TEST_ASSET_ID, { accessExpiresAt: null });

    const res = await SELF.fetch('https://example.com/api/purchases/RWL-2026-992015/read-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: TEST_ASSET_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
  });

  it('a future-expiring delivery is still fully readable end-to-end via the real route', async () => {
    const id = await seedVerifiedPurchase('RWL-2026-992016');
    await insertDelivery(id, TEST_ASSET_ID, { accessExpiresAt: FUTURE });

    const res = await SELF.fetch('https://example.com/api/purchases/RWL-2026-992016/read-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: TEST_ASSET_ID }),
    });
    expect(res.status).toBe(200);
  });
});
