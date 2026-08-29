/**
 * Integration tests: Phase 9C.6 (EPUB Library Availability & Production
 * Integration). Exercises the real service/route layer — fulfilPurchase(),
 * the new backfillEntitlementsForProduct(), checkEntitlement(), and the
 * real GET /api/customer/purchases HTTP route via SELF.fetch() — the
 * same testing convention this codebase already uses (see
 * entitlementService.test.ts, customerPurchases.test.ts,
 * financialLiteracyBundle.test.ts). Everything here runs against the
 * isolated, in-memory @cloudflare/vitest-pool-workers D1/R2, never the
 * persistent local dev D1 real customer traffic would use.
 *
 * Covers the audit's own root-cause chain end to end: a product with
 * both a PDF and an EPUB asset (mirroring the real fix applied to
 * Treasury Bills Made Simple), for both a brand-new purchase and an
 * existing pre-EPUB purchase backfilled via the new admin action, plus
 * a non-owner denial and a PDF-only regression check.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createLogger } from '../../utils/logger';
import { fulfilPurchase, backfillEntitlementsForProduct, ensureEntitlementsGranted } from '../../services/fulfilmentService';
import { checkEntitlement } from '../../services/entitlementService';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession } from '../../services/customer/sessionService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG, TEST_ASSET_ID } from '../helpers';

const logger = createLogger('test-request-id', 'test');

const EPUB_ASSET_ID = 'asset-test-guide-epub-v1';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
});

/** Adds a second, EPUB, published file to the standard seeded test product — mirrors exactly what Phase 9C.6 registered for the real Treasury Bills Made Simple product (a second product_files/media_assets row, same product, PDF row left untouched). */
async function addEpubFile(): Promise<void> {
  const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('test-guide.epub', 'test-guide.epub', 'application/epub+zip', 2048, 'epubhash', 'media/documents/books/test-guide.epub', 'https://example.com/test-guide.epub', 'document', 'books', 'ready')`
  ).run();
  const mediaId = Number(mediaInsert.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status, sort_order)
     VALUES (?, ?, ?, 'Test Guide (EPUB)', 'EPUB', 'published', 1)`
  )
    .bind(productRow!.id, EPUB_ASSET_ID, mediaId)
    .run();
}

describe('New customer — fulfilPurchase() grants both formats (Phase 9C.6, section 7/16-B)', () => {
  it('grants a PDF delivery AND an EPUB delivery for one purchase of a product with both files published', async () => {
    await seedTestProduct(env as any);
    await addEpubFile();

    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
       VALUES ('RWL-2026-920001', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'))`
    )
      .bind(TEST_PRODUCT_SLUG)
      .run();
    const purchaseSessionId = Number(insert.meta.last_row_id);

    await fulfilPurchase(env as any, logger, {
      purchaseSessionId,
      purchaseReference: 'RWL-2026-920001',
      productSlug: TEST_PRODUCT_SLUG,
      customerEmail: 'new-customer-epub-test@example.com',
      amountPesewas: 3900,
      currency: 'GHS',
      customerId: null,
      isNewCustomer: false,
    });

    const { results: deliveries } = await env.DB.prepare(
      `SELECT asset_id AS assetId, status FROM deliveries WHERE purchase_session_id = ? ORDER BY asset_id ASC`
    )
      .bind(purchaseSessionId)
      .all<{ assetId: string; status: string }>();

    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((d) => d.assetId).sort()).toEqual([EPUB_ASSET_ID, TEST_ASSET_ID].sort());
    for (const d of deliveries) expect(d.status).toBe('delivered');
  });
});

