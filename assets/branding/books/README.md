# Book Covers

No book cover artwork exists yet — every book on the site currently
shows a solid Sika Gold color block (`.book-card__cover`) instead of a
photo/illustration, and that's an intentional, documented placeholder
(see `css/components.css`'s `.book-card__cover` rule and the "Cover
placeholder" HTML comments in `index.html`/`books/index.html`), not a
bug.

## Expected filenames

One file per book, named after that book's URL slug — the same slug
already used in its page route. For the one book that exists today:

- `starting-to-invest-with-gh100.jpg` — matches
  `/books/starting-to-invest-with-gh100/`

Future books follow the same pattern: whatever the route segment is
under `/books/{slug}/`, the cover file is `{slug}.jpg` (or `.webp`)
here.

## Recommended dimensions

3:4 aspect ratio (matches `.book-card__cover`'s
`aspect-ratio: 3 / 4` in `css/components.css`) — e.g. 900×1200px gives
good headroom without being excessive for a card-sized thumbnail.

## Recommended formats

JPG or WebP for a photographed/rendered cover mockup. If the cover is
closer to a flat illustration/typographic design, PNG can preserve
crisper edges.

## Recommended optimization

Under 150KB per cover — these render at card-thumbnail size
(`.book-card__cover`/`.book-card__cover--compact`), not full-page, so
there's no benefit to shipping a high-resolution source file as-is.

## Fallback behavior

`.book-card__cover` and `.book-card__cover--compact` render as a solid
Sika Gold `<div>` today — no `<img>` tag exists yet for any book cover.
Introducing a real cover means changing that `<div>` to an `<img>` on
the specific book's card instances (homepage featured-book section,
`books/index.html`'s listing, and that book's own detail page) — a
per-book, per-instance change, not a sitewide one, since each book's
cover is naturally different. See `content/books/README.md` for how a
future structured `content/books/{slug}.json` file's `coverImage` field
would point at the exact path here once a page actually fetches it
(see `content/SCHEMA.md`, and `js/components/founder-bio.js` for the
established self-contained-fetch pattern any future consumer should
follow) — not the case yet.
