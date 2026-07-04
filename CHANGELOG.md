# Changelog

All notable work on the Robayer WealthLab website is recorded here. Dates
are in `YYYY-MM-DD`. This project has no releases yet — entries are
grouped by development phase/sprint instead of version number.

## [Unreleased]

### Sprint 2 — Books page — 2026-07-04

First real content page beyond Home: `books/index.html`, serving the
clean URL `/books/`. Built entirely from the existing architecture —
no new page-level styles, all markup composed from tokens/base/layout/
components/utilities in the established load order.

**Added**
- `books/index.html` — Hero, featured-eBook spotlight, filterable book
  grid, "Coming soon" teaser, FAQ, newsletter CTA, shared footer.
- `js/components/book-filters.js` — category-pill filtering for the
  book grid, self-initializing on `DOMContentLoaded` like the other
  page-level component scripts. Reads `[data-category]` off whatever
  book-cards exist in the grid, so adding the 3rd, 10th, or 50th book
  needs no changes to this file.
- `css/components.css`: `.filter-bar` / `.filter-pill` (category
  filter pills, reusable for Blog/Resources later) and `.faq`/
  `.faq__item`/`.faq__question`/`.faq__icon`/`.faq__answer` (accordion
  built on native `<details>/<summary>` — keyboard-operable and
  exposes expanded state to assistive tech with no ARIA needed).
- `FAQPage` JSON-LD added alongside the existing Organization schema,
  per the README's Phase 1 SEO requirement to add per-page Article/FAQ
  structured data as content pages are built.
- `<lastmod>2026-07-04</lastmod>` added to the `/books/` entry in
  `sitemap.xml` now that the page is real.

**Reused, not duplicated**
- `.hero` / `.hero__content` (Home's centered hero pattern)
- `.feature-banner` (built in Sprint 1.5 for exactly this) for the
  featured-eBook spotlight
- `.book-card` / `.book-card--featured` / `.book-card__cover--green`
  for the grid — same two books already established in
  `components.html`'s style-guide demo (Starting to Invest with
  GH₵100; The MoMo Savings Playbook)
- `.grid.grid--3`, `.content-column`, `.badge`, `.btn`, `.eyebrow`,
  `.newsletter-band` (+ `newsletter-form.js`) — no new one-off markup
  patterns introduced for any of these

**Accessibility**
- Filter pills are real `<button>`s in a `role="group"` labelled by a
  visible "Filter by topic:" text (not just an `aria-label`), each
  toggling `aria-pressed`; keyboard- and screen-reader-operable with
  no custom ARIA widget code.
- The empty-filter-result message uses `aria-live="polite"` so screen
  reader users hear it when a category has no guides yet.
- FAQ accordion uses native `<details>/<summary>` rather than a custom
  JS disclosure, so expand/collapse, keyboard operation, and state
  exposure are all handled by the browser.
- Verified 44px-minimum touch targets on filter pills and FAQ summaries,
  visible focus states via the existing global `:focus-visible` rule,
  and correct heading hierarchy (single H1 in the hero, H2 per section).

**Fixed a bug before it shipped**
- The filter/empty-state show-hide logic deliberately toggles the
  `.hidden` utility class rather than the native `hidden` attribute.
  `.book-card` and `.alert` both set `display` in `components.css`,
  which — same as the pre-existing `.field__error` bug flagged in
  Sprint 1.5 — would silently override a bare `[hidden]` attribute.
  Toggling `.hidden` instead works correctly because `utilities.css`
  loads after `components.css`, so it wins the cascade tie. Verified
  interactively (see verification notes below).

**Verified**
- Local static-server pass across desktop, tablet (768px), and mobile
  (375px): hero, featured banner, grid (3→2→1 collapse), filter pills,
  FAQ accordion, newsletter band, and footer all render correctly with
  no layout breakage.
- Filter interaction tested directly: clicking "Saving"/"Investing"/
  "Entrepreneurship" correctly shows/hides the matching book-cards,
  toggles `aria-pressed`, and the "no guides in this category yet"
  message appears only when a category is genuinely empty
  (Entrepreneurship, today).
