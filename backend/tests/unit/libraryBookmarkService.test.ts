/**
 * Unit tests: libraryBookmarkService.ts — Digital Library 2.0, Feature
 * 5 (Bookmarks). Mirrors libraryProgressService.test.ts's own
 * authorization-first coverage: ownership isolation, format matching,
 * and the one real structural difference from progress — a delivery
 * can have MANY bookmarks, not one current position.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createBookmark, listBookmarksForAsset, listAllBookmarks, deleteBookmark } from '../../services/customer/libraryBookmarkService';
import { createLogger } from '../../utils/logger';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG, TEST_ASSET_ID } from '../helpers';

const logger = createLogger('test-request-id', 'test');
const CUSTOMER_A = 2001;
const CUSTOMER_B = 2002;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM library_bookmarks');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);

  await env.DB.prepare(`INSERT INTO customers (id, email, status) VALUES (?, 'bookmark-a@example.com', 'active')`).bind(CUSTOMER_A).run();
  await env.DB.prepare(`INSERT INTO customers (id, email, status) VALUES (?, 'bookmark-b@example.com', 'active')`).bind(CUSTOMER_B).run();
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
     VALUES ('test-guide.epub', 'test-guide.epub', 'application/epub+zip', 2048, 'bmfeed', 'ebooks/test-guide.epub', 'https://example.com/test-guide.epub', 'document', 'books', 'ready')`
  ).run();
  const mediaId = Number(mediaInsert.meta.last_row_id);
  const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
  await env.DB.prepare(`INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status) VALUES (?, ?, ?, 'Test Guide (EPUB)', 'EPUB', 'published')`)
    .bind(productRow!.id, epubAssetId, mediaId)
    .run();
  return epubAssetId;
}

describe('createBookmark', () => {
  it('creates a real PDF bookmark for an owned asset, with a real label', async () => {
    await seedVerifiedPurchase('RWL-2026-820001', CUSTOMER_A);
    const result = await createBookmark(env as any, logger, CUSTOMER_A, 'RWL-2026-820001', TEST_ASSET_ID, { format: 'PDF', pageNumber: 12, label: 'Chapter 3 — Risk' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.format).toBe('PDF');
    expect(result.record.pageNumber).toBe(12);
    expect(result.record.cfi).toBeNull();
    expect(result.record.label).toBe('Chapter 3 — Risk');
  });

  it('creates a real EPUB bookmark with no label — NULL is honest, not fabricated', async () => {
    const epubAssetId = await seedEpubAsset();
    await seedVerifiedPurchase('RWL-2026-820002', CUSTOMER_A);
    await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) SELECT id, ?, ?, 10, 0, 'delivered' FROM purchase_sessions WHERE purchase_reference = 'RWL-2026-820002'`)
      .bind(epubAssetId, TEST_PRODUCT_SLUG)
      .run();

    const result = await createBookmark(env as any, logger, CUSTOMER_A, 'RWL-2026-820002', epubAssetId, { format: 'EPUB', cfi: 'epubcfi(/6/10!/4/2/1:0)', label: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.format).toBe('EPUB');
    expect(result.record.cfi).toBe('epubcfi(/6/10!/4/2/1:0)');
    expect(result.record.pageNumber).toBeNull();
    expect(result.record.label).toBeNull();
  });

  it('rejects bookmarking a purchase that does not belong to the caller', async () => {
    await seedVerifiedPurchase('RWL-2026-820003', CUSTOMER_A);
    const result = await createBookmark(env as any, logger, CUSTOMER_B, 'RWL-2026-820003', TEST_ASSET_ID, { format: 'PDF', pageNumber: 5, label: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_authorized');
  });

  it('rejects a format mismatch (claiming EPUB on a PDF-only asset)', async () => {
    await seedVerifiedPurchase('RWL-2026-820004', CUSTOMER_A);
    const result = await createBookmark(env as any, logger, CUSTOMER_A, 'RWL-2026-820004', TEST_ASSET_ID, { format: 'EPUB', cfi: 'epubcfi(/6/2!/4)', label: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported_format');
  });

  it('allows multiple bookmarks on the same purchased asset — unlike progress, this is a real one-to-many relationship', async () => {
    await seedVerifiedPurchase('RWL-2026-820005', CUSTOMER_A);
    await createBookmark(env as any, logger, CUSTOMER_A, 'RWL-2026-820005', TEST_ASSET_ID, { format: 'PDF', pageNumber: 5, label: 'First' });
    await createBookmark(env as any, logger, CUSTOMER_A, 'RWL-2026-820005', TEST_ASSET_ID, { format: 'PDF', pageNumber: 20, label: 'Second' });
    const list = await listBookmarksForAsset(env as any, CUSTOMER_A, 'RWL-2026-820005', TEST_ASSET_ID);
    expect(list).toHaveLength(2);
  });
});

describe('listBookmarksForAsset', () => {
  it("never returns another customer's bookmarks", async () => {
    await seedVerifiedPurchase('RWL-2026-820010', CUSTOMER_A);
    await createBookmark(env as any, logger, CUSTOMER_A, 'RWL-2026-820010', TEST_ASSET_ID, { format: 'PDF', pageNumber: 8, label: null });

    const asOwner = await listBookmarksForAsset(env as any, CUSTOMER_A, 'RWL-2026-820010', TEST_ASSET_ID);
    expect(asOwner).toHaveLength(1);

    const asOther = await listBookmarksForAsset(env as any, CUSTOMER_B, 'RWL-2026-820010', TEST_ASSET_ID);
    expect(asOther).toHaveLength(0);
  });
});

describe('listAllBookmarks', () => {
  it("returns only this customer's bookmarks across their whole purchase history", async () => {
    await seedVerifiedPurchase('RWL-2026-820020', CUSTOMER_A);
    await createBookmark(env as any, logger, CUSTOMER_A, 'RWL-2026-820020', TEST_ASSET_ID, { format: 'PDF', pageNumber: 3, label: null });

    const otherInsert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, expires_at)
       VALUES ('RWL-2026-820021', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', ?, datetime('now', '+30 minutes'))`
    )
      .bind(TEST_PRODUCT_SLUG, CUSTOMER_B)
      .run();
    await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) VALUES (?, ?, ?, 10, 0, 'delivered')`)
      .bind(Number(otherInsert.meta.last_row_id), TEST_ASSET_ID, TEST_PRODUCT_SLUG)
      .run();
    await createBookmark(env as any, logger, CUSTOMER_B, 'RWL-2026-820021', TEST_ASSET_ID, { format: 'PDF', pageNumber: 9, label: null });

    const listForA = await listAllBookmarks(env as any, CUSTOMER_A);
    expect(listForA).toHaveLength(1);
    expect(listForA[0].purchaseReference).toBe('RWL-2026-820020');
  });
});

describe('deleteBookmark', () => {
  it('deletes only the calling customer\'s own bookmark', async () => {
    await seedVerifiedPurchase('RWL-2026-820030', CUSTOMER_A);
    const created = await createBookmark(env as any, logger, CUSTOMER_A, 'RWL-2026-820030', TEST_ASSET_ID, { format: 'PDF', pageNumber: 1, label: null });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const deniedForOther = await deleteBookmark(env as any, CUSTOMER_B, created.record.id);
    expect(deniedForOther.ok).toBe(false);

    const stillThere = await listBookmarksForAsset(env as any, CUSTOMER_A, 'RWL-2026-820030', TEST_ASSET_ID);
    expect(stillThere).toHaveLength(1);

    const deletedByOwner = await deleteBookmark(env as any, CUSTOMER_A, created.record.id);
    expect(deletedByOwner.ok).toBe(true);

    const goneNow = await listBookmarksForAsset(env as any, CUSTOMER_A, 'RWL-2026-820030', TEST_ASSET_ID);
    expect(goneNow).toHaveLength(0);
  });

  it('reports not_found for a bookmark id that never existed', async () => {
    const result = await deleteBookmark(env as any, CUSTOMER_A, 999999);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});