describe('Existing customer — bulk entitlement backfill (Phase 9C.6, section 6/16-A)', () => {
  it('grants the missing EPUB delivery for a purchase that only ever had a PDF delivery, without touching the existing PDF delivery', async () => {
    await seedTestProduct(env as any);

    // Simulates "purchased before the EPUB existed": a verified purchase
    // with only the original PDF delivery, exactly what every real
    // Treasury Bills Made Simple purchaser's pre-fix state looked like.
    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
       VALUES ('RWL-2026-920010', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'))`
    )
      .bind(TEST_PRODUCT_SLUG)
      .run();
    const purchaseSessionId = Number(insert.meta.last_row_id);
    await ensureEntitlementsGranted(env as any, logger, purchaseSessionId, TEST_PRODUCT_SLUG);

    let deliveries = await env.DB.prepare(`SELECT asset_id AS assetId FROM deliveries WHERE purchase_session_id = ?`)
      .bind(purchaseSessionId)
      .all<{ assetId: string }>();
    expect(deliveries.results).toHaveLength(1);
    expect(deliveries.results[0].assetId).toBe(TEST_ASSET_ID);

    // Now the EPUB is published on the product (mirrors the real
    // Phase 9C.6 data-layer fix) and the admin runs the new bulk
    // backfill action.
    await addEpubFile();
    const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
    const firstRun = await backfillEntitlementsForProduct(env as any, logger, 1, productRow!.id, TEST_PRODUCT_SLUG);

    expect(firstRun.sessionsChecked).toBe(1);
    expect(firstRun.sessionsGranted).toBe(1);
    expect(firstRun.assetsGranted).toBe(1);

    deliveries = await env.DB.prepare(`SELECT asset_id AS assetId FROM deliveries WHERE purchase_session_id = ? ORDER BY asset_id ASC`)
      .bind(purchaseSessionId)
      .all<{ assetId: string }>();
    expect(deliveries.results.map((d) => d.assetId).sort()).toEqual([EPUB_ASSET_ID, TEST_ASSET_ID].sort());

    // Idempotent: running it again grants nothing new and creates no duplicate row.
    const secondRun = await backfillEntitlementsForProduct(env as any, logger, 1, productRow!.id, TEST_PRODUCT_SLUG);
    expect(secondRun.sessionsGranted).toBe(0);
    expect(secondRun.assetsGranted).toBe(0);

    const finalCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE purchase_session_id = ?`)
      .bind(purchaseSessionId)
      .first<{ n: number }>();
    expect(finalCount!.n).toBe(2);
  });

  it("never grants an entitlement to a purchase of a DIFFERENT product, even one with the same asset naming pattern", async () => {
    await seedTestProduct(env as any);
    await addEpubFile();

    // A purchase of an unrelated product — must never be touched by a
    // backfill scoped to TEST_PRODUCT_SLUG.
    const otherInsert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
       VALUES ('RWL-2026-920020', 'unrelated-product', 'prod-unrelated', 'Unrelated Product', 1900, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'))`
    ).run();
    const otherSessionId = Number(otherInsert.meta.last_row_id);

    const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
    const result = await backfillEntitlementsForProduct(env as any, logger, 1, productRow!.id, TEST_PRODUCT_SLUG);
    expect(result.sessionsChecked).toBe(0);

    const otherDeliveries = await env.DB.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE purchase_session_id = ?`)
      .bind(otherSessionId)
      .first<{ n: number }>();
    expect(otherDeliveries!.n).toBe(0);
  });
});

describe('Non-owner denial — entitlement security unchanged (Phase 9C.6, section 13)', () => {
  it('checkEntitlement still returns delivery_not_found for a purchase that was never granted the EPUB asset', async () => {
    await seedTestProduct(env as any);
    await addEpubFile();

    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
       VALUES ('RWL-2026-920030', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'))`
    )
      .bind(TEST_PRODUCT_SLUG)
      .run();

    // Only the PDF was ever entitled (no fulfilPurchase()/backfill call
    // at all here) — the EPUB was never granted for this purchase.
    const result = await checkEntitlement(env as any, 'RWL-2026-920030', EPUB_ASSET_ID);
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe('delivery_not_found');
  });
});

