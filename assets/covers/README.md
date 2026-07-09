# Product Cover Images

## Purpose

Home for the `coverImage`, `thumbnail`, and `previewImage` referenced
by each future `content/products/{slug}.json` record (see
`content/products/README.md`). All three are display images tied to a
product — `coverImage` for a detail-page hero, `thumbnail` a
smaller/cropped variant for dense grid cards, `previewImage` a "here's
a sample" image shown pre-purchase (Sprint 2.1 additions, distinct
from Sprint 1's single `coverImage`). **No images exist yet** — no
product exists yet either.

## Expected shape, once real covers exist

- One image per product, named after its slug:
  `assets/covers/{product-slug}.jpg` (or `.png` for artwork needing
  transparency).
- Recommended dimensions: 800×1000px (4:5 portrait), matching the
  `aspect-4-5` utility class already used for the founder portrait and
  book cover imagery elsewhere on the site — no new aspect-ratio
  convention needed.
- Optimized/compressed before committing, matching every other real
  image already in this project (the founder portrait and logo were
  both processed this way in Version 1.1).

## Today

The one real product-shaped item on the site — the "Starting to Invest
with GH₵100" eBook — currently uses a CSS-only placeholder block
(`.book-card__cover`, a solid Sika Gold rectangle) instead of a real
cover image, documented in `index.html`'s own "Cover placeholder"
comment. That placeholder is untouched by this sprint. When a real
cover image is ready, it goes here, and `content/products/starting-to-invest-with-gh100.json`
would reference it as `coverImage` — no code change required beyond
that one field, since `js/components/product-loader.js` (Phase 5) is
already written to read this field once wired to a live page.
