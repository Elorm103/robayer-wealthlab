/**
 * Unit tests: admin Business Alerts "missing download file" check, as it
 * applies to bundle products — fixes a real false positive found in
 * production: "financial-literacy-bundle" is correctly delivered via its
 * bundle_items and has zero product_files of its own (see
 * productCatalogService.ts's fetchCatalogProduct() and migration 0027's
 * own header comment), but the original getBusinessAlerts() query only
 * ever checked a product's own product_files, so every active bundle
 * was flagged regardless of whether its components were actually
 * fulfillable.
 *
 * Mirrors productBundles.test.ts's own seeding conventions for this
 * codebase's bundle mechanism.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getBusinessAlerts } from '../../services/admin/executiveDashboardService';
import { setBundleItems } from '../../services/productService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');

async function cleanupAll(): Promise<void> {
  await env.DB.exec('DELETE FROM bundle_items');
  await env.DB.exec('DELETE FROM product_files');
  await env.DB.exec('DELETE FROM media_assets');
  await env.DB.exec('DELETE FROM products');
  await env.DB.exec('DELETE FROM admin_users');
}

beforeEach(cleanupAll);

async function seedAdmin(): Promise<number> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', 'super_admin', 1)`)
    .bind(`admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedProduct(slug: string, title: string, opts: { pricePesewas: number | null; withPublishedFile: boolean; isBundle?: boolean }): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language, is_bundle)
     VALUES (?, ?, ?, 'investing', 'ebook', 'active', ?, 'GHS', 'one-time', 'inclusive', 'en', ?)`
  )
    .bind(`prod-${slug}`, slug, title, opts.pricePesewas, opts.isBundle ? 1 : 0)
    .run();
  const productId = Number(insert.meta.last_row_id);

  if (opts.withPublishedFile) {
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
  }

  return productId;
}

// Every seeded product below has zero reviews, which independently
// triggers this file's own unrelated "low approved review count"
// alert (getBusinessAlerts()'s first check) for every product in every
// test. Filtering by these two checks' own `key` prefix — not by
// message substring — isolates exactly the alerts under test.
const isMissingFileAlert = (a: { key: string }) => a.key.startsWith('missing-file-');
const isMissingBundleComponentAlert = (a: { key: string }) => a.key.startsWith('missing-bundle-component-file-');

describe('getBusinessAlerts — bundle download-file health check', () => {
  it('does NOT flag an active bundle for having no product_files of its own, when all its components have published files', async () => {
    const adminId = await seedAdmin();
    const bookA = await seedProduct('book-a', 'Book A', { pricePesewas: 3900, withPublishedFile: true });
    const bookB = await seedProduct('book-b', 'Book B', { pricePesewas: 4999, withPublishedFile: true });
    const bundleId = await seedProduct('financial-literacy-bundle', 'Robayer WealthLab Financial Literacy Bundle', { pricePesewas: 9999, withPublishedFile: false, isBundle: true });
    await setBundleItems(env as any, logger, adminId, bundleId, [{ itemProductId: bookA }, { itemProductId: bookB }]);

    const alerts = await getBusinessAlerts(env as any, 'all');
    expect(alerts.filter(isMissingFileAlert)).toHaveLength(0);
    expect(alerts.filter(isMissingBundleComponentAlert)).toHaveLength(0);
  });

  it('flags an active bundle and names the exact missing component when one component has no published file', async () => {
    const adminId = await seedAdmin();
    const bookA = await seedProduct('book-a', 'Book A', { pricePesewas: 3900, withPublishedFile: true });
    const bookB = await seedProduct('book-b', 'Book B — Missing File', { pricePesewas: 4999, withPublishedFile: false });
    const bundleId = await seedProduct('financial-literacy-bundle', 'Robayer WealthLab Financial Literacy Bundle', { pricePesewas: 9999, withPublishedFile: false, isBundle: true });
    await setBundleItems(env as any, logger, adminId, bundleId, [{ itemProductId: bookA }, { itemProductId: bookB }]);

    const alerts = await getBusinessAlerts(env as any, 'all');
    // Book B is itself a real, standalone, active, priced product with no
    // file — the ORIGINAL check correctly still flags it on its own
    // merits (independent of it also being a bundle component). What
    // must NOT happen is the bundle ITSELF appearing in this list — a
    // bundle correctly has zero product_files of its own, always.
    const missingFileAlerts = alerts.filter(isMissingFileAlert);
    expect(missingFileAlerts).toHaveLength(1);
    expect(missingFileAlerts[0].message).toContain('Book B — Missing File');
    expect(missingFileAlerts.some((a) => a.message.includes('Financial Literacy Bundle'))).toBe(false);

    const bundleAlerts = alerts.filter(isMissingBundleComponentAlert);
    expect(bundleAlerts).toHaveLength(1);
    expect(bundleAlerts[0].severity).toBe('critical');
    expect(bundleAlerts[0].message).toContain('Book B — Missing File');
    expect(bundleAlerts[0].message).not.toContain('"Book A"');
  });

  it('flags each missing component separately when a bundle has more than one component missing a file', async () => {
    const adminId = await seedAdmin();
    const bookA = await seedProduct('book-a', 'Book A — Missing', { pricePesewas: 3900, withPublishedFile: false });
    const bookB = await seedProduct('book-b', 'Book B — Missing', { pricePesewas: 4999, withPublishedFile: false });
    const bundleId = await seedProduct('financial-literacy-bundle', 'Robayer WealthLab Financial Literacy Bundle', { pricePesewas: 9999, withPublishedFile: false, isBundle: true });
    await setBundleItems(env as any, logger, adminId, bundleId, [{ itemProductId: bookA }, { itemProductId: bookB }]);

    const alerts = await getBusinessAlerts(env as any, 'all');
    expect(alerts.filter(isMissingBundleComponentAlert)).toHaveLength(2);
  });

  it('a regular (non-bundle) paid active product with no published file is still correctly flagged — the original check is unaffected', async () => {
    await seedProduct('lonely-book', 'Lonely Book', { pricePesewas: 3900, withPublishedFile: false });

    const alerts = await getBusinessAlerts(env as any, 'all');
    const productAlerts = alerts.filter(isMissingFileAlert);
    expect(productAlerts).toHaveLength(1);
    expect(productAlerts[0].message).toBe('"Lonely Book" is a paid, active product with no published download file.');
  });

  it('a regular product with a published file produces no missing-file alert', async () => {
    await seedProduct('healthy-book', 'Healthy Book', { pricePesewas: 3900, withPublishedFile: true });

    const alerts = await getBusinessAlerts(env as any, 'all');
    expect(alerts.filter(isMissingFileAlert)).toHaveLength(0);
  });
});