- No console errors, no failed network requests (all script/asset
  references resolve, including the placeholder assets added in
  Sprint 1.5).
- Confirmed the Home and footer/nav links to `/books/` — previously
  dead links, flagged in the original project audit — now resolve.

### Sprint 1.5 — Technical cleanup — 2026-07-04

Housekeeping pass ahead of Sprint 2 (Books page). No design or
functional changes — output should look and behave identically to
before this sprint.

**Added**
- Git repository initialized for the project (previously untracked).
- Placeholder production assets so no referenced file 404s:
  `assets/icons/favicon-32.png`, `assets/icons/apple-touch-icon.png`,
  `assets/images/og-default.jpg`, `assets/images/logo/logo.svg`. All
  four reuse the existing coded Sika step-mark approximation and brand
  colors — each is explicitly marked as a placeholder (in its folder's
  README) pending final production artwork.
- New reusable classes to replace page-level inline styles:
  - `css/utilities.css`: `.font-body`, `.font-medium`, `.text-body-lg`,
    `.text-small`, `.text-lg`, `.aspect-4-5`.
  - `css/components.css`: `.eyebrow--gold`, `.pull-quote`,
    `.feature-banner` (+ `__eyebrow`/`__title`/`__copy`),
    `.book-card__cover--compact`, `.book-card__cover--green`,
    `a.resource-card`, `.newsletter-band__input`,
    `.newsletter-band .field__error`.
  - `css/dev-showcase.css` (dev-only): `.showcase-item--wide`,
    `.showcase-item--narrow`, `.showcase-frame`,
    `.showcase-nav-preview`, `.showcase-label--block`,
    `.showcase-code--label`, `.showcase-section--last`.

**Changed**
- Removed every page-level inline `style=""` attribute from
  `index.html`, `components.html`, and `partials/footer.html`, replacing
  each with one of the classes above. Visual output is unchanged.
- `assets/icons/README.md` and `assets/images/logo/README.md` updated to
  note which files are now placeholders vs. still missing.

**Documented**
- `.breadcrumbs` (in `css/components.css`) confirmed unused on any
  current page; annotated in place as intentionally reserved for the
  detail pages (Blog Article, Book Detail, Resource Detail) planned in
  Sprint 2+, rather than removed.
- The color-palette swatches and spacing-scale bars in
  `components.html` intentionally keep inline `style=""` — each value
  shown *is* the unique datum being documented, not a repeated pattern.
  Noted in `css/dev-showcase.css`.

**Verified**
- All asset references across `index.html`, `templates/page-template.html`,
  `robots.txt`, and `sitemap.xml` resolve to real files.
- Production domain (`robayerwealthlab.com`) confirmed consistent across
  canonical URLs, Open Graph tags, JSON-LD, `robots.txt`, and
  `sitemap.xml` — no changes needed.
- Home page and the component showcase visually verified against a
  local static server after every change; no layout or color
  regressions.

**Known issue (pre-existing, not touched this sprint)**
- The newsletter form's `.field__error` span is marked `hidden` in
  markup, but `.field__error { display: flex; }` in `components.css`
  overrides the browser's default `[hidden]` behavior, so the error
  message is visible on page load instead of only after a failed
  validation. This predates this cleanup sprint and is left as-is per
  the "no functionality changes" scope — worth a follow-up fix.

## Phase 5.1 — Foundation

Initial scalable foundation: design tokens, base reset, layout system,
global components (header/nav/footer/buttons/cards/forms/testimonials),
utilities, vanilla-JS partial-include system, accessibility groundwork
(skip link, focus states, reduced motion, touch targets, mobile menu
a11y), and SEO groundwork (meta tags, Open Graph, Twitter Card,
Organization JSON-LD, `robots.txt`, `sitemap.xml`). Delivered the Home
page (`index.html`) and the internal component showcase
(`components.html`, dev-only). No other real pages yet — see README for
the full open-items list before Sprint 5.2.
