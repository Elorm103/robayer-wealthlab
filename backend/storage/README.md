# storage/

## Purpose

Documents the Cloudflare R2 bucket/folder layout this backend will use
for product files, receipts, and temporary artifacts — **no R2 bucket
has been created yet.** Full rationale, including the signed-URL and
expiration strategy, is in `docs/storage-strategy.md`; this file is
the quick-reference structure.

## Planned layout (future)

```
ebooks/       — source PDF files for ebook products
templates/    — source .xlsx/.docx template files
resources/    — free (price: 0) resource files, served directly (no signing needed)
covers/       — product cover images (mirrors assets/covers/ during authoring — see below)
receipts/     — generated order receipts/invoices (PDF), one per order
temporary/    — short-lived exports or generated files, auto-expired
exports/      — admin-generated reports (e.g., a CSV of orders for a date range)
```

See `docs/storage-strategy.md` for which of these are public,
which require a signed URL, and why.

## Relationship to `assets/` in the static site

`assets/covers/`, `assets/products/`, and `assets/downloads/` (created
in Version 1.2 Sprint 1) remain the **authoring/staging** location — a
human or future editor drops a new product's cover and file there
first, as plain files in this git repository. R2 becomes the **live
serving** location once a product actually goes on sale, per
`docs/storage-strategy.md`'s promotion flow. The two are not the same
system, and files don't need to exist in both at once — only once a
product is ready to sell does its file need to exist in R2 too.

## Today

No R2 bucket exists. This structure is planned, not deployed.
