/**
 * Integration test: migration 0057_affiliate_resources_seed.sql's real
 * effect on D1, verified against the actual rows the migration leaves
 * behind (not a fixture this file seeds itself) — deliberately no
 * beforeEach touching affiliate_resources, unlike
 * affiliateResources.test.ts's own fixture-driven tests.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('0057_affiliate_resources_seed.sql', () => {
  it('seeds exactly 14 published resources: 7 per product for both requested books', async () => {
    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM affiliate_resources`).first<{ n: number }>();
    expect(total?.n).toBe(14);

    const perProduct = await env.DB.prepare(
      `SELECT product_slug AS slug, COUNT(*) AS n FROM affiliate_resources GROUP BY product_slug ORDER BY product_slug`
    ).all<{ slug: string; n: number }>();
    expect(perProduct.results).toEqual([
      { slug: 'treasury-bills-made-simple', n: 7 },
      { slug: 'understanding-the-ghana-stock-exchange', n: 7 },
    ]);

    const allPublished = await env.DB.prepare(`SELECT COUNT(*) AS n FROM affiliate_resources WHERE status != 'published'`).first<{ n: number }>();
    expect(allPublished?.n).toBe(0);
  });

  it('seeds exactly one product_copy kit row per product', async () => {
    const kits = await env.DB.prepare(`SELECT product_slug AS slug, COUNT(*) AS n FROM affiliate_resources WHERE category = 'product_copy' GROUP BY product_slug`).all<{ slug: string; n: number }>();
    expect(kits.results).toEqual(
      expect.arrayContaining([
        { slug: 'treasury-bills-made-simple', n: 1 },
        { slug: 'understanding-the-ghana-stock-exchange', n: 1 },
      ])
    );
  });

  it('every shareable copy variant (WhatsApp, Facebook, TikTok, Instagram, LinkedIn) carries a {{link}} token; the short hook deliberately does not', async () => {
    const shareable = await env.DB.prepare(
      `SELECT body FROM affiliate_resources WHERE category IN ('message_template', 'social_caption', 'script')`
    ).all<{ body: string }>();
    expect(shareable.results.length).toBe(10);
    shareable.results.forEach((row) => {
      expect(row.body).toContain('{{link}}');
    });

    const hooks = await env.DB.prepare(`SELECT body FROM affiliate_resources WHERE category = 'guidance'`).all<{ body: string }>();
    expect(hooks.results.length).toBe(2);
    hooks.results.forEach((row) => {
      expect(row.body).not.toContain('{{link}}');
    });
  });

  // Note: treasury-bills-made-simple and understanding-the-ghana-stock-exchange
  // are admin-created content that exists in production but is not seeded
  // by any migration (see 0009_migrate_json_products.sql's own scope,
  // limited to the 2 products that existed at that time) — a fresh
  // migrations-only D1 (this test's own environment) has no matching
  // `products` rows for either slug. The real product facts this
  // migration's copy is grounded in (title, shortDescription, cover,
  // active status) were verified directly against the live
  // GET /api/products response at authoring time, not re-checked here.
});
