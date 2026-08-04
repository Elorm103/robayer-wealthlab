/**
 * Unit tests: Knowledge Base document source readers — Version 5.0
 * Milestone 2. Blog/resource/product readers hit real D1 tables
 * (seeded here); product/static-page readers additionally fetch live
 * URLs, mocked via tests/outboundMock.ts's `robayerwealthlab.com`
 * case rather than the real network.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createLogger } from '../../../utils/logger';
import { getBlogPostDocuments, getResourceDocuments, getProductDocuments, getStaticPageDocuments, getCmsSettingDocuments } from '../../../services/knowledge/documentSources';
import { queueSitemapResponse, queueSitePageResponse } from '../../outboundMock';

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
    await env.DB.prepare(`INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language) VALUES ('prod-1','starting-to-invest','Starting to Invest','investing','ebook','active',3900,'GHS','one-time','inclusive','en')`).run();

    await queueSitePageResponse(
      env as any,
      '/books/starting-to-invest/',
      `<!doctype html><html><head><title>Starting to Invest | Robayer WealthLab</title></head><body><main><h1>Starting to Invest</h1><p>A practical first guide to treasury bills.</p></main></body></html>`
    );

    const docs = await getProductDocuments(env as any, logger);
    expect(docs).toHaveLength(1);
    expect(docs[0].sourceType).toBe('product');
    expect(docs[0].url).toBe('https://robayerwealthlab.com/books/starting-to-invest/');
    expect(docs[0].title).toBe('Starting to Invest | Robayer WealthLab');
    expect(docs[0].text).toContain('practical first guide');
  });

  it('getProductDocuments skips a product whose page fetch fails (never throws for the whole batch)', async () => {
    await env.DB.prepare(`INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language) VALUES ('prod-2','missing-page','Missing Page','investing','ebook','active',3900,'GHS','one-time','inclusive','en')`).run();
    // No queued page response — outboundMock's default for an unqueued robayerwealthlab.com path is a 404.

    const docs = await getProductDocuments(env as any, logger);
    expect(docs).toHaveLength(0);
  });

  it('getStaticPageDocuments crawls the real sitemap, excludes given URLs, and always excludes /resources/', async () => {
    await queueSitemapResponse(
      env as any,
      `<?xml version="1.0"?><urlset>
        <url><loc>https://robayerwealthlab.com/investment-centre/treasury-bills/</loc></url>
        <url><loc>https://robayerwealthlab.com/resources/</loc></url>
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
