/**
 * Unit tests: Knowledge Base document source readers — Version 5.0
 * Milestone 2. Blog/resource/product readers hit real D1 tables
 * (seeded here); product/static-page readers additionally fetch live
 * URLs, mocked via tests/outboundMock.ts's `robayerwealthlab.com`
 * case rather than the real network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createLogger } from '../../../utils/logger';
import { getBlogPostDocuments, getResourceDocuments, getProductDocuments, getStaticPageDocuments, getCmsSettingDocuments } from '../../../services/knowledge/documentSources';
import { queueSitemapResponse, queueSitePageResponse } from '../../outboundMock';
import * as booksModule from '../../../routes/books';

const logger = createLogger('test-request-id', 'test');

describe('documentSources', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM blog_posts');
    await env.DB.exec('DELETE FROM resources');
    // Scoped to this file's own test slugs only — a blanket DELETE FROM
    // products can fail with a FOREIGN KEY constraint error against
    // product_files/order rows other test files may have left behind
    // in this shared local D1 instance.
    await env.DB.prepare(`DELETE FROM products WHERE slug IN ('starting-to-invest', 'missing-page')`).run();
    // CI/test-infrastructure fix (2026-09-16) — migration
    // 0009_migrate_json_products.sql seeds one real, permanently
    // 'active' product ('starting-to-invest-with-gh100', a genuine live
    // product other tests reference by slug — never delete it). Every
    // getProductDocuments() test below counts ALL active products, so
    // without this it always saw that real row *plus* whatever it
    // seeded itself (e.g. expected 1, got 2). Archiving (not deleting)
    // it here is scoped to this file's own isolated D1 instance — see
    // "Storage isolation is per test file" in Cloudflare's vitest-pool-
    // workers docs — so it never affects the other test files that
    // rely on this product still being 'active' in their own instance.
    await env.DB.exec(`UPDATE products SET status = 'archived' WHERE status = 'active'`);
    await env.DB.exec(`DELETE FROM site_settings WHERE key = 'hero_content'`);
  });

  it('getBlogPostDocuments reads only published, non-deleted posts', async () => {
    await env.DB.prepare(`INSERT INTO blog_posts (post_id, slug, title, excerpt, body, category, status) VALUES ('p1','treasury-bills','Treasury Bills','A guide','<p>Full body text.</p>','investing','published')`).run();
    await env.DB.prepare(`INSERT INTO blog_posts (post_id, slug, title, category, status) VALUES ('p2','draft-post','Draft Post','investing','draft')`).run();

    const docs = await getBlogPostDocuments(env as any);
    expect(docs).toHaveLength(1);
    expect(docs[0].documentKey).toMatch(/^blog_post:\d+$/);
    expect(docs[0].sourceType).toBe('blog_post');
    expect(docs[0].url).toBe('https://robayerwealthlab.com/blog/treasury-bills/');
    expect(docs[0].text).toContain('A guide');
    expect(docs[0].text).toContain('Full body text.');
    expect(docs[0].dataClassification).toBe('PRODUCTION');
  });

  it('getResourceDocuments reads only published, non-deleted resources, citing the listing page anchor', async () => {
    await env.DB.prepare(
      `INSERT INTO resources (resource_id, slug, title, short_description, description, category, format, status) VALUES ('r1','budget-planner','Budget Planner','A simple template','<p>Details here.</p>','budgeting','template','published')`
    ).run();

    const docs = await getResourceDocuments(env as any);
    expect(docs).toHaveLength(1);
    expect(docs[0].url).toBe('https://robayerwealthlab.com/resources/#budget-planner');
    expect(docs[0].text).toContain('A simple template');
  });

  it('getProductDocuments fetches the live book detail page for each active product and extracts its main content', async () => {
    // CI/test-infrastructure fix (2026-09-16) — getProductDocuments()
    // (services/knowledge/documentSources.ts) was refactored to call
    // renderBookDetail() directly, in-process (see that function's own
    // header comment: a same-zone fetch() from inside this Worker was
    // confirmed via production logs to 404 for this exact URL despite
    // working for every external caller). queueSitePageResponse() only
    // affects outboundMock's simulated *network* fetch, so it has no
    // effect here any more — this test previously passed only because
    // an unrelated bug (an always-'active' seeded product from
    // migration 0009, fixed in this same beforeEach above) made the
    // length assertion fail before the stale mock's absence could ever
    // be observed. Asserting against the real renderer's own output
    // (a `description` field feeding its content, and its real
    // `${title} | ${SITE_NAME}` convention — see routes/books.ts) tests
    // what actually runs today instead of a mock nothing reads.
    await env.DB.prepare(
      `INSERT INTO products (product_id, slug, title, description, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language) VALUES ('prod-1','starting-to-invest','Starting to Invest','<p>A practical first guide to treasury bills.</p>','investing','ebook','active',3900,'GHS','one-time','inclusive','en')`
    ).run();

    const docs = await getProductDocuments(env as any, logger);
    expect(docs).toHaveLength(1);
    expect(docs[0].sourceType).toBe('product');
    expect(docs[0].url).toBe('https://robayerwealthlab.com/books/starting-to-invest/');
    expect(docs[0].title).toBe('Starting to Invest | Robayer WealthLab');
    expect(docs[0].text).toContain('practical first guide');
  });

  it('skips a product whose render throws, without losing the rest of the batch (never throws for the whole batch)', async () => {
    // CI/test-infrastructure fix (2026-09-16) — this test originally
    // simulated a page-fetch failure via outboundMock, matching an
    // older architecture where getProductDocuments() made a real
    // network fetch(). Under the current in-process-render design
    // (see the previous test's comment), any row selected by this
    // function's own `WHERE status = 'active'` query is *guaranteed*
    // to render successfully (renderBookDetail()'s only failure path,
    // "status not publicly listed", can never be true for a row that
    // query already filtered to 'active') — so a plain active product
    // can no longer exercise the skip-on-failure branch at all. Mocking
    // renderBookDetail() itself (rather than the network) is what
    // actually exercises getProductDocuments()'s real try/catch
    // resilience today.
    const spy = vi.spyOn(booksModule, 'renderBookDetail').mockRejectedValueOnce(new Error('simulated render failure'));
    await env.DB.prepare(
      `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language) VALUES ('prod-2','missing-page','Missing Page','investing','ebook','active',3900,'GHS','one-time','inclusive','en')`
    ).run();

    const docs = await getProductDocuments(env as any, logger);
    expect(docs).toHaveLength(0);
    spy.mockRestore();
  });

  it('getStaticPageDocuments crawls the real sitemap and excludes given URLs', async () => {
    await queueSitemapResponse(
      env as any,
      `<?xml version="1.0"?><urlset>
        <url><loc>https://robayerwealthlab.com/investment-centre/treasury-bills/</loc></url>
        <url><loc>https://robayerwealthlab.com/blog/already-covered/</loc></url>
      </urlset>`
    );
    await queueSitePageResponse(
      env as any,
      '/investment-centre/treasury-bills/',
      `<!doctype html><html><head><title>Treasury Bills</title></head><body><main><p>Educational content about treasury bills.</p></main></body></html>`
    );

    const docs = await getStaticPageDocuments(env as any, new Set(['https://robayerwealthlab.com/blog/already-covered/']), logger);
    expect(docs).toHaveLength(1);
    expect(docs[0].url).toBe('https://robayerwealthlab.com/investment-centre/treasury-bills/');
    expect(docs[0].sourceType).toBe('static_page');
    expect(docs[0].documentKey).toBe('static_page:/investment-centre/treasury-bills/');
  });

  it('getStaticPageDocuments now includes the /resources/ listing page itself, not just individual resource items', async () => {
    // Version 5.0 Milestone 2.2 refinement — real production evidence
    // showed "What resources are available?" never retrieved anything
    // useful because the listing page was excluded from the crawl on
    // the assumption individual resource items covered it; they don't
    // share the query's vocabulary. See documentSources.ts's own header
    // comment on getStaticPageDocuments() for the full reasoning.
    await queueSitemapResponse(env as any, `<?xml version="1.0"?><urlset><url><loc>https://robayerwealthlab.com/resources/</loc></url></urlset>`);
    await queueSitePageResponse(
      env as any,
      '/resources/',
      `<!doctype html><html><head><title>Resources | Robayer WealthLab</title></head><body><main><p>Free guides, templates, and tools to help you build wealth.</p></main></body></html>`
    );

    const docs = await getStaticPageDocuments(env as any, new Set(), logger);
    expect(docs).toHaveLength(1);
    expect(docs[0].url).toBe('https://robayerwealthlab.com/resources/');
    expect(docs[0].sourceType).toBe('static_page');
    expect(docs[0].documentKey).toBe('static_page:/resources/');
    expect(docs[0].text).toContain('Free guides, templates, and tools');
  });

  it('getCmsSettingDocuments reads hero_content when configured, and returns nothing when absent', async () => {
    const empty = await getCmsSettingDocuments(env as any);
    expect(empty).toHaveLength(0);

    await env.DB.prepare(`INSERT INTO site_settings (key, value) VALUES ('hero_content', ?)`)
      .bind(JSON.stringify({ eyebrow: 'Financial education for Ghana', headline: 'Learn to invest.', subheading: 'Practical guidance.' }))
      .run();

    const docs = await getCmsSettingDocuments(env as any);
    expect(docs).toHaveLength(1);
    expect(docs[0].documentKey).toBe('cms_setting:hero_content');
    expect(docs[0].text).toContain('Learn to invest.');
  });
});
