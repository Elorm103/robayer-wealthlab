# Product Files

## Purpose

Home for the files referenced by each future
`content/products/{slug}.json` record's `downloadFiles` array (see
`content/products/README.md`). **No product files exist yet** — no
product exists yet either.

This folder is distinct from `assets/downloads/` (see that folder's
own README) — the split matters once real payment gating exists, so
it's established now rather than retrofitted later.

## Expected shape, once real product files exist

- One source file per product, named after its slug and matching its
  real format: `assets/products/{product-slug}.pdf` (ebooks,
  checklists, templates authored as PDF), `.xlsx`/`.docx` (spreadsheet
  or Word templates), or a folder per product for multi-file courses.
- This folder holds the **master/source copy** — the file a future
  admin module would manage, replace, or version. It is never linked
  to directly from any page or served to a visitor.

## Why this isn't `downloadFiles`' live location

`content/products/{slug}.json`'s `downloadFiles` array (see
`content/SCHEMA.md`'s `Product` entry — a Sprint 2.1 change from a
single `downloadFile` path, so one product can ship more than one
file) points to *paths*, but per `docs/download-security.md`, no real
purchase flow should ever serve a static path directly to a browser —
a paid buyer's actual download happens through a time-limited, signed
URL generated at delivery time, not a permanent link into this folder.
This folder is the **origin** that a future signed-URL system reads
from, not the public-facing download itself. See
`docs/download-security.md` for the full reasoning.

## Today

Nothing here. The one real product-shaped item on the site — the
"Starting to Invest with GH₵100" eBook — isn't sold through this
system yet (see `docs/commerce-architecture.md`'s Phase 1 audit); its
current "Buy the guide" CTA uses the existing honest
`data-placeholder-action` pattern, unchanged by this sprint.
