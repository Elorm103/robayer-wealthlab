# storage/

## Purpose

Documents the Cloudflare R2 bucket/folder layout this backend uses for
product files, receipts, temporary artifacts, and CMS media. Full
rationale for the original (still-planned) layout, including the
signed-URL and expiration strategy, is in `docs/storage-strategy.md`;
this file is the quick-reference structure.

## Today (real, deployed)

The R2 bucket (`robayer-wealthlab-storage`, binding `STORAGE`) exists
and is in active use by two independent systems sharing one bucket:

```
ebooks/       — paid-purchase digital assets (Version 1.2 Sprint 2.5's
                Digital Fulfilment system). Read-only from this
                backend's perspective (routes/downloads.ts's
                env.STORAGE.get()); files land here through an out-of-
                band process, not an admin upload pipeline. Access is
                gated by deliveries/download_tokens — see
                docs/digital-fulfilment.md.

media/        — Media Library (Version 2.0 Phase 1), the first real
                upload pipeline this backend has. Structure:
                  media/images/{books,blog,resources,branding,uncategorized}/<uuid>.{jpg,png,webp,svg}
                  media/images/{folder}/thumb-<uuid>.webp   — client-generated downscaled copies
                  media/documents/{books,resources,uncategorized}/<uuid>.pdf
                Every key is server-generated (crypto.randomUUID()) —
                no user input ever reaches the key string, so path
                traversal and filename collisions are structurally
                impossible. See services/mediaService.ts and
                utils/mediaKey.ts. Every object has a matching D1 row
                in media_assets (migrations/0007_media_library.sql);
                soft-deleted rows are not removed from R2 (see
                docs/v2-media-library-spec.md's "Deletion").
```

`media/` is deliberately namespaced apart from `ebooks/` — these are
two different domains (public, unauthenticated CMS assets meant to be
embedded/linked on the site, vs. paid content gated behind purchase
verification) that happen to share one bucket, not one system. Media
Library's public file route (`GET /api/media/file/:key`, see
`routes/media.ts`) only ever serves a key it can find as a live row in
`media_assets` — it cannot be used to bypass the `ebooks/` entitlement
gate, since legacy paid-content keys were never inserted into that
table.

## Still-planned (not yet built)

The rest of the original layout below remains aspirational — no
`templates/`, `covers/`, `receipts/`, `temporary/`, or `exports/`
prefix exists in R2 yet. Some of what this originally described
(product cover images, free-resource files) is now more likely to be
served through Media Library instead of a bespoke prefix, once the
Products module (a later Version 2.0 phase) is built — see
`docs/v2-media-library-spec.md` and `docs/v2-product-management-spec.md`.

```
templates/    — source .xlsx/.docx template files
receipts/     — generated order receipts/invoices (PDF), one per order
temporary/    — short-lived exports or generated files, auto-expired
exports/      — admin-generated reports (e.g., a CSV of orders for a date range)
```

See `docs/storage-strategy.md` for which of these are public, which
require a signed URL, and why — that reasoning still applies to
whichever of these prefixes eventually get built.

## Relationship to `assets/` in the static site

`assets/covers/`, `assets/products/`, and `assets/downloads/` (created
in Version 1.2 Sprint 1) remain the **authoring/staging** location for
the existing static-site product catalog (`content/products/*.json`) —
a human drops a new product's cover and file there first, as plain
files in this git repository. That flow is unchanged by Media Library,
which is a separate, newer, database-backed asset system for
CMS/editorial content (blog images, resource guides, branding assets).
The two are not the same system and are not yet unified — see
`docs/v2-media-library-spec.md`'s reasoning on that distinction.
