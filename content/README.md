# Content Architecture

This directory is mostly still a **scaffold for a future
structured-content system** — documentation of where content will live
and how it will be shaped, with no sample data. One exception as of
Phase 17: `content/founder/bio.json` holds the founder's real biography
and is actively read by `index.html`/`about/index.html` via
`js/components/founder-bio.js`. Every other content type below remains
scaffolding only — every other page still ships its real content
directly in its own HTML, exactly as it always has.

See `content/SCHEMA.md` for the recommended JSON shape of each content
type. `js/components/founder-bio.js` is the reference implementation
for how to consume one of these files: a small, self-contained
`fetch()` with the existing hand-written HTML as the fallback if it
fails — no shared loader module currently exists (an earlier
`js/content-loader.js` attempt at one was removed in the Sprint 18
audit once it turned out to have zero consumers; a future phase wiring
up a second content type should follow `founder-bio.js`'s pattern, and
only extract a shared helper once there are enough real consumers to
justify one).

## Why this exists

Right now, adding a new blog article, book, or FAQ entry means writing
a new HTML page or editing an existing one by hand — which is exactly
right for a site this size, and this directory doesn't change that
today. What it prepares for is the point where content changes often
enough, or is edited by someone who isn't comfortable in raw HTML, that
a lightweight local editor or Git-backed CMS becomes worth building.
That future tool would read and write the JSON files described in each
subdirectory below, instead of parsing/rewriting page markup.

## Subdirectories

| Directory | Holds structured data for |
|---|---|
| [`company/`](company/README.md) | Mission, vision, values, timeline, future team roster |
| [`founder/`](founder/README.md) | Founder bio variants and quotes |
| [`books/`](books/README.md) | Book metadata (one file per book) |
| [`blog/`](blog/README.md) | Blog article metadata (one file per article) |
| [`resources/`](resources/README.md) | Free resource/template/calculator listings |
| [`legal/`](legal/README.md) | Privacy Policy / Terms of Use / Disclaimer section content |
| [`newsletter/`](newsletter/README.md) | Past newsletter issue archive |
| [`community/`](community/README.md) | Community page principles/roadmap content |
| [`events/`](events/README.md) | Scheduled community events (webinars, meetups) |
| [`testimonials/`](testimonials/README.md) | Reader/subscriber testimonials |
| [`faq/`](faq/README.md) | Per-page FAQ question/answer sets |

## How future content gets added (once this is wired up)

Each subdirectory's README describes its own file-naming convention,
but the general shape is the same everywhere: a plain JSON file (or one
per item, for content types with few, substantial entries like books)
matching the schema in `content/SCHEMA.md`, added by hand or by a
future editing tool, then read by a page with its own small `fetch()`
call (see `js/components/founder-bio.js` for the established pattern).
Nothing here requires a build step — every file is a static asset
fetched the same way `assets/config/site.json` already is, so GitHub
Pages compatibility is unaffected.

## What remains scaffolding only

- Every content type except `founder/` has no consumer and no real data
  file — only a README describing the future shape.
- No fake/sample content files exist anywhere else in this directory.
- `founder/bio.json` is real, live content (see its README) — everything
  else here is still documentation, not a feature.
