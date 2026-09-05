/**
 * Integration tests: undelivered-asset library visibility fix.
 *
 * Root cause (confirmed via read-only production investigation, not
 * assumed): resolveAssetsWithDeliveryInfo() (fulfilmentService.ts)
 * built the customer library's asset list from every currently-
 * published catalog file, then looked up a matching `deliveries` row
 * per asset — but when no delivery row existed at all, the returned
 * entry's `revoked` field computed to `false` (delivery?.status ===
 * 'revoked' is false for `undefined`), identical to a genuinely owned,
 * non-revoked asset. The customer library (js/components/library-
 * list.js) filters on `!a.revoked`, so a customer was shown a "Read
 * PDF" button for a file their purchase was never actually fulfilled
 * for — the real production case: a purchase reference whose product
 * later had a new PDF variant published, with no delivery ever
 * created for that variant (this codebase has no mechanism that
 * automatically backfills deliveries when a new asset is published on
 * an already-purchased product — see ensureEntitlementsGranted()'s and
 * backfillEntitlementsForProduct()'s own header comments for the
 * existing, separate, deliberate remediation for that).
 *
 * The fix filters out any published asset with NO delivery row at all,
 * while leaving the existing revoked/delivered handling completely
 * unchanged for assets that DO have one — deliveries.status =
 * 'revoked' only ever means "was delivered, then revoked"
 * (revocationService.ts only ever flips an EXISTING row), never
 * "never delivered," and this fix keeps that distinction intact rather
 * than overloading it.
 *
 * These tests exercise the real service function and, for the
 * strongest case, the real HTTP route via SELF.fetch() — matching this
 * codebase's own established convention (see
 * epubLibraryAvailability.test.ts, productBundles.test.ts) — not just
 * asserting that a line of source code exists.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createLogger } from '../../utils/logger';
import { resolveAssetsWithDeliveryInfo, fulfilPurchase } from '../../services/fulfilmentService';
import { checkEntitlement, generateDownloadPermission } from '../../services/entitlementService';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession } from '../../services/customer/sessionService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG, TEST_ASSET_ID } from '../helpers';

const logger = createLogger('test-request-id', 'test');

/** A second, later-published PDF variant on the standard seeded test product — mirrors exactly the real "Small-Cedis-Big-Wealth-Mobile.pdf" shape found in production: same product, same file_type as the original, added independently of any purchase. */
async function addSecondPdfFile(assetId: string): Promise<void> {
  const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('test-guide-mobile.pdf', 'test-guide-mobile.pdf', 'application/pdf', 4096, 'mobilehash', 'media/documents/uncategorized/test-guide-mobile.pdf', 'https://example.com/test-guide-mobile.pdf', 'document', 'books', 'ready')`
  ).run();
  const mediaId = Number(mediaInsert.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status, sort_order)
     VALUES (?, ?, ?, 'Test Guide (Mobile PDF)', 'PDF', 'published', 1)`
  )
    .bind(productRow!.id, assetId, mediaId)
    .run();
}

async function addEpubFile(assetId: string): Promise<void> {
  const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('test-guide.epub', 'test-guide.epub', 'application/epub+zip', 2048, 'epubhash2', 'media/documents/books/test-guide.epub', 'https://example.com/test-guide.epub', 'document', 'books', 'ready')`
  ).run();
  const mediaId = Number(mediaInsert.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status, sort_order)
     VALUES (?, ?, ?, 'Test Guide (EPUB)', 'EPUB', 'published', 2)`
  )
    .bind(productRow!.id, assetId, mediaId)
    .run();
}

async function seedVerifiedPurchase(reference: string, customerId: number | null): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, verified_at, expires_at)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', ?, datetime('now'), datetime('now', '+30 minutes'))`
  )
    .bind(reference, TEST_PRODUCT_SLUG, customerId)
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
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

describe('Case A — valid delivery: published asset + matching delivery appears', () => {
  it('resolveAssetsWithDeliveryInfo() returns the asset when a delivery row exists', async () => {
    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-990001', null);
    await insertDelivery(purchaseSessionId, TEST_ASSET_ID);

    const assets = await resolveAssetsWithDeliveryInfo(env as any, purchaseSessionId, TEST_PRODUCT_SLUG);
    expect(assets).toHaveLength(1);
    expect(assets[0].assetId).toBe(TEST_ASSET_ID);
    expect(assets[0].revoked).toBe(false);
  });
});

describe('Case B — missing delivery: published asset + no delivery does not appear', () => {
  it('resolveAssetsWithDeliveryInfo() excludes a published asset with zero delivery rows', async () => {
    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-990002', null);
    // No insertDelivery() call at all — this is the exact real-world
    // shape: the asset is published on the product, but this specific
    // purchase's fulfilment never ran against it (predates it).
    const assets = await resolveAssetsWithDeliveryInfo(env as any, purchaseSessionId, TEST_PRODUCT_SLUG);
    expect(assets).toHaveLength(0);
  });
});

