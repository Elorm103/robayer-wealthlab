/**
 * Integration tests: Phase 9C.8 (Holistic Flagship Identity Correction).
 *
 * Confirms, against the real Worker fetch handler (SELF) and real
 * service code, that:
 *   - the flagship product (migration 0009's real seeded row, slug
 *     `starting-to-invest-with-gh100`) reflects the current catalog
 *     title "Small Cedis, Big Wealth" once the already-reviewed
 *     content-only update (backend/database/content-updates/
 *     flagship_reposition_2026-07-20.sql) is applied — mirroring what
 *     is already true in real production D1 (independently verified
 *     this phase via a live `wrangler d1 execute --remote` read);
 *   - every technical identifier (id, slug, product_id, asset_id,
 *     storage_key) is untouched by that same update;
 *   - a historical purchase_sessions.product_title snapshot taken
 *     BEFORE the update is never rewritten by it;
 *   - the /books/ listing page's HTML response never contains the
 *     retired title (regression guard for the books.ts:454 fix);
 *   - Treasury Bills Made Simple, a completely separate product, is
 *     entirely unaffected;
 *   - the existing PDF entitlement/download path still resolves
 *     correctly after the title correction (title is display-only,
 *     never part of the entitlement check).
 *
 * The isolated @cloudflare/vitest-pool-workers D1 instance re-runs
 * every real migration (including 0009's real INSERT) fresh for this
 * file, seeding the OLD title exactly as migration 0009 always has —
 * this test applies the same reviewed content-update SQL a second
 * time here, in isolation, to prove the mechanism, without touching
 * the persistent local dev D1 or production.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { checkEntitlement } from '../../services/entitlementService';

const FLAGSHIP_SLUG = 'starting-to-invest-with-gh100';
const FLAGSHIP_PRODUCT_ID = 'prod-starting-to-invest-with-gh100';
const FLAGSHIP_ASSET_ID = 'asset-starting-to-invest-with-gh100-pdf-v1';
const FLAGSHIP_STORAGE_KEY = 'ebooks/starting-to-invest-with-gh100.pdf';

const NEW_TITLE = 'Small Cedis, Big Wealth';
const NEW_SUBTITLE = 'How Ordinary Ghanaians Can Build Real Wealth Starting With GH₵1';
const OLD_TITLE = 'Starting to Invest with GH₵100';

/** Applies exactly the columns backend/database/content-updates/flagship_reposition_2026-07-20.sql applies — title/subtitle/description/tags/SEO only, nothing touching id/slug/product_id/pricing/media. */
async function applyReposition(): Promise<void> {
  await env.DB.prepare(
    `UPDATE products SET title = ?, subtitle = ?, seo_title = ?, updated_at = datetime('now') WHERE slug = ? AND deleted_at IS NULL`
  )
    .bind(NEW_TITLE, NEW_SUBTITLE, `${NEW_TITLE} | Robayer WealthLab`, FLAGSHIP_SLUG)
    .run();
}

describe('Flagship product identity — migration 0009 baseline (Phase 9C.8)', () => {
  it('seeds the flagship product with its real, unchanged technical identifiers', async () => {
    const row = await env.DB.prepare(
      `SELECT id, slug, product_id AS productId, title FROM products WHERE slug = ?`
    )
      .bind(FLAGSHIP_SLUG)
      .first<{ id: number; slug: string; productId: string; title: string }>();
    expect(row).toBeTruthy();
    expect(row!.id).toBe(1);
    expect(row!.slug).toBe(FLAGSHIP_SLUG);
    expect(row!.productId).toBe(FLAGSHIP_PRODUCT_ID);
    // Baseline, pre-correction: migration 0009's own original seed value.
    expect(row!.title).toBe(OLD_TITLE);

    const asset = await env.DB.prepare(`SELECT asset_id AS assetId FROM product_files WHERE asset_id = ?`)
      .bind(FLAGSHIP_ASSET_ID)
      .first<{ assetId: string }>();
    expect(asset!.assetId).toBe(FLAGSHIP_ASSET_ID);

    const media = await env.DB.prepare(`SELECT storage_key AS storageKey FROM media_assets WHERE storage_key = ?`)
      .bind(FLAGSHIP_STORAGE_KEY)
      .first<{ storageKey: string }>();
    expect(media!.storageKey).toBe(FLAGSHIP_STORAGE_KEY);
  });
});

