/**
 * Version 4.2.6 (Worker-Rendered Homepage) regression tests.
 *
 * GET / used to be served entirely by GitHub Pages as a static file,
 * with the hero/Featured eBook cover, title, subtitle, and CTA filled
 * in client-side after an /api/products fetch resolved — see
 * docs/v4.2.5-hero-cover-flicker-root-cause-report.md for why that
 * structurally guarantees a visible placeholder window on every cold
 * load. This route makes the Worker the one exception on the domain
 * root: it renders the real, current featured product's data directly
 * into the HTML response, so the raw response body (not just the DOM
 * after JS runs) already contains the finished hero.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';

const SLUG = 'test-homepage-featured';
const STORAGE_KEY = 'media/images/uncategorized/test-homepage-cover.png';

let otherFeaturedSlugs: string[] = [];

beforeEach(async () => {
  // Isolation without a destructive full-table wipe (which 405s on a
  // FOREIGN KEY constraint against fixture data in this test DB):
  // getHomepageFeaturedProduct() picks the single most-recently-created
  // featured+active product across the whole table, so any other
  // already-featured product would otherwise silently win the ORDER BY.
  // Un-feature everything else for the duration of this suite, then
  // restore it in afterEach.
  const { results } = await env.DB.prepare(`SELECT slug FROM products WHERE featured = 1 AND slug != ?`).bind(SLUG).all<{ slug: string }>();
  otherFeaturedSlugs = results.map((r) => r.slug);
  if (otherFeaturedSlugs.length > 0) {
    await env.DB.prepare(`UPDATE products SET featured = 0 WHERE slug != ?`).bind(SLUG).run();
  }

  await env.DB.prepare('DELETE FROM products WHERE slug = ?').bind(SLUG).run();
  await env.DB.prepare('DELETE FROM media_assets WHERE storage_key = ?').bind(STORAGE_KEY).run();

  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('cover.png', 'cover.png', 'image/png', 512, 'homepage-test-hash', ?, ?, 'image', 'uncategorized', 'ready')`
  )
    .bind(STORAGE_KEY, `/api/media/file/${STORAGE_KEY}`)
    .run();
  const mediaId = Number(mediaInsert.meta.last_row_id);

  await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, subtitle, short_description, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language, featured, cover_media_id)
     VALUES ('prod-homepage-test', ?, 'Test Featured Title', 'Test Featured Subtitle', 'Test short description.', 'investing', 'ebook', 'active', 4900, 'GHS', 'one-time', 'inclusive', 'en', 1, ?)`
  )
    .bind(SLUG, mediaId)
    .run();
});

afterEach(async () => {
  await env.DB.prepare('DELETE FROM products WHERE slug = ?').bind(SLUG).run();
  await env.DB.prepare('DELETE FROM media_assets WHERE storage_key = ?').bind(STORAGE_KEY).run();
  if (otherFeaturedSlugs.length > 0) {
    const placeholders = otherFeaturedSlugs.map(() => '?').join(',');
    await env.DB.prepare(`UPDATE products SET featured = 1 WHERE slug IN (${placeholders})`).bind(...otherFeaturedSlugs).run();
  }
});

describe('GET / — Worker-rendered homepage', () => {
  it('the raw HTML already contains the real cover URL, title, price, and slug — not a placeholder or empty src', async () => {
    const res = await SELF.fetch('https://example.com/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const html = await res.text();

    // The real cover URL must be present as a real src attribute, not
    // an empty string, not data-src, not a hardcoded placeholder file.
    expect(html).toContain(`src="/api/media/file/${STORAGE_KEY}"`);
    expect(html).not.toContain('data-feature-cover-img alt="" hidden');

    // The real title and price must be in the raw response body.
    expect(html).toContain('Test Featured Title');
    expect(html).toContain('GH₵49.00');
    expect(html).toContain(`/books/${SLUG}/`);

    // The <link rel=preload> hint for the cover image.
    expect(html).toContain(`<link rel="preload" as="image" href="/api/media/file/${STORAGE_KEY}">`);
  });

  it('the placeholder text elements are hidden once a real cover is injected', async () => {
    const res = await SELF.fetch('https://example.com/');
    const html = await res.text();
    // Both [data-feature-placeholder] spans (Hero + Featured eBook)
    // must carry the hidden attribute once a real cover exists. Scoped
    // to a single tag's own attributes ([^<>]*, not [^>]*) so this
    // can't accidentally span into unrelated HTML comment prose that
    // happens to mention both words near each other.
    const placeholderMatches = html.match(/<span[^<>]*data-feature-placeholder[^<>]*>/g) ?? [];
    expect(placeholderMatches.length).toBe(2);
    placeholderMatches.forEach((tag) => expect(tag).toContain('hidden'));
  });

  it('falls back to the untouched static template when there is no eligible featured product', async () => {
    await env.DB.prepare('UPDATE products SET featured = 0 WHERE slug = ?').bind(SLUG).run();
    const res = await SELF.fetch('https://example.com/');
    expect(res.status).toBe(200);
    const html = await res.text();
    // Static fallback copy from index.html itself, untouched.
    expect(html).toContain('Small Cedis, Big Wealth');
  });
});
