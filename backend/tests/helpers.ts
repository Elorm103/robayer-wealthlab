/**
 * Shared test helpers — Version 3.0.2 Milestone M1. The test D1
 * instance starts with only the schema applied (see
 * tests/apply-migrations.ts), no seed data — every test that needs a
 * real product/asset to exercise checkout/fulfilment against seeds one
 * itself via these helpers, kept isolated per test via beforeEach
 * DELETE statements in each suite.
 */
import type { Env } from '../worker/env';

export const TEST_PRODUCT_SLUG = 'test-guide';
export const TEST_ASSET_ID = 'asset-test-guide-pdf-v1';

/** Seeds a minimal, valid, purchasable product with one published digital asset — mirrors the real flagship product's shape closely enough for checkout/fulfilment tests. */
export async function seedTestProduct(env: Env, overrides: { pricePesewas?: number } = {}): Promise<void> {
  const price = overrides.pricePesewas ?? 3900;

  await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES ('prod-test-guide', ?, 'Test Guide', 'investing', 'ebook', 'active', ?, 'GHS', 'one-time', 'inclusive', 'en')`
  )
    .bind(TEST_PRODUCT_SLUG, price)
    .run();

  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('test-guide.pdf', 'test-guide.pdf', 'application/pdf', 1024, 'deadbeef', 'ebooks/test-guide.pdf', 'https://example.com/test-guide.pdf', 'document', 'books', 'ready')`
  ).run();
  const mediaId = Number(mediaInsert.meta.last_row_id);

  const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();

  await env.DB.prepare(
    `INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status)
     VALUES (?, ?, ?, 'Test Guide (PDF)', 'PDF', 'published')`
  )
    .bind(productRow!.id, TEST_ASSET_ID, mediaId)
    .run();
}

export async function cleanupTestProduct(env: Env): Promise<void> {
  await env.DB.exec('DELETE FROM product_files');
  await env.DB.exec('DELETE FROM media_assets');
  await env.DB.exec('DELETE FROM products');
}