describe('PDF-only regression — the existing single-asset catalog is unaffected (Phase 9C.6, section 14)', () => {
  it('fulfilPurchase() on a PDF-only product still grants exactly one PDF delivery, same as before this phase', async () => {
    await seedTestProduct(env as any); // no addEpubFile() — mirrors every real product except Treasury Bills today

    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
       VALUES ('RWL-2026-920040', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'))`
    )
      .bind(TEST_PRODUCT_SLUG)
      .run();
    const purchaseSessionId = Number(insert.meta.last_row_id);

    await fulfilPurchase(env as any, logger, {
      purchaseSessionId,
      purchaseReference: 'RWL-2026-920040',
      productSlug: TEST_PRODUCT_SLUG,
      customerEmail: 'pdf-only-regression@example.com',
      amountPesewas: 3900,
      currency: 'GHS',
      customerId: null,
      isNewCustomer: false,
    });

    const { results: deliveries } = await env.DB.prepare(`SELECT asset_id AS assetId FROM deliveries WHERE purchase_session_id = ?`)
      .bind(purchaseSessionId)
      .all<{ assetId: string }>();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].assetId).toBe(TEST_ASSET_ID);
  });
});

describe('API contract — GET /api/customer/purchases returns both fileTypes (Phase 9C.6, section 18/19)', () => {
  it('returns assets:[{fileType:"PDF"},{fileType:"EPUB"}] for a fully-entitled purchase, and library-list.js\'s multi-asset fix has real data to render', async () => {
    await seedTestProduct(env as any);
    await addEpubFile();

    const { customerId } = await findOrCreateCustomer(env as any, 'api-contract-test@example.com', false);
    const session = await createSession(env as any, customerId, { ip: null, userAgent: null });

    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at, customer_id)
       VALUES ('RWL-2026-920050', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'), ?)`
    )
      .bind(TEST_PRODUCT_SLUG, customerId)
      .run();
    const purchaseSessionId = Number(insert.meta.last_row_id);

    await fulfilPurchase(env as any, logger, {
      purchaseSessionId,
      purchaseReference: 'RWL-2026-920050',
      productSlug: TEST_PRODUCT_SLUG,
      customerEmail: 'api-contract-test@example.com',
      amountPesewas: 3900,
      currency: 'GHS',
      customerId,
      isNewCustomer: false,
    });

    const res = await SELF.fetch('https://example.com/api/customer/purchases', {
      headers: { Cookie: `customer_session=${session.sessionToken}` },
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.purchases).toHaveLength(1);

    const fileTypes = body.data.purchases[0].assets.map((a: any) => a.fileType).sort();
    expect(fileTypes).toEqual(['EPUB', 'PDF']);

    // No asset is ever revoked here, so this is exactly the payload
    // shape js/components/library-list.js's ownedAssets.length > 1
    // branch renders "Read PDF / Read EPUB / Download PDF / Download
    // EPUB" from (verified separately, against the real script, via a
    // disposable browser harness — see the Phase 9C.6 report).
    for (const asset of body.data.purchases[0].assets) {
      expect(asset.revoked).toBe(false);
    }
  });

  it('a PDF-only purchase still returns a single-element assets array — the frontend\'s single-asset branch is unaffected', async () => {
    await seedTestProduct(env as any);

    const { customerId } = await findOrCreateCustomer(env as any, 'pdf-only-api-test@example.com', false);
    const session = await createSession(env as any, customerId, { ip: null, userAgent: null });

    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at, customer_id)
       VALUES ('RWL-2026-920060', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'), ?)`
    )
      .bind(TEST_PRODUCT_SLUG, customerId)
      .run();
    const purchaseSessionId = Number(insert.meta.last_row_id);

    await fulfilPurchase(env as any, logger, {
      purchaseSessionId,
      purchaseReference: 'RWL-2026-920060',
      productSlug: TEST_PRODUCT_SLUG,
      customerEmail: 'pdf-only-api-test@example.com',
      amountPesewas: 3900,
      currency: 'GHS',
      customerId,
      isNewCustomer: false,
    });

    const res = await SELF.fetch('https://example.com/api/customer/purchases', {
      headers: { Cookie: `customer_session=${session.sessionToken}` },
    });
    const body = await res.json<any>();
    expect(body.data.purchases[0].assets).toHaveLength(1);
    expect(body.data.purchases[0].assets[0].fileType).toBe('PDF');
  });
});
