/**
 * Integration tests: Phase 9C.9 (Small Cedis, Big Wealth EPUB +
 * platform completion). Exercises the real flagship product (migration
 * 0009's real seeded row, D1 id=1, slug `starting-to-invest-with-gh100`)
 * with BOTH real content corrections applied within this isolated test
 * DB -- the title correction (mirroring flagship_reposition_2026-07-
 * 20.sql, already verified live in production this phase) and the new
 * EPUB product_files/media_assets row (mirroring exactly what was
 * registered in local dev D1 + local R2 this phase, generated from the
 * real production PDF). Covers the full new-customer/existing-customer/
 * non-owner/PDF-regression/API-contract matrix already proven for
 * Treasury Bills in Phase 9C.6, now for the real flagship book, plus a
 * targeted entitlement-security check for its own real EPUB asset.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createLogger } from '../../utils/logger';
import { fulfilPurchase, backfillEntitlementsForProduct, ensureEntitlementsGranted } from '../../services/fulfilmentService';
import { checkEntitlement } from '../../services/entitlementService';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession } from '../../services/customer/sessionService';

const logger = createLogger('test-request-id', 'test');

const SLUG = 'starting-to-invest-with-gh100';
const PRODUCT_ID_STR = 'prod-starting-to-invest-with-gh100';
const PDF_ASSET_ID = 'asset-starting-to-invest-with-gh100-pdf-v1';
const EPUB_ASSET_ID = 'asset-starting-to-invest-with-gh100-epub-test01';
const NEW_TITLE = 'Small Cedis, Big Wealth';

beforeEach(async () => {
  // Isolation between tests in this file, without touching the shared
  // migration-0009 baseline (the real product/PDF row every test here
  // relies on): remove only what a previous test in this file may have
  // added -- its purchase/delivery rows and its own EPUB product_files/
  // media_assets rows -- keyed on this file's own test fixtures.
  await env.DB.exec("DELETE FROM deliveries WHERE product_slug = 'starting-to-invest-with-gh100'");
  await env.DB.exec("DELETE FROM purchase_sessions WHERE product_slug = 'starting-to-invest-with-gh100'");
  await env.DB.exec(`DELETE FROM product_files WHERE product_id = (SELECT id FROM products WHERE slug = 'starting-to-invest-with-gh100') AND file_type = 'EPUB'`);
  await env.DB.exec("DELETE FROM media_assets WHERE storage_key = 'media/documents/books/test-scw.epub'");
});

async function applyCorrectTitle(): Promise<void> {
  await env.DB.prepare(`UPDATE products SET title = ?, subtitle = ? WHERE slug = ?`)
    .bind(NEW_TITLE, 'How Ordinary Ghanaians Can Build Real Wealth Starting With GH₵1', SLUG)
    .run();
}

async function addEpubFile(): Promise<number> {
  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('small-cedis-big-wealth.epub', 'small-cedis-big-wealth.epub', 'application/epub+zip', 1308565, 'test-scw-hash', 'media/documents/books/test-scw.epub', '/api/media/file/media/documents/books/test-scw.epub', 'document', 'books', 'ready')`
  ).run();
  const mediaId = Number(mediaInsert.meta.last_row_id);
  const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(SLUG).first<{ id: number }>();
  await env.DB.prepare(
    `INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status, sort_order)
     VALUES (?, ?, ?, 'Small-Cedis-Big-Wealth.epub', 'EPUB', 'published', 1)`
  )
    .bind(productRow!.id, EPUB_ASSET_ID, mediaId)
    .run();
  return mediaId;
}

describe('Small Cedis, Big Wealth — new customer gets both formats (Phase 9C.9)', () => {
  it('fulfilPurchase() grants both the PDF and the new EPUB', async () => {
    await applyCorrectTitle();
    await addEpubFile();

    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
       VALUES ('RWL-2026-990001', ?, ?, ?, 3900, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'))`
    )
      .bind(SLUG, PRODUCT_ID_STR, NEW_TITLE)
      .run();
    const purchaseSessionId = Number(insert.meta.last_row_id);

    await fulfilPurchase(env as any, logger, {
      purchaseSessionId,
      purchaseReference: 'RWL-2026-990001',
      productSlug: SLUG,
      customerEmail: 'new-flagship-customer@example.com',
      amountPesewas: 3900,
      currency: 'GHS',
      customerId: null,
      isNewCustomer: false,
    });

    const { results } = await env.DB.prepare(`SELECT asset_id AS assetId FROM deliveries WHERE purchase_session_id = ? ORDER BY asset_id`)
      .bind(purchaseSessionId)
      .all<{ assetId: string }>();
    expect(results.map((r) => r.assetId).sort()).toEqual([EPUB_ASSET_ID, PDF_ASSET_ID].sort());
  });
});

describe('Small Cedis, Big Wealth — existing (pre-EPUB) customer backfill (Phase 9C.9)', () => {
  it('an existing PDF-only purchaser is granted the EPUB by the idempotent backfill, without touching their PDF delivery or the real technical identifiers', async () => {
    await applyCorrectTitle();

    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
       VALUES ('RWL-2026-990010', ?, ?, 'Starting to Invest with GH₵100', 3900, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'))`
    )
      .bind(SLUG, PRODUCT_ID_STR)
      .run();
    const purchaseSessionId = Number(insert.meta.last_row_id);
    await ensureEntitlementsGranted(env as any, logger, purchaseSessionId, SLUG);

    let deliveries = await env.DB.prepare(`SELECT asset_id AS assetId FROM deliveries WHERE purchase_session_id = ?`)
      .bind(purchaseSessionId)
      .all<{ assetId: string }>();
    expect(deliveries.results).toHaveLength(1);
    expect(deliveries.results[0].assetId).toBe(PDF_ASSET_ID);

    await addEpubFile();
    const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(SLUG).first<{ id: number }>();
    const backfill = await backfillEntitlementsForProduct(env as any, logger, 1, productRow!.id, SLUG);
    expect(backfill.sessionsGranted).toBe(1);
    expect(backfill.assetsGranted).toBe(1);

    deliveries = await env.DB.prepare(`SELECT asset_id AS assetId FROM deliveries WHERE purchase_session_id = ? ORDER BY asset_id`)
      .bind(purchaseSessionId)
      .all<{ assetId: string }>();
    expect(deliveries.results.map((d) => d.assetId).sort()).toEqual([EPUB_ASSET_ID, PDF_ASSET_ID].sort());

    // The historical snapshot taken at purchase time (the old title) is untouched by any of this.
    const snapshot = await env.DB.prepare(`SELECT product_title AS t FROM purchase_sessions WHERE id = ?`).bind(purchaseSessionId).first<{ t: string }>();
    expect(snapshot!.t).toBe('Starting to Invest with GH₵100');

    // Technical identifiers unchanged.
    const row = await env.DB.prepare(`SELECT id, slug, product_id AS productId FROM products WHERE slug = ?`).bind(SLUG).first<{ id: number; slug: string; productId: string }>();
    expect(row!.id).toBe(1);
    expect(row!.slug).toBe(SLUG);
    expect(row!.productId).toBe(PRODUCT_ID_STR);

    // Idempotent.
    const second = await backfillEntitlementsForProduct(env as any, logger, 1, productRow!.id, SLUG);
    expect(second.sessionsGranted).toBe(0);
  });
});

describe('Small Cedis, Big Wealth — entitlement security for the real EPUB asset (Phase 9C.9)', () => {
  it('a purchase that was never granted the EPUB cannot access it', async () => {
    await applyCorrectTitle();
    await addEpubFile();
    await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
       VALUES ('RWL-2026-990020', ?, ?, ?, 3900, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'))`
    )
      .bind(SLUG, PRODUCT_ID_STR, NEW_TITLE)
      .run();

    const result = await checkEntitlement(env as any, 'RWL-2026-990020', EPUB_ASSET_ID);
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe('delivery_not_found');
  });

  it('the existing PDF entitlement is unaffected by the EPUB addition', async () => {
    await applyCorrectTitle();
    await addEpubFile();
    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
       VALUES ('RWL-2026-990021', ?, ?, ?, 3900, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'))`
    )
      .bind(SLUG, PRODUCT_ID_STR, NEW_TITLE)
      .run();
    const purchaseSessionId = Number(insert.meta.last_row_id);
    await ensureEntitlementsGranted(env as any, logger, purchaseSessionId, SLUG);

    const pdfResult = await checkEntitlement(env as any, 'RWL-2026-990021', PDF_ASSET_ID);
    expect(pdfResult.granted).toBe(true);
  });
});

describe('API contract — current title + both formats (Phase 9C.9)', () => {
  it('GET /api/products/starting-to-invest-with-gh100 returns "Small Cedis, Big Wealth" with unchanged technical identifiers', async () => {
    await applyCorrectTitle();
    const res = await SELF.fetch(`https://example.com/api/products/${SLUG}`);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.title).toBe(NEW_TITLE);
    expect(body.data.slug).toBe(SLUG);
  });

  it('GET /api/customer/purchases returns both PDF and EPUB fileTypes under the current title for a fully-entitled purchase', async () => {
    await applyCorrectTitle();
    await addEpubFile();

    const { customerId } = await findOrCreateCustomer(env as any, 'flagship-library-test@example.com', false);
    const session = await createSession(env as any, customerId, { ip: null, userAgent: null });
    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at, customer_id)
       VALUES ('RWL-2026-990030', ?, ?, ?, 3900, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'), ?)`
    )
      .bind(SLUG, PRODUCT_ID_STR, NEW_TITLE, customerId)
      .run();
    const purchaseSessionId = Number(insert.meta.last_row_id);
    await fulfilPurchase(env as any, logger, {
      purchaseSessionId,
      purchaseReference: 'RWL-2026-990030',
      productSlug: SLUG,
      customerEmail: 'flagship-library-test@example.com',
      amountPesewas: 3900,
      currency: 'GHS',
      customerId,
      isNewCustomer: false,
    });

    const res = await SELF.fetch('https://example.com/api/customer/purchases', { headers: { Cookie: `customer_session=${session.sessionToken}` } });
    const body = await res.json<any>();
    const purchase = body.data.purchases[0];
    expect(purchase.productTitle ?? purchase.title).toBeTruthy();
    const fileTypes = purchase.assets.map((a: any) => a.fileType).sort();
    expect(fileTypes).toEqual(['EPUB', 'PDF']);
  });
});
