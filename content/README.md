# Content Architecture

This directory is mostly still a **scaffold for a future
structured-content system** — documentation of where content will live
and how it will be shaped, with no sample data. Three exceptions exist
today, in different states:

- `content/founder/bio.json` (Phase 17) holds the founder's real
  biography and is **actively read** by `index.html`/`about/index.html`
  via `js/components/founder-bio.js`.
- `content/services/` (Version 1.1 Sprint 1) holds one real, complete
  JSON record per service — but **nothing fetches it yet**. The six
  `/services/{slug}/` pages render their real content directly in
  their own HTML, exactly like every other real page on the site; the
  JSON exists ahead of its first consumer for a still-real future need
  (Success Stories cross-links, per the Version 1.1 PRD). Both the
  Consultation Module (`/consultation/`, Sprint 3) and the Financial
  Goal Planner (`/goal-planner/`, Sprint 4) were originally expected to
  be consumers of this file and turned out not to need it — each
  hardcodes its own small, fixed lookup (a category dropdown and a
  slug-to-title/href table, respectively) directly in its own script
  instead. See `content/services/README.md` for the full reasoning.
- `content/calculators/` (Version 1.1 Sprint 2) holds the same kind of
  real-but-unconsumed metadata record, one per calculator — title,
  summary, educational copy, FAQ, cross-links. **No formula lives
  here**: a calculator's formula is executable logic, not content, so
  it lives in `js/components/calculator-utils.js` and each
  calculator's own script instead. See
  `content/calculators/README.md`.
- `content/goal-planner/` (Version 1.1 Sprint 4) holds one real,
  **actively fetched** config file per goal — the second live
  `fetch()` consumer on the site after `content/founder/bio.json`.
  Its `relatedServices`/`relatedCalculators` fields are slug arrays
  resolved by a small hardcoded lookup table in `goal-planner.js`
  (mirroring `consultation-form.js`'s category `<select>`), not a
  second fetch of `content/services/`/`content/calculators/` — those
  folders' anticipated future consumer is still open. See
  `content/goal-planner/README.md`.
- `content/investment-centre/` (Version 1.1 Sprint 6) holds one real,
  complete JSON record per Ghana Investment Centre topic — the same
  "real content, no consumer yet" arrangement as `content/services/`
  and `content/calculators/`. Its `relatedGoals` field is the first
  cross-reference to point *into* the Goal Planner from a
  reading-content page. See `content/investment-centre/README.md`.
- `content/products/`, `content/product-types/`, and `content/topics/`
  (Version 1.2 Sprint 1, extended Sprint 2.1) hold the commerce
  content schema — **zero product data exists**, real or fake.
  `content/products/index.json` is a genuinely empty `[]`;
  `content/product-types/index.json` (renamed from Sprint 1's
  `content/categories/`) holds 7 format definitions (ebook, guide,
  template, spreadsheet, report, checklist, course); `content/topics/index.json`
  (new in Sprint 2.1, split out of what was one `category` field) holds
  5 subject-matter definitions (investing, personal-finance, budgeting,
  business, mindset) — all ahead of any product referencing them.
  `js/components/product-loader.js` exists and is ready but isn't
  wired into any page — no storefront page exists yet. See
  `content/products/README.md`, `content/product-types/README.md`,
  `content/topics/README.md`, `docs/commerce-architecture.md`, and
  `docs/product-platform-architecture.md` for the full commerce
  architecture plan.

Every other content type below remains scaffolding only — every other
page still ships its real content directly in its own HTML, exactly as
it always has.

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
| [`services/`](services/README.md) | Service overview/audience/process/FAQ records (real, complete — see its README for why nothing fetches it yet) |
| [`calculators/`](calculators/README.md) | Calculator metadata/educational copy (real, complete — no formulas; see its README) |
| [`goal-planner/`](goal-planner/README.md) | Per-goal question/recommendation config (real, actively fetched — see its README) |
| [`investment-centre/`](investment-centre/README.md) | Ghana Investment Centre topic records (real, complete — no consumer yet; see its README) |
| [`products/`](products/README.md) | Digital Product commerce schema — zero product data exists yet |
| [`categories/`](categories/README.md) | Product category taxonomy (4 real categories defined) |
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

- Every content type except `founder/`, `services/`, `calculators/`,
  `goal-planner/`, `investment-centre/`, `products/`, and
  `categories/` has no consumer and no real data file — only a README
  describing the future shape.
- No fake/sample content files exist anywhere else in this directory.
  `products/index.json` is a real, empty `[]` — not a fake entry
  standing in for a product that doesn't exist.
- `founder/bio.json` and `goal-planner/*.json` are real, live content,
  actively fetched today. `services/*.json`, `calculators/*.json`,
  `investment-centre/*.json`, and `categories/index.json` are real,
  complete content with no consumer yet — a deliberately different
  state from both "live" and "documentation only," explained in each
  folder's own README. `products/index.json` is real but intentionally
  empty (zero products exist). Everything else here remains
  documentation, not a feature.