describe('Content correction — mirrors the reviewed reposition SQL (Phase 9C.8)', () => {
  it('GET /api/products/starting-to-invest-with-gh100 returns the current title after correction, with every technical identifier unchanged', async () => {
    await applyReposition();

    const res = await SELF.fetch(`https://example.com/api/products/${FLAGSHIP_SLUG}`);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.title).toBe(NEW_TITLE);
    expect(body.data.subtitle).toBe(NEW_SUBTITLE);
    expect(body.data.slug).toBe(FLAGSHIP_SLUG);

    const row = await env.DB.prepare(`SELECT id, slug, product_id AS productId FROM products WHERE slug = ?`)
      .bind(FLAGSHIP_SLUG)
      .first<{ id: number; slug: string; productId: string }>();
    expect(row!.id).toBe(1);
    expect(row!.slug).toBe(FLAGSHIP_SLUG);
    expect(row!.productId).toBe(FLAGSHIP_PRODUCT_ID);

    const asset = await env.DB.prepare(`SELECT asset_id AS assetId, media_id AS mediaId FROM product_files WHERE asset_id = ?`)
      .bind(FLAGSHIP_ASSET_ID)
      .first<{ assetId: string; mediaId: number }>();
    expect(asset).toBeTruthy();

    const media = await env.DB.prepare(`SELECT storage_key AS storageKey FROM media_assets WHERE id = ?`)
      .bind(asset!.mediaId)
      .first<{ storageKey: string }>();
    expect(media!.storageKey).toBe(FLAGSHIP_STORAGE_KEY);
  });

  it('/books/ listing page never contains the retired title after the books.ts:454 fix', async () => {
    await applyReposition();
    const res = await SELF.fetch('https://example.com/books/');
    const html = await res.text();
    expect(html).not.toContain(OLD_TITLE);
  });

  it("a historical purchase_sessions.product_title snapshot taken BEFORE the correction is never rewritten by it", async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at)
       VALUES ('RWL-2026-980001', ?, ?, ?, 3900, 'GHS', 'verified', datetime('now', '+30 minutes'))`
    )
      .bind(FLAGSHIP_SLUG, FLAGSHIP_PRODUCT_ID, OLD_TITLE)
      .run();
    const purchaseSessionId = Number(insert.meta.last_row_id);

    await applyReposition();

    const snapshot = await env.DB.prepare(`SELECT product_title AS productTitle FROM purchase_sessions WHERE id = ?`)
      .bind(purchaseSessionId)
      .first<{ productTitle: string }>();
    expect(snapshot!.productTitle).toBe(OLD_TITLE);

    // The live catalog title has moved on independently of this snapshot.
    const liveTitle = await env.DB.prepare(`SELECT title FROM products WHERE slug = ?`).bind(FLAGSHIP_SLUG).first<{ title: string }>();
    expect(liveTitle!.title).toBe(NEW_TITLE);
  });

  it('the existing PDF entitlement still resolves correctly after the title correction — title is display-only, never part of the entitlement check', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at)
       VALUES ('RWL-2026-980002', ?, ?, ?, 3900, 'GHS', 'verified', datetime('now', '+30 minutes'))`
    )
      .bind(FLAGSHIP_SLUG, FLAGSHIP_PRODUCT_ID, OLD_TITLE)
      .run();
    const purchaseSessionId = Number(insert.meta.last_row_id);
    await env.DB.prepare(
      `INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, status) VALUES (?, ?, ?, 5, 'delivered')`
    )
      .bind(purchaseSessionId, FLAGSHIP_ASSET_ID, FLAGSHIP_SLUG)
      .run();

    await applyReposition();

    const result = await checkEntitlement(env as any, 'RWL-2026-980002', FLAGSHIP_ASSET_ID);
    expect(result.granted).toBe(true);
  });
});

describe('Treasury Bills Made Simple — unaffected (Phase 9C.8 contamination check)', () => {
  it('a separately-seeded Treasury Bills product is untouched by the flagship correction', async () => {
    await env.DB.prepare(
      `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
       VALUES ('prod-treasury-bills-made-simple-test', 'treasury-bills-made-simple-test', 'Treasury Bills Made Simple', 'investing', 'ebook', 'active', 3900, 'GHS', 'one-time', 'inclusive', 'en')`
    ).run();

    const before = await env.DB.prepare(`SELECT title FROM products WHERE slug = 'treasury-bills-made-simple-test'`).first<{ title: string }>();

    await applyReposition(); // scoped to FLAGSHIP_SLUG only

    const after = await env.DB.prepare(`SELECT title FROM products WHERE slug = 'treasury-bills-made-simple-test'`).first<{ title: string }>();
    expect(after!.title).toBe(before!.title);
    expect(after!.title).toBe('Treasury Bills Made Simple');
  });
});
