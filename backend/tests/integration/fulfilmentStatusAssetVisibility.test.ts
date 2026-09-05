/**
 * Integration tests: guest fulfilment-status asset visibility fix.
 *
 * Second instance of the exact same bug class fixed in
 * resolveAssetsWithDeliveryInfo() (see undeliveredAssetLibraryVisibility.test.ts),
 * found during a full-chain entitlement audit: fulfilmentService.ts's
 * getFulfilmentStatus() — the read behind GET /api/purchases/:reference,
 * the guest checkout/callback confirmation page's only data source —
 * built its `assets` field from every currently-published catalog file
 * with NO join against `deliveries` at all, and with no per-asset
 * revoked check either. A guest revisiting an old confirmation link
 * after a new asset was published on a product they already own (or
 * after one specific delivery was revoked, e.g. a partial refund) would
 * see a "Download" button for an asset entitlementService.ts's
 * checkEntitlement() would then correctly reject with
 * delivery_not_found/delivery_revoked — the same dead-button symptom,
 * on a second, guest-facing surface the first fix never touched.
 *
 * The fix mirrors resolveAssetsWithDeliveryInfo() exactly: only a
 * published asset with a delivery row for this purchase, whose status
 * isn't 'revoked', is listed. FulfilmentStatusAsset's shape (assetId/
 * displayName/fileType) is unchanged — only which assets appear.
 *
 * These tests exercise the real service function and the real HTTP
 * route via SELF.fetch(), matching this codebase's established
 * convention.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { getFulfilmentStatus, resolveAssetsWithDeliveryInfo } from '../../services/fulfilmentService';
import { checkEntitlement } from '../../services/entitlementService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG, TEST_ASSET_ID } from '../helpers';

async function addSecondPdfFile(assetId: string): Promise<void> {
  const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('test-guide-mobile.pdf', 'test-guide-mobile.pdf', 'application/pdf', 4096, 'mobilehash2', 'media/documents/uncategorized/test-guide-mobile2.pdf', 'https://example.com/test-guide-mobile2.pdf', 'document', 'books', 'ready')`
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

async function insertDelivery(purchaseSessionId: number, assetId: string, status: 'delivered' | 'revoked' = 'delivered'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) VALUES (?, ?, ?, 10, 0, ?)`
  )
    .bind(purchaseSessionId, assetId, TEST_PRODUCT_SLUG, status)
    .run();
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

describe('getFulfilmentStatus() — Case A: valid delivery appears', () => {
  it('lists the asset when a delivery row exists', async () => {
    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-991001');
    await insertDelivery(purchaseSessionId, TEST_ASSET_ID);

    const status = await getFulfilmentStatus(env as any, 'RWL-2026-991001');
    expect(status!.assets).toHaveLength(1);
    expect(status!.assets[0].assetId).toBe(TEST_ASSET_ID);
  });
});

describe('getFulfilmentStatus() — Case B: missing delivery is excluded', () => {
  it('excludes a published asset with zero delivery rows for this purchase', async () => {
    await seedVerifiedPurchase('RWL-2026-991002');
    // No insertDelivery() — mirrors the real bug: asset published after this purchase was fulfilled.
    const status = await getFulfilmentStatus(env as any, 'RWL-2026-991002');
    expect(status!.assets).toHaveLength(0);
  });
});

describe('getFulfilmentStatus() — Case C: revoked delivery is excluded (not just refunded purchases)', () => {
  it('excludes a revoked asset even though the overall purchase is still "ready"', async () => {
    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-991003');
    await insertDelivery(purchaseSessionId, TEST_ASSET_ID, 'revoked');

    const status = await getFulfilmentStatus(env as any, 'RWL-2026-991003');
    expect(status!.status).toBe('ready');
    expect(status!.assets).toHaveLength(0);
  });
});

describe('getFulfilmentStatus() — Case D: multiple assets, only genuinely usable ones appear', () => {
  it('a delivered PDF + an undelivered second PDF returns exactly the delivered one', async () => {
    const mobilePdfAssetId = 'asset-test-guide-mobile-pdf-fulfilment';
    await addSecondPdfFile(mobilePdfAssetId);

    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-991004');
    await insertDelivery(purchaseSessionId, TEST_ASSET_ID);
    // mobilePdfAssetId deliberately never delivered.

    const status = await getFulfilmentStatus(env as any, 'RWL-2026-991004');
    expect(status!.assets.map((a) => a.assetId)).toEqual([TEST_ASSET_ID]);
  });
});

describe('Cross-surface invariant: every asset either surface lists is always checkEntitlement()-passable', () => {
  it('every asset resolveAssetsWithDeliveryInfo() lists as non-revoked also passes checkEntitlement() for the same purchase', async () => {
    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-991005');
    await insertDelivery(purchaseSessionId, TEST_ASSET_ID);

    const libraryAssets = await resolveAssetsWithDeliveryInfo(env as any, purchaseSessionId, TEST_PRODUCT_SLUG);
    for (const asset of libraryAssets.filter((a) => !a.revoked)) {
      const result = await checkEntitlement(env as any, 'RWL-2026-991005', asset.assetId, 'view');
      expect(result.granted).toBe(true);
    }
  });

  it('every asset getFulfilmentStatus() lists also passes checkEntitlement() for the same purchase', async () => {
    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-991006');
    await insertDelivery(purchaseSessionId, TEST_ASSET_ID);

    const status = await getFulfilmentStatus(env as any, 'RWL-2026-991006');
    for (const asset of status!.assets) {
      const result = await checkEntitlement(env as any, 'RWL-2026-991006', asset.assetId, 'view');
      expect(result.granted).toBe(true);
    }
  });

  it('an asset excluded by getFulfilmentStatus() (no delivery) is confirmed denied by checkEntitlement() too — library state and entitlement state never disagree', async () => {
    const mobilePdfAssetId = 'asset-test-guide-mobile-pdf-invariant2';
    await addSecondPdfFile(mobilePdfAssetId);
    await seedVerifiedPurchase('RWL-2026-991007');

    const status = await getFulfilmentStatus(env as any, 'RWL-2026-991007');
    expect(status!.assets.find((a) => a.assetId === mobilePdfAssetId)).toBeUndefined();

    const result = await checkEntitlement(env as any, 'RWL-2026-991007', mobilePdfAssetId);
    expect(result.granted).toBe(false);
  });
});

describe('Route level: GET /api/purchases/:reference reflects the fix end-to-end', () => {
  it('the real route excludes an undelivered asset and keeps a delivered one', async () => {
    const mobilePdfAssetId = 'asset-test-guide-mobile-pdf-route';
    await addSecondPdfFile(mobilePdfAssetId);
    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-991008');
    await insertDelivery(purchaseSessionId, TEST_ASSET_ID);

    const res = await SELF.fetch('https://example.com/api/purchases/RWL-2026-991008');
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.assets).toHaveLength(1);
    expect(body.data.assets[0].assetId).toBe(TEST_ASSET_ID);
  });

  it('the real route returns zero assets, not an error, for a purchase whose only asset is undelivered', async () => {
    await seedVerifiedPurchase('RWL-2026-991009');
    const res = await SELF.fetch('https://example.com/api/purchases/RWL-2026-991009');
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.assets).toEqual([]);
  });
});
