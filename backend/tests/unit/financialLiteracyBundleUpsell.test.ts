/**
 * Unit tests: Financial Literacy Bundle post-purchase upsell eligibility
 * — Revenue Engine Phase 6. Exercises fulfilmentService.ts's
 * getFulfilmentStatus()'s bundleUpsell field directly against a real D1
 * instance, seeded with the same shape as the real bundle product
 * (products.is_bundle=1, slug='financial-literacy-bundle', bundle_items
 * linking its 3 real components) — mirrors productBundles.test.ts's own
 * seeding conventions for this codebase's bundle mechanism.
 *
 * Bundle launch business decision (production release phase) — the
 * post-purchase full-bundle offer is currently DISABLED
 * (POST_PURCHASE_BUNDLE_UPSELL_DISABLED = true in fulfilmentService.ts):
 * buying the two missing books individually is cheaper than the flat
 * GH₵99.99 bundle price in 2 of its 3 possible first-purchase scenarios,
 * so it was suppressed rather than shipped as a bad deal, pending a
 * proper partial-completion offer in a later phase. Every case below
 * therefore asserts `null`, including the one case that would have been
 * eligible under the ownership rule alone — proving the master switch
 * suppresses it even where the underlying (still-intact) eligibility
 * logic would otherwise have said yes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getFulfilmentStatus } from '../../services/fulfilmentService';
import { setBundleItems } from '../../services/productService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');

const BOOK_A = 'starting-to-invest-with-gh100';
const BOOK_B = 'understanding-the-ghana-stock-exchange';
const BOOK_C = 'treasury-bills-made-simple';
const BUNDLE_SLUG = 'financial-literacy-bundle';

async function cleanupAll(): Promise<void> {
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM bundle_items');
  await env.DB.exec('DELETE FROM product_files');
  await env.DB.exec('DELETE FROM media_assets');
  await env.DB.exec('DELETE FROM products');
  await env.DB.exec('DELETE FROM admin_users');
}

async function seedAdmin(): Promise<number> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', 'super_admin', 1)`)
    .bind(`admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedBook(slug: string, title: string, pricePesewas: number): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES (?, ?, ?, 'investing', 'ebook', 'active', ?, 'GHS', 'one-time', 'inclusive', 'en')`
  )
    .bind(`prod-${slug}`, slug, title, pricePesewas)
    .run();
  const productId = Number(insert.meta.last_row_id);

  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES (?, ?, 'application/pdf', 1024, 'deadbeef', ?, ?, 'document', 'books', 'ready')`
  )
    .bind(`${slug}.pdf`, `${slug}.pdf`, `ebooks/${slug}.pdf`, `https://example.com/${slug}.pdf`)
    .run();
  const mediaId = Number(mediaInsert.meta.last_row_id);

  await env.DB.prepare(
    `INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status)
     VALUES (?, ?, ?, ?, 'PDF', 'published')`
  )
    .bind(productId, `asset-${slug}-v1`, mediaId, `${title} (PDF)`)
    .run();

  return productId;
}

async function seedBundleProduct(status: 'active' | 'draft', pricePesewas: number, salePricePesewas: number | null): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, sale_price_pesewas, sale_enabled, currency, pricing_model, tax_behavior, language, is_bundle)
     VALUES (?, ?, 'Robayer WealthLab Financial Literacy Bundle', 'investing', 'ebook', ?, ?, ?, ?, 'GHS', 'one-time', 'inclusive', 'en', 1)`
  )
    .bind(`prod-${BUNDLE_SLUG}`, BUNDLE_SLUG, status, pricePesewas, salePricePesewas, salePricePesewas !== null ? 1 : 0)
    .run();
  return Number(insert.meta.last_row_id);
}

async function insertVerifiedPurchase(email: string, productSlug: string, productId: string, productTitle: string, amountPesewas: number, reference: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_email, verified_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'GHS', 'verified', ?, datetime('now'), datetime('now', '+30 minutes'))`
  )
    .bind(reference, productSlug, productId, productTitle, amountPesewas, email)
    .run();
}

async function seedFullCatalog(adminId: number, bundleStatus: 'active' | 'draft' = 'active'): Promise<void> {
  const bookA = await seedBook(BOOK_A, 'Small Cedis, Big Wealth', 3900);
  const bookB = await seedBook(BOOK_B, 'Understanding the Ghana Stock Exchange', 4999);
  const bookC = await seedBook(BOOK_C, 'Treasury Bills Made Simple', 3999);
  const bundleId = await seedBundleProduct(bundleStatus, 13997, 9999);
  await setBundleItems(env as any, logger, adminId, bundleId, [{ itemProductId: bookA }, { itemProductId: bookB }, { itemProductId: bookC }]);
}

describe('getFulfilmentStatus — bundleUpsell eligibility (Revenue Engine Phase 6)', () => {
  beforeEach(cleanupAll);

  it('suppresses the offer even for a customer whose only bundle-component purchase ever is this one — the master switch overrides the ownership rule, per the approved launch decision', async () => {
    const adminId = await seedAdmin();
    await seedFullCatalog(adminId);
    await insertVerifiedPurchase('buyer@example.com', BOOK_A, 'prod-' + BOOK_A, 'Small Cedis, Big Wealth', 3900, 'RWL-2026-900001');

    const status = await getFulfilmentStatus(env as any, 'RWL-2026-900001');
    expect(status?.bundleUpsell).toBeNull();
  });

  it('suppresses the offer for a customer who already owns another bundle component before this purchase', async () => {
    const adminId = await seedAdmin();
    await seedFullCatalog(adminId);
    await insertVerifiedPurchase('repeat-buyer@example.com', BOOK_A, 'prod-' + BOOK_A, 'Small Cedis, Big Wealth', 3900, 'RWL-2026-900002');
    await insertVerifiedPurchase('repeat-buyer@example.com', BOOK_B, 'prod-' + BOOK_B, 'Understanding the Ghana Stock Exchange', 4999, 'RWL-2026-900003');

    const status = await getFulfilmentStatus(env as any, 'RWL-2026-900003');
    expect(status?.bundleUpsell).toBeNull();
  });

  it('suppresses the offer for a customer who already owns all 3 components', async () => {
    const adminId = await seedAdmin();
    await seedFullCatalog(adminId);
    await insertVerifiedPurchase('full-owner@example.com', BOOK_A, 'prod-' + BOOK_A, 'Small Cedis, Big Wealth', 3900, 'RWL-2026-900004');
    await insertVerifiedPurchase('full-owner@example.com', BOOK_B, 'prod-' + BOOK_B, 'Understanding the Ghana Stock Exchange', 4999, 'RWL-2026-900005');
    await insertVerifiedPurchase('full-owner@example.com', BOOK_C, 'prod-' + BOOK_C, 'Treasury Bills Made Simple', 3999, 'RWL-2026-900006');

    const status = await getFulfilmentStatus(env as any, 'RWL-2026-900006');
    expect(status?.bundleUpsell).toBeNull();
  });

  it('never offers the bundle on the bundle purchase itself', async () => {
    const adminId = await seedAdmin();
    await seedFullCatalog(adminId);
    await insertVerifiedPurchase('bundle-buyer@example.com', BUNDLE_SLUG, 'prod-' + BUNDLE_SLUG, 'Robayer WealthLab Financial Literacy Bundle', 9999, 'RWL-2026-900007');

    const status = await getFulfilmentStatus(env as any, 'RWL-2026-900007');
    expect(status?.bundleUpsell).toBeNull();
  });

  it('returns null when the bundle product is not active (draft)', async () => {
    const adminId = await seedAdmin();
    await seedFullCatalog(adminId, 'draft');
    await insertVerifiedPurchase('early-buyer@example.com', BOOK_A, 'prod-' + BOOK_A, 'Small Cedis, Big Wealth', 3900, 'RWL-2026-900008');

    const status = await getFulfilmentStatus(env as any, 'RWL-2026-900008');
    expect(status?.bundleUpsell).toBeNull();
  });

  it('returns null for a purchase of a product unrelated to the bundle', async () => {
    const adminId = await seedAdmin();
    await seedFullCatalog(adminId);
    await seedBook('unrelated-guide', 'An Unrelated Guide', 1000);
    await insertVerifiedPurchase('other-buyer@example.com', 'unrelated-guide', 'prod-unrelated-guide', 'An Unrelated Guide', 1000, 'RWL-2026-900009');

    const status = await getFulfilmentStatus(env as any, 'RWL-2026-900009');
    expect(status?.bundleUpsell).toBeNull();
  });

  it('returns null when no bundle product exists at all (pre-launch safety)', async () => {
    await seedBook(BOOK_A, 'Small Cedis, Big Wealth', 3900);
    await insertVerifiedPurchase('lonely-buyer@example.com', BOOK_A, 'prod-' + BOOK_A, 'Small Cedis, Big Wealth', 3900, 'RWL-2026-900010');

    const status = await getFulfilmentStatus(env as any, 'RWL-2026-900010');
    expect(status?.bundleUpsell).toBeNull();
  });
});