describe('Case C — revoked delivery: existing revoked behavior is unchanged', () => {
  it('resolveAssetsWithDeliveryInfo() still returns a revoked asset, marked revoked: true — never hidden', async () => {
    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-990003', null);
    await insertDelivery(purchaseSessionId, TEST_ASSET_ID, 'revoked');

    const assets = await resolveAssetsWithDeliveryInfo(env as any, purchaseSessionId, TEST_PRODUCT_SLUG);
    expect(assets).toHaveLength(1);
    expect(assets[0].assetId).toBe(TEST_ASSET_ID);
    expect(assets[0].revoked).toBe(true);
  });
});

describe('Case D — multiple assets: only genuinely delivered ones are returned', () => {
  it('a purchase with a delivered PDF, a delivered EPUB, and a published-but-undelivered second PDF returns exactly the two delivered assets', async () => {
    const mobilePdfAssetId = 'asset-test-guide-mobile-pdf';
    const epubAssetId = 'asset-test-guide-epub-v1';
    await addSecondPdfFile(mobilePdfAssetId);
    await addEpubFile(epubAssetId);

    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-990004', null);
    await insertDelivery(purchaseSessionId, TEST_ASSET_ID);
    await insertDelivery(purchaseSessionId, epubAssetId);
    // mobilePdfAssetId deliberately never delivered — mirrors the real production case exactly.

    const assets = await resolveAssetsWithDeliveryInfo(env as any, purchaseSessionId, TEST_PRODUCT_SLUG);
    expect(assets.map((a) => a.assetId).sort()).toEqual([TEST_ASSET_ID, epubAssetId].sort());
    expect(assets.find((a) => a.assetId === mobilePdfAssetId)).toBeUndefined();
    expect(assets.every((a) => !a.revoked)).toBe(true);
  });
});

describe('Case E — other products: unaffected when every published asset already has a valid delivery', () => {
  it('a product with two published assets, both delivered, still returns both — byte-identical to pre-fix behavior', async () => {
    const epubAssetId = 'asset-test-guide-epub-v1';
    await addEpubFile(epubAssetId);

    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-990005', null);
    await insertDelivery(purchaseSessionId, TEST_ASSET_ID);
    await insertDelivery(purchaseSessionId, epubAssetId);

    const assets = await resolveAssetsWithDeliveryInfo(env as any, purchaseSessionId, TEST_PRODUCT_SLUG);
    expect(assets).toHaveLength(2);
    expect(assets.map((a) => a.assetId).sort()).toEqual([TEST_ASSET_ID, epubAssetId].sort());
  });

  it('a real fulfilPurchase() call (every published asset genuinely granted) is completely unaffected by this fix', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'unaffected-product-test@example.com', false);
    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-990006', customerId);

    await fulfilPurchase(env as any, logger, {
      purchaseSessionId,
      purchaseReference: 'RWL-2026-990006',
      productSlug: TEST_PRODUCT_SLUG,
      customerEmail: 'unaffected-product-test@example.com',
      amountPesewas: 3900,
      currency: 'GHS',
      customerId,
      isNewCustomer: false,
    });

    const assets = await resolveAssetsWithDeliveryInfo(env as any, purchaseSessionId, TEST_PRODUCT_SLUG);
    expect(assets).toHaveLength(1);
    expect(assets[0].assetId).toBe(TEST_ASSET_ID);
    expect(assets[0].revoked).toBe(false);
  });
});

describe('Case F — entitlement security: /read-access and checkEntitlement are unchanged by this display-layer fix', () => {
  it('checkEntitlement() still returns delivery_not_found for the undelivered asset, exactly as before this fix', async () => {
    const mobilePdfAssetId = 'asset-test-guide-mobile-pdf';
    await addSecondPdfFile(mobilePdfAssetId);
    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-990007', null);
    void purchaseSessionId; // entitlement is keyed by reference, not id, below

    const result = await checkEntitlement(env as any, 'RWL-2026-990007', mobilePdfAssetId);
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe('delivery_not_found');
  });

  it('generateDownloadPermission() (the real /read-access and /download backing call) still denies the undelivered asset', async () => {
    const mobilePdfAssetId = 'asset-test-guide-mobile-pdf';
    await addSecondPdfFile(mobilePdfAssetId);
    await seedVerifiedPurchase('RWL-2026-990008', null);

    const result = await generateDownloadPermission(env as any, logger, 'RWL-2026-990008', mobilePdfAssetId, 'view');
    expect(result.granted).toBe(false);
  });

  it('the real GET /api/customer/purchases route reflects the fix end-to-end: the undelivered asset is absent from the JSON response, while the delivered ones remain', async () => {
    const mobilePdfAssetId = 'asset-test-guide-mobile-pdf';
    await addSecondPdfFile(mobilePdfAssetId);

    const { customerId } = await findOrCreateCustomer(env as any, 'route-level-test@example.com', false);
    const session = await createSession(env as any, customerId, { ip: null, userAgent: null });
    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-990009', customerId);
    await insertDelivery(purchaseSessionId, TEST_ASSET_ID);
    // mobilePdfAssetId never delivered.

    const res = await SELF.fetch('https://example.com/api/customer/purchases', {
      headers: { Cookie: `customer_session=${session.sessionToken}` },
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    const assets = body.data.purchases[0].assets;
    expect(assets).toHaveLength(1);
    expect(assets[0].assetId).toBe(TEST_ASSET_ID);
    expect(assets.find((a: any) => a.assetId === mobilePdfAssetId)).toBeUndefined();
  });
});
