/**
 * Unit tests: libraryProgressService.ts — Digital Library Phase 7B
 * (Personal Reading Experience). Covers the one genuinely new
 * authorization dimension this phase introduces (progress is bound to
 * the AUTHENTICATED customer, not just a valid reference — see the
 * service's own header comment) plus the server-derived percent/status
 * computation and cross-customer isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertLibraryProgress, getLibraryProgress, listLibraryProgress } from '../../services/customer/libraryProgressService';
import { createLogger } from '../../utils/logger';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG, TEST_ASSET_ID } from '../helpers';

const logger = createLogger('test-request-id', 'test');

const CUSTOMER_A = 1001;
const CUSTOMER_B = 1002;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM library_progress');
  await env.DB.exec('DELETE FROM download_tokens');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);

  await env.DB.prepare(`INSERT INTO customers (id, email, status) VALUES (?, 'customer-a@example.com', 'active')`).bind(CUSTOMER_A).run();
  await env.DB.prepare(`INSERT INTO customers (id, email, status) VALUES (?, 'customer-b@example.com', 'active')`).bind(CUSTOMER_B).run();
});

async function seedVerifiedPurchase(reference: string, customerId: number): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, expires_at)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', ?, datetime('now', '+30 minutes'))`
  )
    .bind(reference, TEST_PRODUCT_SLUG, customerId)
    .run();
  const purchaseSessionId = Number(insert.meta.last_row_id);

  await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) VALUES (?, ?, ?, 10, 0, 'delivered')`)
    .bind(purchaseSessionId, TEST_ASSET_ID, TEST_PRODUCT_SLUG)
    .run();

  return purchaseSessionId;
}

async function seedEpubAsset(): Promise<string> {
  const epubAssetId = 'asset-test-guide-epub-v1';
  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('test-guide.epub', 'test-guide.epub', 'application/epub+zip', 2048, 'beadfeed', 'ebooks/test-guide.epub', 'https://example.com/test-guide.epub', 'document', 'books', 'ready')`
  ).run();
  const mediaId = Number(mediaInsert.meta.last_row_id);
  const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
  await env.DB.prepare(`INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status) VALUES (?, ?, ?, 'Test Guide (EPUB)', 'EPUB', 'published')`)
    .bind(productRow!.id, epubAssetId, mediaId)
    .run();
  return epubAssetId;
}

describe('upsertLibraryProgress', () => {
  it('grants and correctly derives percent/status for an owned PDF asset, page 18 of 42', async () => {
    await seedVerifiedPurchase('RWL-2026-800001', CUSTOMER_A);
    const result = await upsertLibraryProgress(env as any, logger, CUSTOMER_A, 'RWL-2026-800001', TEST_ASSET_ID, { currentPage: 18, totalPages: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.percentComplete).toBe(Math.round((18 / 42) * 100));
      expect(result.record.status).toBe('in_progress');
      expect(result.record.currentPage).toBe(18);
      expect(result.record.totalPages).toBe(42);
    }
  });

  it('derives status="completed" at the final page (percent 100)', async () => {
    await seedVerifiedPurchase('RWL-2026-800002', CUSTOMER_A);
    const result = await upsertLibraryProgress(env as any, logger, CUSTOMER_A, 'RWL-2026-800002', TEST_ASSET_ID, { currentPage: 42, totalPages: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.percentComplete).toBe(100);
      expect(result.record.status).toBe('completed');
    }
  });

  it('derives status="not_started" only at percent 0 (page 0 is invalid, so in practice any write is in_progress+); a fresh delivery with no row at all is not_started via getLibraryProgress returning null', async () => {
    await seedVerifiedPurchase('RWL-2026-800003', CUSTOMER_A);
    const progress = await getLibraryProgress(env as any, CUSTOMER_A, 'RWL-2026-800003', TEST_ASSET_ID);
    expect(progress).toBeNull();
  });

  it('upserts in place on a second write for the same delivery, never creating a duplicate row', async () => {
    await seedVerifiedPurchase('RWL-2026-800004', CUSTOMER_A);
    await upsertLibraryProgress(env as any, logger, CUSTOMER_A, 'RWL-2026-800004', TEST_ASSET_ID, { currentPage: 5, totalPages: 42 });
    await upsertLibraryProgress(env as any, logger, CUSTOMER_A, 'RWL-2026-800004', TEST_ASSET_ID, { currentPage: 20, totalPages: 42 });

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM library_progress').first<{ n: number }>();
    expect(count!.n).toBe(1);

    const progress = await getLibraryProgress(env as any, CUSTOMER_A, 'RWL-2026-800004', TEST_ASSET_ID);
    expect(progress!.currentPage).toBe(20);
  });

  it("denies writing progress for another customer's purchase — cross-customer isolation, the core Phase 7B security requirement", async () => {
    await seedVerifiedPurchase('RWL-2026-800005', CUSTOMER_A);
    const result = await upsertLibraryProgress(env as any, logger, CUSTOMER_B, 'RWL-2026-800005', TEST_ASSET_ID, { currentPage: 5, totalPages: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_authorized');

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM library_progress').first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('rejects invalid input — currentPage greater than totalPages', async () => {
    await seedVerifiedPurchase('RWL-2026-800006', CUSTOMER_A);
    const result = await upsertLibraryProgress(env as any, logger, CUSTOMER_A, 'RWL-2026-800006', TEST_ASSET_ID, { currentPage: 50, totalPages: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_input');
  });

  it('rejects a non-PDF asset rather than silently recording meaningless page numbers', async () => {
    const epubAssetId = await seedEpubAsset();
    await seedVerifiedPurchase('RWL-2026-800007', CUSTOMER_A);
    await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) SELECT id, ?, ?, 10, 0, 'delivered' FROM purchase_sessions WHERE purchase_reference = 'RWL-2026-800007'`)
      .bind(epubAssetId, TEST_PRODUCT_SLUG)
      .run();

    const result = await upsertLibraryProgress(env as any, logger, CUSTOMER_A, 'RWL-2026-800007', epubAssetId, { currentPage: 5, totalPages: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_format');
  });
});

describe('getLibraryProgress', () => {
  it("denies reading another customer's progress", async () => {
    await seedVerifiedPurchase('RWL-2026-800010', CUSTOMER_A);
    await upsertLibraryProgress(env as any, logger, CUSTOMER_A, 'RWL-2026-800010', TEST_ASSET_ID, { currentPage: 10, totalPages: 42 });

    const asOwner = await getLibraryProgress(env as any, CUSTOMER_A, 'RWL-2026-800010', TEST_ASSET_ID);
    expect(asOwner).not.toBeNull();

    const asOther = await getLibraryProgress(env as any, CUSTOMER_B, 'RWL-2026-800010', TEST_ASSET_ID);
    expect(asOther).toBeNull();
  });
});

describe('listLibraryProgress', () => {
  it("returns only this customer's progress rows, correctly joined back to purchase reference and asset id", async () => {
    await seedVerifiedPurchase('RWL-2026-800020', CUSTOMER_A);
    await upsertLibraryProgress(env as any, logger, CUSTOMER_A, 'RWL-2026-800020', TEST_ASSET_ID, { currentPage: 30, totalPages: 42 });

    const otherProductInsert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, expires_at)
       VALUES ('RWL-2026-800021', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', ?, datetime('now', '+30 minutes'))`
    )
      .bind(TEST_PRODUCT_SLUG, CUSTOMER_B)
      .run();
    const otherPurchaseSessionId = Number(otherProductInsert.meta.last_row_id);
    await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) VALUES (?, ?, ?, 10, 0, 'delivered')`)
      .bind(otherPurchaseSessionId, TEST_ASSET_ID, TEST_PRODUCT_SLUG)
      .run();
    await upsertLibraryProgress(env as any, logger, CUSTOMER_B, 'RWL-2026-800021', TEST_ASSET_ID, { currentPage: 5, totalPages: 42 });

    const listForA = await listLibraryProgress(env as any, CUSTOMER_A);
    expect(listForA).toHaveLength(1);
    expect(listForA[0].purchaseReference).toBe('RWL-2026-800020');
    expect(listForA[0].assetId).toBe(TEST_ASSET_ID);
    expect(listForA[0].currentPage).toBe(30);
  });
});
