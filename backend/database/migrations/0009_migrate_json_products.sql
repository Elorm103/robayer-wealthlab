-- Robayer WealthLab — D1 Migration 0009 (Version 2.0 Phase 2: Products
-- Module — data migration)
--
-- One-time import of the 2 real products that existed as
-- content/products/{slug}.json into the new D1 products/product_files
-- tables created by migration 0008. Every value below was copied
-- directly from the live JSON files (content/products/
-- starting-to-invest-with-gh100.json and momo-savings-playbook.json),
-- re-read fresh at migration-authoring time — not reconstructed from
-- memory or from content/SCHEMA.md's aspirational shape.
--
-- Two identifiers are preserved character-for-character on purpose,
-- because real rows elsewhere already reference them by string, not by
-- this migration's new surrogate `id`:
--   - products.product_id = 'prod-starting-to-invest-with-gh100' — real
--     purchase_sessions.product_id values already equal this string
--     (locked in at checkout time, see commerceService.ts).
--   - product_files.asset_id = 'asset-starting-to-invest-with-gh100-pdf-v1'
--     — real deliveries.asset_id / download_tokens rows already equal
--     this string (granted at fulfilment time, see fulfilmentService.ts).
-- Getting either wrong would silently orphan a real customer's already-
-- paid-for purchase or already-issued download entitlement.
--
-- The ebook's downloadable file is NOT re-uploaded — it already exists
-- in R2 at the pre-Media-Library key `ebooks/starting-to-invest-with-gh100.pdf`
-- (the legacy digital-fulfilment path's own key convention, see
-- utils/mediaKey.ts's header comment on why Media Library deliberately
-- uses a separate `media/` prefix). This migration creates one
-- media_assets row that POINTS AT that existing object (same
-- storage_key, same bytes, zero R2 writes) so product_files.media_id
-- can reference it per the Phase 2 brief's "select from Media Library,
-- never duplicate uploads" — a reference is created, not a copy.
-- size_bytes (465425) and content_hash (sha256) were computed by
-- downloading the real production object and hashing it directly, not
-- estimated.
--
-- momo-savings-playbook has no downloadFiles in its JSON (status:
-- "coming-soon", nothing published yet) — no product_files row for it.
-- Both products' coverImage/thumbnail/previewImage were already `null`
-- in the source JSON, so cover_media_id etc. are left NULL here too —
-- this migration preserves the source data exactly, it does not invent
-- cover art that was never there.
--
-- Idempotency: relies on products.slug/product_id and
-- product_files.asset_id all being UNIQUE — a second run would fail on
-- constraint violation rather than silently duplicating rows. The
-- normal `wrangler d1 migrations apply` mechanism (already used for
-- 0001-0008) additionally ensures this file only ever executes once
-- per database via d1_migrations bookkeeping.

-- ============================================================
-- Product 1: Starting to Invest with GH₵100 (active, paid)
-- ============================================================

INSERT INTO media_assets (
  filename, original_filename, mime_type, size_bytes, content_hash,
  storage_key, public_url, media_type, folder, status
) VALUES (
  'starting-to-invest-with-gh100.pdf', 'starting-to-invest-with-gh100.pdf', 'application/pdf',
  465425, '4e9d52410a0a40e1289e51677379edf3e6b87382ac469d5b9b74ca7f1509f3c0',
  'ebooks/starting-to-invest-with-gh100.pdf', '/api/media/file/ebooks/starting-to-invest-with-gh100.pdf',
  'document', 'books', 'ready'
);

INSERT INTO products (
  product_id, slug, title, subtitle, short_description, description,
  topic, product_type, status, price_pesewas, currency, sku, version,
  language, estimated_reading_time, author, featured, bestseller, new_release,
  tags, max_downloads, download_expires_days, seo_title, seo_description, seo_canonical_url
) VALUES (
  'prod-starting-to-invest-with-gh100', 'starting-to-invest-with-gh100',
  'Starting to Invest with GH₵100',
  'A practical first guide to treasury bills, mobile money savings, and the Ghana Stock Exchange.',
  'A practical first guide to treasury bills, mobile money savings, and the Ghana Stock Exchange.',
  'A practical first guide to treasury bills, mobile money savings, and the Ghana Stock Exchange — built for wherever you''re starting from. Covers why GH₵100 is enough to start, how treasury bills work, turning MoMo savings into a real habit, your first steps on the Ghana Stock Exchange, building a simple monthly routine, and avoiding the most common first-year mistakes.',
  'investing', 'ebook', 'active', 3900, 'GHS', 'RWL-EBOOK-001', '1.0',
  'en', 35, 'Robert Loh Kobla', 1, 0, 0,
  'ebook,investing,beginners', 5, 30,
  'Starting to Invest with GH₵100 | Robayer WealthLab',
  'A practical first guide to treasury bills, mobile money savings, and the Ghana Stock Exchange — start investing in Ghana with just GH₵100. GH₵39.',
  'https://robayerwealthlab.com/books/starting-to-invest-with-gh100/'
);

INSERT INTO product_files (
  product_id, asset_id, media_id, display_name, file_type, version, status, sort_order
) VALUES (
  (SELECT id FROM products WHERE slug = 'starting-to-invest-with-gh100'),
  'asset-starting-to-invest-with-gh100-pdf-v1',
  (SELECT id FROM media_assets WHERE storage_key = 'ebooks/starting-to-invest-with-gh100.pdf'),
  'eBook (PDF)', 'PDF', '1.0', 'published', 0
);

-- ============================================================
-- Product 2: The MoMo Savings Playbook (coming-soon, no price, no file yet)
-- ============================================================

INSERT INTO products (
  product_id, slug, title, subtitle, short_description, description,
  topic, product_type, status, price_pesewas, currency, sku, version,
  language, estimated_reading_time, author, featured, bestseller, new_release,
  tags, max_downloads, download_expires_days, seo_title, seo_description, seo_canonical_url
) VALUES (
  'prod-momo-savings-playbook', 'momo-savings-playbook',
  'The MoMo Savings Playbook',
  'Turn mobile money into a real savings habit.',
  'Turn mobile money into a real savings habit.',
  'Turn mobile money into a real savings habit. Full description to follow once the guide is written — teased ahead of release, matching the existing ''Coming soon'' placement on /books/.',
  'personal-finance', 'guide', 'coming-soon', NULL, 'GHS', 'RWL-GUIDE-001', NULL,
  'en', NULL, 'Robert Loh Kobla', 0, 0, 0,
  'guide,saving,momo', 5, 30,
  'The MoMo Savings Playbook | Robayer WealthLab',
  'Turn mobile money into a real savings habit — coming soon from Robayer WealthLab.',
  'https://robayerwealthlab.com/books/momo-savings-playbook/'
);
