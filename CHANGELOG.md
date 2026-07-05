# Changelog

All notable work on the Robayer WealthLab website is recorded here. Dates
are in `YYYY-MM-DD`. Entries are grouped by development phase/sprint;
`v1.0.0-production-baseline` is the first tagged checkpoint (see below),
marking the site as production-ready.

## [Unreleased]

Nothing yet — the next phase starts here.

## [v1.0.0-production-baseline] — 2026-07-05

Closes out Phases 1–18. Everything below this heading (Sprint 1 through
Sprint 18) is the full, unmodified history that makes up this baseline
— nothing was rewritten to produce it. This entry itself only records
the finalization pass done on top of Sprint 18's audit before tagging:

- **Working tree review:** every uncommitted change from Phases 15–18
  reviewed file-by-file against this changelog's own sprint history;
  confirmed all of it intentional (no accidental edits, no leftover
  debug code, no stray temp/test files). The `console.error(error)`
  calls in `js/content-inject.js` and `js/components/founder-bio.js`
  are deliberate fetch-failure logging, not debug leftovers — left in
  place.
- **Sitemap consistency:** `sitemap.xml` `<lastmod>` brought to
  `2026-07-05` uniformly across all 12 real routes, since every page
  received at least a script-tag or JSON-LD change during Phases 15–18
  (previously a mix of 07-01–07-05 depending on when each page was last
  touched).
- **Stale changelog note closed out:** Sprint 1.5's "Known issue" about
  the newsletter form's error message showing on page load was
  re-tested and confirmed already fixed (a `.field__error[hidden]`
  override exists in `components.css`) — annotated in place rather than
  deleted, so the history stays honest about when it was actually
  fixed.
- **Final verification, re-run clean:** zero console errors, zero
  failed network requests, zero broken internal links (12/12 resolve),
  zero missing assets (25/25 referenced images/scripts/stylesheets/JSON
  resolve), zero duplicate IDs, zero missing `alt` attributes — across
  all 13 real pages. Confirmed no `package.json`/build tooling/
  server-side includes exist; `CNAME` and `robots.txt` both point at
  the correct production domain.
- **No functional or visual changes in this entry** — this is a
  checkpoint/tagging pass on top of Sprint 18's audit, not new work.

### Sprint 18 — Production Readiness Audit — 2026-07-05

A full sitewide audit across branding, SEO, accessibility, performance,
responsiveness, contact consistency, forms, links, images, dead code,
and GitHub Pages compatibility — no visual redesign, no new features,
fixes only for genuine issues found. See the full Production Readiness
Report in the project record for the complete findings/fixes/remaining-
recommendations breakdown; summary below.

**Fixed — stale references from prior phases**
- `books/starting-to-invest-with-gh100/index.html`,
  `blog/what-are-treasury-bills-in-ghana/index.html`: `Book`/`Article`
  JSON-LD `image` fields (and the article's publisher `logo` field)
  still pointed at the old placeholder paths retired in Sprint 17's
  sitewide OG-image migration — missed because they're schema
  sub-fields, not the top-level `Organization` block. Updated to the
  real `assets/branding/` asset paths.
- `legal/terms-of-use/`, `legal/privacy-policy/`, `legal/disclaimer/`:
  the "reach us at hello@robayerwealthlab.com" sentence in each was
  still hardcoded instead of wired to `assets/config/site.json` like
  every other contact reference sitewide — added the matching
  `data-content`/`data-content-href` attributes.
- `js/components/contact-form.js`: the post-submit confirmation
  message hardcoded the support email instead of reading the
  already-populated `[data-content-href="contact.emails.general.href"]`
  element, so it would have silently gone stale the next time the
  contact email changed. Now reads it from the DOM at submit time.

**Fixed — fabricated content presented as real**
- `blog/index.html` (7 cards), `books/index.html` +
  `books/starting-to-invest-with-gh100/index.html` (1 card each),
  `blog/what-are-treasury-bills-in-ghana/index.html`'s "Related
  articles" (3 cards): these linked to blog articles/a book that don't
  exist yet, with fabricated publish dates, reading times, and a fake
  price — inconsistent with the site's honesty-first tone. Converted
  all 9 instances to the existing `.resource-card--upcoming` "Coming
  soon" convention, extended with new `.blog-card--upcoming` /
  `.book-card--upcoming` CSS, linking to `/newsletter/` instead of a
  dead page.

**Fixed — SEO**
- `index.html`: homepage meta description trimmed from 175 to 159
  characters (was truncating in search results); `og:description`/
  `twitter:description` were already correctly sized and untouched.
- `sitemap.xml`: `<lastmod>` bumped to 2026-07-05 for every page whose
  content this sprint actually changed (`/books/`,
  `/books/starting-to-invest-with-gh100/`, `/blog/`,
  `/blog/what-are-treasury-bills-in-ghana/`, all three `/legal/*`
  pages) — previously dated 07-01–07-04, no longer accurate.

**Fixed — responsive/CSS bugs**
- `css/components.css` `.check-item__text`: `overflow-wrap: break-word`
  doesn't reduce an element's min-content size (per spec, it's a
  last-resort break excluded from intrinsic sizing) — with no spaces
  in an email address, this forced the flex row's, then the card's,
  then the single-column mobile grid's min-content width to ~354px,
  overflowing the 320px viewport by 50px on `/contact/`. Changed to
  `overflow-wrap: anywhere`, which does participate in min-content
  sizing. Verified via automated overflow scan: zero horizontal
  overflow across all 13 real pages at 320/375/768/1024/1440px.
- `.nav__cta`: added `white-space: normal` on mobile so the button
  text wraps instead of forcing nav width.
- `.footer__grid`: added a 768–1199px tablet breakpoint (3 columns)
  instead of jumping straight from 1-column mobile to unconditional
  5-column, which cramped text at iPad-portrait width.

**Removed — dead code**
- `js/content-loader.js` (zero consumers — an earlier abandoned
  attempt at a shared content-fetch utility; `js/components/
  founder-bio.js`'s self-contained-fetch pattern is the reference
  implementation going forward).
- `assets/images/og-default.jpg`, `assets/images/logo/logo.svg` —
  orphaned once the JSON-LD fixes above removed their last references.
  `assets/images/logo/README.md` rewritten to document the retirement.
- Documentation (`content/README.md`, `content/founder/README.md`,
  `content/company/README.md`, `assets/branding/books/README.md`, main
  `README.md`) updated to stop referencing the deleted loader and point
  at `founder-bio.js`'s pattern instead.

**Verified clean (no changes needed)**
- Accessibility: zero duplicate IDs within any page, zero `<img>` tags
  missing an `alt` attribute, across all 13 real pages.
- Internal links: all 12 unique internal paths resolve with no 404s.
- Forms: contact form and newsletter signup both submit and render
  their confirmation state correctly.
- Console/network: zero console errors, zero failed network requests
  across every page tested.
- GitHub Pages compatibility: no `package.json`, no build tooling, no
  server-side includes — confirmed still a pure static site with a
  `CNAME` file for the custom domain.
- Two audit-agent findings were investigated and found to be false
  positives (title-tag lengths reported as 64–67 characters were
  actually 50–53 when measured directly) — not changed.

### Sprint 17 — Real Branding Integration (Logo, Founder Portrait) — 2026-07-05

Introduces the site's first real brand assets — a real logo and a real
founder portrait, both supplied this phase — using the centralized
branding architecture built in Sprint 16. No design-system, IA, or
accessibility change; every existing token/component/route is
untouched. This is **not** a "pixel-identical" phase like 15–16 — the
whole point is that the founder image slots and the header/footer
logo mark now show real photography/artwork instead of coded
placeholders. "Zero regression" here means nothing broke, not that
nothing changed.

**Added — real assets**
- `assets/branding/founder/founder-portrait.jpg` — Robert Loh Kobla's
  supplied headshot, center-cropped from its original 4:3 to the site's
  established 4:5 portrait ratio, visually verified before use (648×810,
  46KB).
- `assets/branding/logo/logo-mark.png`, `logo.png`, `logo-with-tagline.png`
  — cropped from the supplied production logo artwork (a transparent
  PNG, confirmed via pixel-alpha inspection, not a design mockup with a
  baked-in background as it first appeared to be): icon-only mark for
  nav use, full mark+wordmark lockup for JSON-LD/larger contexts, and
  the full lockup with tagline used to compose the OG image below. No
  vector source was supplied, so no `.svg` exists yet — documented as a
  known gap in `assets/branding/logo/README.md`, not silently assumed.
- `assets/branding/social/og-image.jpg` — composed by centering the
  real logo (with tagline) on the site's own Warm Paper background at
  the standard 1200×630 OG size, rather than reusing a generic
  placeholder.
- `content/founder/bio.json` — the founder's real, already-approved
  biography (short + long form), moved here verbatim from
  `about/index.html`/`index.html`'s existing hand-written copy — not
  rewritten or fabricated.

**Changed — integration**
- `partials/header.html`/`partials/footer.html`: `.nav__logo-mark`'s
  coded inline `<svg>` (three gold bars) replaced with an `<img>`
  pointing at the real `logo-mark.png` — `alt=""` (decorative; the
  adjacent `<span>` company-name text already conveys the meaning,
  matching WCAG guidance against redundant image descriptions),
  explicit `width`/`height` matching the file's real dimensions,
  `loading="eager"` in the header (always above the fold) vs.
  `loading="lazy"` in the footer (always below the fold).
- `index.html` (hero + "Meet the Founder") and `about/index.html`
  (hero): the three `<!-- Founder Image Placeholder -->` `<div>`s
  replaced with `<img>`s pointing at the real portrait — descriptive
  `alt="Robert Loh Kobla, Founder & CEO of Robayer WealthLab"`,
  explicit `width`/`height`, `loading="eager"` on the two above-the-fold
  hero placements and `loading="lazy"` on the below-the-fold "Meet the
  Founder" placement.
- `js/components/founder-bio.js` (new) — fetches
  `content/founder/bio.json` and renders `shortBio`/`longBio` into
  `[data-founder-bio="short"/"long"]` elements on `index.html`/
  `about/index.html`, with the existing hand-written text as the
  fallback if the fetch fails. Founder *name*/*title* stay owned by
  `assets/config/site.json` via `js/content-inject.js` — deliberately
  not duplicated into this file, so each fact has exactly one source.
- `assets/config/site.json`'s `branding.logo`/`branding.ogImage`/
  `seo.defaultOgImage` updated to the real asset paths; every page's
  `Organization` JSON-LD `logo` field and `og:image` meta tag updated
  to match (same identical diff applied across all ~15 pages, per the
  established pattern from Sprint 15).
- `css/utilities.css`: new `.img-cover` utility
  (`display:block; width:100%; height:100%; object-fit:cover`) so the
  new `<img>`s fill their existing `.aspect-4-5` box the same way the
  placeholder `<div>`s did, without distortion.
- `css/components.css`: `.nav__logo-mark` changed from a forced
  `24×24px` square to `width:24px; height:auto`, since the real mark's
  proportions aren't square (the old coded mark was designed to be).

**Documentation kept honest**
- `assets/branding/logo/README.md`, `founder/README.md`,
  `social/README.md` rewritten from "here's what to do when a real
  file arrives" to "here's what's actually live now, and what's still
  missing" (the SVG gap) — not left describing a step that already
  happened.
- `content/founder/README.md` and the top-level `content/README.md`
  updated to reflect that this one content type now has a real
  consumer, while every other content type remains scaffolding-only.

**Verified**
- Local static server, fresh session: zero console errors, zero failed
  network requests, on `/`, `/about/`.
- Confirmed via computed `naturalWidth`/`naturalHeight`/`complete` on
  every `<img>` that all four images (2× logo mark, 2× founder
  portrait instances checked) load successfully with no broken images.
- Confirmed `loading="lazy"` images (footer logo, homepage "Meet the
  Founder" portrait) report `complete: false` before being scrolled
  into view, confirming lazy-loading is actually deferring the request,
  not just present as a no-op attribute.
- Zero duplicate `id` attributes on `/` (14 ids) and `/about/`.
- Screenshot comparison confirms clean rendering of the real photo/logo
  at both hero and "Meet the Founder" placements, both light and (from
  Sprint 14) dark mode.
- Diagnosed and resolved a false alarm during testing: the local dev
  preview session had a stale/poisoned cache entry for one script URL
  from early, broken iterations of this same file — confirmed via a
  fresh-filename test that the final code executes correctly; not an
  issue for real visitors, who fetch the file fresh on first visit.

### Sprint 16 — Brand Asset & Content Architecture Foundation — 2026-07-05

A documentation/scaffolding-only phase — **no page HTML, CSS, or JS
behavior changed; verified pixel-identical, zero console errors, zero
duplicate IDs, zero broken links**. Builds directly on Sprint 15's
configuration layer: where that phase centralized simple facts
(company/founder/contact/social), this phase prepares the structure for
richer future content (books, articles, resources, testimonials, FAQ,
etc.) and formalizes where brand assets will eventually live — without
migrating anything or wiring any of it into a live page yet.

**Added — Brand asset management**
- `assets/branding/logo/`, `founder/`, `favicons/`, `social/`, `books/`,
  `resources/`, `team/` (new subfolders, each with its own README
  documenting expected filenames, recommended dimensions/formats/
  optimization, and current fallback behavior). No image files added
  anywhere — documentation only.
- `assets/branding/README.md` rewritten as an overview/index linking to
  each subfolder, keeping the existing "live-wired vs. static per page"
  explanation from Sprint 15 intact.
- Audited every page's `og:image` and favicon `<link>` tags — confirmed
  zero drift (100% identical across all pages), so the existing
  `assets/config/site.json` `branding` section remains the single
  accurate reference value; no code change was needed to achieve
  "one location, no duplicate paths" since nothing had drifted.

**Added — Content architecture (scaffold only, no real content)**
- `content/` — new top-level directory with `company/`, `founder/`,
  `books/`, `blog/`, `resources/`, `legal/`, `newsletter/`, `community/`,
  `events/`, `testimonials/`, `faq/` subdirectories, each with a README
  covering that content type's purpose, future file structure, and how
  content would be added once wired up. No sample/fake content files
  anywhere.
- `content/SCHEMA.md` — recommended JSON schema for Book, Blog Article,
  Resource, Team Member, Testimonial, FAQ, Newsletter Issue, and
  Community Event, each shaped to match how that content already
  looks/behaves on the live site (e.g. Blog Article's `body` field is a
  reference to the existing page, not inlined prose — long-form
  writing stays hand-written, only its repeated metadata centralizes).
- `js/content-loader.js` (new) — reusable `fetchContent`/
  `fetchContentList`/`renderInto`/`renderList` helpers with graceful
  fallback (resolve to `null`/no-op on any failure, never throw).
  **Not included via `<script>` tag on any page** — confirmed via
  search, matching the "do not implement dynamic rendering" instruction
  this phase was scoped under.

**Added — Documentation**
- `README.md`: new "Architecture overview" (the four layers: design
  system → configuration → branding → content), "Brand asset
  architecture," "Content architecture," "Future roadmap" (what a
  future local editor, Git-backed CMS, upload workflow, automated asset
  optimization, and build-time head-tag sync script would each need —
  none built), and "Developer onboarding" (a where-does-X-live table)
  sections. Renamed the existing "Configuration" section to
  "Configuration architecture" for naming consistency with the new
  sections; its content is unchanged. Folder-structure tree updated
  with the two new entries (`content/`, `js/content-loader.js`).

**Not changed, by design**
- Every page's real content, every existing page link, every design
  token, every component, the founder name, and the information
  architecture — untouched, per explicit instruction. This phase is
  additive documentation and empty-of-content scaffolding only.
- No build step was introduced. `content/` and `js/content-loader.js`
  work the same way `assets/config/site.json`/`js/content-inject.js`
  already do (plain static JSON, fetched same-origin) — GitHub Pages
  compatibility is unaffected.

**Verified**
- Local static server: zero console errors, zero failed network
  requests, homepage screenshot pixel-identical to the pre-phase state.
- Zero duplicate `id` attributes checked on `/` (10 ids) and `/contact/`
  (15 ids).
- Confirmed `js/content-loader.js` is not referenced by any page's
  `<script>` tag (grepped across the whole repo).
- Confirmed `og:image`/favicon paths remain identical across every page
  (no accidental drift introduced by this phase).

### Sprint 15 — Centralized Business-Info Configuration — 2026-07-05

A pure architecture/maintainability refactor — **no visual or content
change, verified pixel-for-pixel identical before/after**. Explicit scope
boundary for this sprint: don't touch the design system, IA, or founder
name (all reaffirmed as correct in the request that started this sprint);
instead give recurring business facts (company/founder/contact/social/
branding) a single source of truth so a future admin panel or Git-backed
CMS could edit them without touching HTML.

**Added**
- `assets/config/site.json` (new) — the single source of truth for
  company name/tagline/URL, founder name/title, the 3 contact emails,
  phone, location, and social links. `branding`/`seo` sections hold
  reference-only values for the static per-page tags (see "Not changed"
  below).
- `js/content-inject.js` (new) — fetches `site.json` once per page load
  (same fetch pattern as `js/includes.js`, same `partials:loaded`-driven
  timing as `js/components/nav.js`) and populates any
  `[data-content="dot.path"]` (textContent) or
  `[data-content-href="dot.path"]` (href) element. Fails silently on any
  fetch error — the page's existing static text is the fallback, not a
  placeholder waiting to be filled.
- `assets/branding/` (new folder + README) — where real logo/founder-
  portrait/favicon/OG-image files go once produced, with exact expected
  filenames and dimensions, and an explicit explanation of which fields
  are live-wired vs. which remain static per page and why.
- `data-content`/`data-content-href` bindings added to: `partials/header.html`
  and `partials/footer.html` (wordmark, tagline, 4 social hrefs,
  copyright company name + disclaimer, bottom-bar phone/location/
  website — covers all ~15 pages from these two shared-partial edits
  alone), `index.html`/`about/index.html` (founder name + title only —
  the surrounding biography stays as page copy, not config), and
  `contact/index.html` (the 3 email cards + the phone/website/location
  "direct details" block).
- `<script src="/js/content-inject.js"></script>` added to all ~15 pages
  plus `templates/page-template.html`, so future pages scaffolded from
  the template pick this up automatically.
- New "Configuration" section in `README.md` documenting `site.json` as
  the source of truth and pointing at `assets/branding/README.md` for
  the static-tag caveat.

**Not changed, by design**
- `<title>`, meta description, canonical URL, Open Graph/Twitter tags,
  favicon `<link>`s, and the `Organization` JSON-LD block on every page
  — these stay exactly as they were, hardcoded per page. Centralizing
  them via runtime JS would be a functional regression, not a
  maintainability win: social-share crawlers (Facebook/Twitter/
  LinkedIn link-unfurling bots) and favicon-fetching logic read the raw
  HTML response before any JavaScript executes, so a JS-injected value
  would never reach them. `site.json`'s `branding`/`seo` sections still
  document the canonical values; `assets/branding/README.md` spells out
  the manual-sync step this requires today, and notes a future
  build-time sync script (not built) as the way to remove that
  limitation entirely.
- Design tokens, component library, page structure/IA, and the founder
  name ("Robert Loh Kobla") — untouched, per explicit instruction.
  Existing `assets/icons/`/`assets/images/` files were left in place
  rather than moved into the new `assets/branding/` folder, since moving
  them would touch every page's `<head>` for no benefit.

**Verified**
- Local static server; confirmed `assets/config/site.json` fetches
  successfully and every `[data-content]`/`[data-content-href]` element
  resolves to the exact pre-existing text/href on `/`, `/contact/`, and
  `/blog/` (whose footer is only touched via the shared partial) — a
  screenshot comparison against the pre-refactor state showed zero
  visual difference.
- Temporarily changed the phone number in `site.json`, confirmed it
  updated on both the homepage/`/blog/` footer and the Contact page's
  two phone references with no HTML edits, then reverted it.
- Temporarily renamed `site.json` to simulate a fetch failure — pages
  kept showing their correct static fallback text, no `"undefined"`
  anywhere, no console error thrown — then restored the file and
  confirmed it re-fetches cleanly (200 OK).
- No console errors or failed requests on any page checked.

### Sprint 14 — Site Polish (Nav, Hero, Founder, Services, Contact, Footer, SEO, Dark Mode) — 2026-07-05

A broad polish pass across the homepage, Contact page, and shared header/
footer partials. Scope was deliberately kept inside the existing
architecture: no new pages, no palette replacement, no framework — every
addition reuses an existing component pattern (`.resource-card`,
`.hero--split`, `.field`/`.btn`, the site's placeholder convention) or
extends the semantic design-token system already in place.

**Added**
- Dark mode, sitewide: `[data-theme="dark"]` token overrides in
  `css/tokens.css`, a toggle button in `partials/header.html`, and
  `js/components/theme-toggle.js` (persists the choice to
  `localStorage`, applied on every page). Known trade-off: since there's
  no shared `<head>` partial, the stored preference is applied by JS
  after page scripts load rather than via a head-blocking inline
  script, so a returning dark-mode visitor may see a brief light-mode
  flash on navigation.
- Homepage Services section — 6 cards (Financial Education, Investment
  Insights, Budget Planning, Business Advisory, Market Research,
  Financial Tools), each linking to the closest existing destination
  page. Built on the existing `.resource-card` pattern, not a new
  component.
- Homepage hero rewrite — new headline/subhead copy, relabeled CTAs
  (Get Started / Contact Us), a `<!-- Founder Image Placeholder -->`
  block, and a decorative `.hero--gradient` background with slow-drift
  floating shapes (CSS-only, `aria-hidden`, neutralized automatically
  by the site's existing `prefers-reduced-motion` rule).
- Contact page: a real contact form (Name/Email/Phone/Message) with
  `js/components/contact-form.js` — client-side validation mirroring
  `newsletter-form.js`'s pattern, honest "not connected to a backend
  yet" confirmation on success (same honesty convention as
  `placeholder-action.js`). Also added phone/website display and a
  `<!-- Google Maps Placeholder -->` block.
- `js/components/scroll-reveal.js` + `[data-reveal]`/`.is-visible` CSS —
  a small IntersectionObserver-based fade-in, skipped entirely (content
  shown immediately) under `prefers-reduced-motion: reduce`.
- Footer: logo + one-line description band, a Services column, phone/
  website added to the bottom bar, and an explicitly-labeled social
  icon row (`<!-- Social Placeholder -->`, `href="#"`) ready to wire up
  once real accounts exist.
- `telephone` + `address` (`PostalAddress`, Accra, Ghana) fields added
  to the `Organization` JSON-LD block already repeated across all ~15
  pages — same small diff applied uniformly.

**Changed**
- Homepage "About Teaser" upgraded to "Meet the Founder" — name,
  "Founder & CEO" title, condensed bio, "Read More" button. Same
  section, same placeholder-image slot, just fuller content. The
  "Founder & CEO" label was also added next to the founder-story
  heading on `/about/` for consistency.
- Nav: added a hover color transition on nav links (there was
  previously only a static color and an active-page state, no hover
  treatment at all), and a scroll-triggered `.site-header--scrolled`
  shadow class via a small listener in `js/components/nav.js` (the
  header previously only had a static bottom border).

**Fixed**
- `.bg-paper`/`.bg-sand` utility classes (`css/utilities.css`) were
  pointing at raw palette colors instead of the semantic `--color-bg`/
  `--color-bg-alt` tokens, so dark mode initially left every section
  using them (hero, services, and others) stuck in light-mode colors
  while the rest of the page went dark. Repointed both to the semantic
  tokens — visually identical in light mode, correct in dark mode.
  `.bg-navy`/`.bg-charcoal` were left untouched since those are used
  for sections that are deliberately dark regardless of site theme.
- The mobile-nav hamburger icon's stroke color was hardcoded as
  `#16233D` inline in `partials/header.html`, so it wouldn't have
  flipped color in dark mode. Changed to `stroke="currentColor"`.

**Not changed (kept deliberately)**
- Color palette (Growth Green / Ink Navy / Sika Gold / Warm Paper) —
  kept as-is rather than replacing with the brief's literal "Deep Blue/
  White/Gold," since Ink Navy already reads as a deep blue against
  white surfaces and gold accents, and a sitewide token swap would
  re-trigger every prior contrast audit for no visual-direction change.
- Multi-page structure — new content became homepage sections/teasers
  linking to the existing, fully-built `/about/` and `/contact/` pages
  rather than replacing them.
- Founder name — "Robert Loh Kobla" kept everywhere it already
  appears (JSON-LD `founder.name`, page copy); "Founder & CEO" was
  added as a title alongside it, not a replacement.

**Verified**
- Local static-file server; clicked through homepage (hero, founder
  teaser, services, nav hover/scroll-shadow, dark-mode toggle across a
  reload) and `/contact/` (empty submit, invalid email, valid submit;
  phone/map display).
- Dark-mode background/text/border colors checked via computed styles
  after toggling, both immediately and after a page reload
  (`localStorage` persistence confirmed).
- Contact form: confirmed per-field error visibility toggling, focus
  moves to the first invalid field, and the honest confirmation message
  replaces the form on a valid submission.
- Scroll-reveal: confirmed above-the-fold content is visible
  immediately, below-the-fold content becomes visible on scroll, and a
  mocked `prefers-reduced-motion: reduce` match immediately marks
  content visible with no animation.
- JSON-LD sampled on two pages (`/` and `/about/`) — both parse as
  valid JSON and include the new `telephone` field.
- No console errors and no failed network requests on `/`, `/contact/`,
  or `/about/`.

### Sprint 13 — Disclaimer — 2026-07-04

`legal/disclaimer/index.html`, serving `/legal/disclaimer/` — the
third and final Legal page. With this sprint, **every URL currently
listed in `sitemap.xml` now resolves to a real page** (all 13 entries
have a `<lastmod>`, confirmed via `grep`). Built by directly mirroring
Privacy Policy and Terms of Use, as instructed. **Zero new CSS was
needed**; `css/` is byte-for-byte unchanged from Sprint 12.

**Added**
- `legal/disclaimer/index.html` — breadcrumb, hero (with effective/
  last-updated dates), sticky-on-desktop TOC + disclaimer body
  (Educational Purpose, No Financial Advice, Investment Risk,
  Accuracy of Information, External Links, Affiliate & Commercial
  Relationships, Limitation of Responsibility, Contact), Related
  Documents, newsletter CTA, shared footer.
- `Organization`, `WebPage`, and `BreadcrumbList` JSON-LD — same
  pattern as the other two Legal pages, no `FAQPage`.
- `<lastmod>2026-07-04</lastmod>` added to the existing
  `/legal/disclaimer/` sitemap entry — the last sitemap entry that
  didn't have one.

**Reused, not duplicated**
- The entire Privacy Policy / Terms of Use shell — `.article-layout` +
  `.article-body` + `.toc` (sticky sidebar, reading progress via
  `js/components/article-reading.js`, zero code changes),
  breadcrumbs, Related Documents' arrow-icon link pattern, newsletter
  band, and footer.
- `.alert--info` for two callouts (Accuracy of Information's "verify
  independently," Affiliate & Commercial Relationships' "we'll always
  disclose it") — same component, same honest-disclosure pattern as
  the other two Legal pages.
- Plain `<ul>` inside `.article-body` for Investment Risk's three
  points, matching Privacy Policy's approach for informational (not
  compare/contrast) enumerations — `.check-item`'s check/x split was
  intentionally *not* reused here, since this section has no "allowed
  vs. not allowed" structure the way Terms of Use's Permitted Use did.

**Content approach**
- States plainly that Robayer WealthLab is not a licensed financial
  advisory service, that investing involves risk, and that past
  performance doesn't guarantee future performance — directly
  addressing this sprint's instructions.
- Affiliate & Commercial Relationships is honest about the current
  state (no affiliate deals exist today) while committing to disclose
  any that start, consistent with how the other two Legal pages
  handle not-yet-active things.

**Verified**
- Reading-progress bar and TOC active-highlighting confirmed via
  computed style at a specific scroll position (43% progress, "No
  financial advice" correctly active).
- Sticky sidebar confirmed via computed style (`position: sticky`,
  `top: 112px`) at desktop width (1280px); single-column stacking
  confirmed at tablet (768px) and mobile (375px), with both
  `alert--info` callouts remaining fully readable at 375px.
- **All three Legal pages now cross-link correctly in every
  direction** — confirmed by clicking Disclaimer → Privacy Policy →
  Terms of Use → (implicitly) back — the first time this trio's
  Related Documents links have been fully non-broken.
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, no skipped levels.
- Zero console errors, zero failed network requests, zero duplicate
  IDs, zero inline styles, zero new/changed CSS.

### Sprint 12 — Terms of Use — 2026-07-04

`legal/terms-of-use/index.html`, serving `/legal/terms-of-use/` — the
second Legal page. Built by directly mirroring the Privacy Policy's
structure, as instructed. **Zero new CSS was needed**; `css/` is
byte-for-byte unchanged from Sprint 11.

**Added**
- `legal/terms-of-use/index.html` — breadcrumb, hero (with effective/
  last-updated dates), sticky-on-desktop TOC + terms body (Acceptance
  of Terms, Educational Purpose, Intellectual Property, Permitted Use,
  Purchases, External Links, Limitation of Liability, Changes to These
  Terms, Contact), Related Documents, newsletter CTA, shared footer.
- `Organization`, `WebPage`, and `BreadcrumbList` JSON-LD — same
  pattern as Privacy Policy, no `FAQPage` since this page has no FAQ
  section either.
- `<lastmod>2026-07-04</lastmod>` added to the existing
  `/legal/terms-of-use/` sitemap entry.

**Reused, not duplicated**
- The entire Privacy Policy shell — `.article-layout` + `.article-body`
  + `.toc` (sticky sidebar, reading progress via
  `js/components/article-reading.js` with zero code changes),
  breadcrumbs, Related Documents' arrow-icon link pattern, newsletter
  band, and footer — copied structurally, not just conceptually.
- `.check-item` (check icon + x icon, two-column `.grid--2`) for
  Permitted Use's "You may" / "You may not" split — the exact same
  pattern as Book Detail's "Who This Book Is For," applied to
  copyright/redistribution rules instead of reader fit.
- `.alert--info` for two callouts (Purchases' "not live yet," 
  Limitation of Liability's "as is" disclaimer) — consistent with how
  Privacy Policy and Book Detail both used the same component for
  in-body callouts.

**Content approach**
- States plainly that Robayer WealthLab is not a licensed financial
  advisor and that content here is educational only, per instruction.
- Purchases section is explicit that checkout isn't live yet and that
  full terms will be added once SkillsPad (or an equivalent) is
  actually wired up — consistent with how Privacy Policy handles
  not-yet-active third-party services, and with `placeholder-action.js`'s
  honest-not-a-dead-link pattern used elsewhere on the site.

**Verified**
- Reading-progress bar and TOC active-highlighting confirmed via
  computed style at a specific scroll position (44% progress,
  "Intellectual property" correctly active).
- Sticky sidebar confirmed via computed style (`position: sticky`,
  `top: 112px`) at desktop width (1280px); single-column stacking
  confirmed at tablet (768px); the "You may" / "You may not" two-column
  checklist confirmed collapsing to one column and remaining fully
  readable at mobile (375px).
- Cross-link between the two Legal pages confirmed working **both
  ways** — Terms of Use → Privacy Policy → Terms of Use — now that
  both exist; previously this was a one-sided forward-reference.
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, H3s correctly nested under "Permitted use."
- Zero console errors, zero failed network requests, zero duplicate
  IDs, zero inline styles, zero new/changed CSS.

**Testing note:** a keyboard-focus check in this session reported
`:focus-visible` as false on a simple `.focus()` call, even
immediately after a fresh page reload — traced to the automated
browser's keyboard/mouse modality tracking in this particular preview
session, not a regression: `base.css`'s focus rules are byte-identical
to the version already verified working in Sprint 11 (confirmed via
`git diff`/`grep`, zero CSS changes this sprint).

### Sprint 11 — Privacy Policy — 2026-07-04

`legal/privacy-policy/index.html`, serving `/legal/privacy-policy/` —
the first Legal page, and the first of the three "still missing" pages
flagged by the Sprint 10.5 audit to actually ship. Built entirely from
the existing design system. **Zero new CSS was needed**; `css/` is
byte-for-byte unchanged from Sprint 10.6. No architecture changed, so
`README.md` was left untouched per this sprint's own instruction.

**Added**
- `legal/privacy-policy/index.html` — breadcrumb, hero (with effective/
  last-updated dates), a sticky-on-desktop table of contents alongside
  the policy body (Information We Collect, How We Use Information,
  Cookies, Third-Party Services, Data Security, Your Rights, Contact),
  Related Documents, newsletter CTA, and the shared footer.
- `Organization`, `WebPage`, and `BreadcrumbList` JSON-LD. No
  `FAQPage` this time — this page genuinely has no FAQ section, unlike
  every other page that's carried one so far.
- `<lastmod>2026-07-04</lastmod>` added to the existing
  `/legal/privacy-policy/` sitemap entry.

**Reused, not duplicated**
- `.article-layout` + `.article-body` + `.toc` (Sprint 3/6) for the
  sticky-sidebar-TOC-plus-content shell — the exact same pattern built
  for the Blog Article template turns out to fit a legal document just
  as well, since both are "long content with named sections." This is
  the `.toc` component's **eighth** distinct reuse context.
- `js/components/article-reading.js` reused as-is for the reading-
  progress bar and TOC active-section highlighting — both verified
  working here with zero code changes, since the module was already
  written generically against `[data-article-body]`/`[data-toc]`
  rather than anything Blog-specific.
- `.table` for the cookie-type breakdown (Essential/Analytics/
  Marketing) — the same component used for Book Detail's tenor/rate
  comparison, applied to genuinely different content.
- `.alert--info` reused twice as in-policy callouts (Third-Party
  Services' "nothing is active yet," Data Security's "no guarantee of
  absolute security") — consistent with how Book Detail used the same
  component for its own callouts.
- The arrow-icon "link row" pattern from `blog-card`'s "Read article"
  links, reused for Related Documents — three simple links, not a
  second copy of any card component.
- `.newsletter-band`, shared footer, breadcrumbs (matching Book
  Detail/Blog Article/Community's precedent for one-level-deep pages).

**Content approach**
- Written to honestly reflect the site's actual current state rather
  than describing infrastructure that doesn't exist yet: cookies,
  analytics, and third-party services (SkillsPad, an email platform,
  Google Analytics) are explicitly described as not yet active, with a
  commitment to update the policy when any of them turn on — directly
  addressing this sprint's instruction to explain that users will be
  notified. Data Security avoids overstating guarantees, per
  instruction, stating plainly that no online storage/transmission is
  completely secure.
- Effective date and Last updated both use today's date (July 4,
  2026) rather than literal placeholder text, consistent with how
  every other dated page on the site presents real dates.

**Verified**
- Reading-progress bar and TOC active-highlighting confirmed via
  computed style at a specific scroll position (57% progress, "Cookies"
  correctly active).
- Sticky sidebar confirmed via computed style (`position: sticky`,
  correct `top` offset) at desktop width (1280px); single-column
  stacking confirmed at tablet (768px) and mobile (375px), with the
  cookies table remaining fully readable and non-overflowing at 375px.
- Breadcrumb, all Related Documents links (including the two that
  correctly 404 — Terms of Use and Disclaimer aren't built yet — and
  the two that resolve — Contact and the `mailto:` link) confirmed.
- Keyboard focus confirmed on a TOC link via computed style (2px
  Growth Green outline, matching the site-wide standard).
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, no skipped levels.
- Zero console errors, zero unexpected failed network requests, zero
  duplicate IDs, zero inline styles, zero new/changed CSS.

### Sprint 10.6 — Launch Readiness Fixes — 2026-07-04

Three targeted fixes from the Sprint 10.5 Production Readiness Audit,
no new pages, no visual regressions.

**Fixed**
- The newsletter form's validation-error message was visible on every
  page by default, before any interaction — confirmed via computed
  style during the Sprint 10.5 audit (`hidden` attribute present,
  computed `display: flex`, genuinely visible to the user). Root
  cause: `.field__error { display: flex; }` in `components.css` always
  wins over the native `[hidden]` behavior, since author-stylesheet
  rules beat the UA stylesheet regardless of specificity. Added
  `.field__error[hidden] { display: none; }`, which has higher
  specificity than the base rule and correctly restores the intended
  hidden-until-invalid behavior. `newsletter-form.js` already toggled
  the `hidden` property correctly on every page — only the missing CSS
  override was ever the problem, so no JS changes were needed.
  Confirmed `components.html`'s intentional error-state demo (which
  has no `hidden` attribute at all) is unaffected and still displays
  as designed.
- `partials/footer.html`'s Community link read "Community (coming
  soon)" since Phase 5.1, unchanged through Sprint 9 shipping it as a
  real page. Now reads "Community" — fixed once, in the shared
  partial, so it's corrected on all 10 pages simultaneously.
- `README.md`'s sprint table, last updated in Sprint 6.5, now includes
  Sprints 7–10.6, the folder structure diagram includes `about/`,
  `contact/`, `community/`, and `newsletter/`, and the "Open items" /
  "What comes next" sections reflect what the Sprint 10.5 audit
  actually found still missing (three Legal pages, remaining Blog
  articles, the second Book) rather than the now-resolved "About/
  Contact/Community/Newsletter not built yet" framing.

**Verified**
- Computed-style check confirms the error message is hidden
  (`display: none`) by default on Home, Books, and Newsletter; an
  actual invalid submission (`not-an-email`) correctly reveals it with
  the existing error-state border/focus styling; a subsequent valid
  submission correctly replaces the form with the confirmation
  message, exactly as before.
- Footer "Community" text confirmed corrected on Home, Books, and
  About via direct DOM inspection (proving the partial-based fix
  propagated, not just the one file edited).
- Mobile (375px) spot-check on About confirms no layout regression in
  either the newsletter band or the footer.
- Zero console errors, zero failed network requests, zero inline
  styles, CSS brace-balanced.

### Sprint 10 — Newsletter Page — 2026-07-04

`newsletter/index.html`, serving `/newsletter/` — the single
most-referenced forward link on the entire site (every page's header
CTA, and dozens of in-page links since Phase 5.1, have pointed here).
Built entirely from the existing design system. **Zero new CSS was
needed**; `css/` is byte-for-byte unchanged from Sprint 9.

**Added**
- `newsletter/index.html` — hero, Why Subscribe, What You'll Receive,
  Newsletter Archive Preview, Subscriber Journey, FAQ, a final CTA,
  the newsletter signup itself, and the shared footer.
- `WebPage` JSON-LD (no dedicated "Newsletter" type exists in
  schema.org's vocabulary, so `WebPage` — the same choice made for
  Community — is the appropriate fit here too), alongside the
  established Organization and FAQPage schema.
- `<lastmod>2026-07-04</lastmod>` added to the existing `/newsletter/`
  sitemap entry.

**Reused, not duplicated**
- `.hero` (centered, matching Books/Resources/Blog's content-hub
  pattern rather than About/Contact/Community's `.hero--split`, since
  there's no founder/company-photo concept here).
- `.card` in a `.grid--4` for Why Subscribe.
- `.check-item` in a `.grid--2` for What You'll Receive.
- `.blog-card` reused for the Newsletter Archive Preview (`.grid--3`,
  three sample issues) — deliberately **without** the "Read article"
  link every other use of this component has had, since there's no
  real archive page yet to send readers to; adding one would have been
  a dead link. Designed so real issues can drop in as plain
  `.blog-card` entries later with no structural changes.
- `.toc` reused a **seventh** distinct way — a linear subscriber
  journey (Subscribe → Confirmation → Weekly lessons → Resources →
  Community → Courses) — after book chapters, popular resources,
  popular articles/beginner's path, in-page article navigation,
  About's company timeline, and Community's rollout roadmap.
- `.faq`, `.feature-banner__eyebrow`/`__title`/`__copy` reused
  standalone (fifth use, after Resources/About/Contact/Community) for
  the final CTA, `.newsletter-band`, shared footer.

**Verified**
- Full pass at mobile (375px), tablet (768px), and desktop (1280px):
  hero, the Why-Subscribe `.grid--4` and What-You'll-Receive `.grid--2`
  collapses, and the three-card `.grid--3` archive preview all
  confirmed correct.
- FAQ accordion verified via direct DOM inspection
  (`hasAttribute('open')`) on a specific item, confirming exactly one
  opens per click.
- Both `#newsletter-signup` anchor links (hero and final CTA) and the
  newsletter form (fill → submit → confirmation message) tested
  end-to-end.
- Confirmed, for the first time, that the header's "Get one better
  money tip" `.nav__cta` button correctly receives
  `aria-current="page"` when its own `/newsletter/` link matches the
  current page — and confirmed via computed style that this causes no
  unwanted visual change, since the `.nav__list a[aria-current="page"]`
  CSS rule is scoped to list links and doesn't match `.nav__cta`
  (a sibling element, not a list item).
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, H3s correctly nested under the four Why-Subscribe
  cards.
- Zero console errors, zero failed network requests, zero duplicate
  IDs, zero inline styles, zero new/changed CSS. One transient
  screenshot-tool timeout during testing resolved on retry with no
  underlying page issue (page `readyState` was already `"complete"`
  and all network requests had returned 200 before the retry).

### Sprint 9 — Community Page — 2026-07-04

`community/index.html`, serving `/community/` — built entirely from
the existing design system. **Zero new CSS was needed**; `css/` is
byte-for-byte unchanged from Sprint 8.

**Added**
- `community/index.html` — hero, Why Community Matters, What You'll
  Receive, Community Roadmap, Community Principles, Success Stories,
  FAQ, Community Invitation, newsletter CTA, and the shared footer.
- `WebPage` and `BreadcrumbList` JSON-LD, per this sprint's explicit
  request, alongside the established Organization and FAQPage schema.
  Added a visible "Home / Community" `.breadcrumbs` trail to match the
  `BreadcrumbList` data exactly — Community isn't a detail/sub-page
  like Book Detail or Blog Article (the only two prior pages with
  breadcrumbs), but since structured data must match visible content,
  a page that declares `BreadcrumbList` needs a visible breadcrumb to
  back it up.
- `<lastmod>2026-07-04</lastmod>` added to the existing `/community/`
  sitemap entry.

**Reused, not duplicated**
- `.hero--split` for the hero — third real use (after About, Contact).
- `.card` + `.check-item` combined for Why Community Matters (a
  `.grid--4` of cards, each containing a single check-item row instead
  of a separate title+body) — a new composition of two existing
  components, not a new component.
- `.card` + `.badge` for What You'll Receive (`.grid--3`, six cards) —
  `badge--success "Ongoing"` for the four available items and
  `badge--warning "Coming soon"` for the two not yet built, which
  cross-references the roadmap section directly below.
- `.toc` (Sprint 3) reused a **sixth** distinct way — a staged rollout
  timeline (Today → Soon → Later → Future → Long-term) — after book
  chapters, popular resources, popular articles/beginner's path,
  in-page article navigation, and About's company timeline. No new
  timeline component was needed, as instructed.
- `.check-item` again (single-column `.stack`, not a grid — five items
  don't split evenly into two columns) for Community Principles.
- The same three established testimonials (Ama, Kwame, Efua) for
  Success Stories — no new people invented, per this sprint's explicit
  instruction.
- `.faq`, `.feature-banner__eyebrow`/`__title`/`__copy` reused
  standalone (fourth use, after Resources/About/Contact) for the
  Community Invitation, `.newsletter-band`, shared footer.

**Caught and fixed one inline style before it shipped**
- Repeated the exact same mistake from Sprint 7: copied
  `style="display:block"` onto an eyebrow span out of old habit while
  drafting Success Stories. Caught immediately in the zero-inline-
  styles check and removed — `.eyebrow` has been `display: block` by
  default since Phase 1.

**Verified**
- Full pass at mobile (375px), tablet (768px), and desktop (1280px):
  hero--split, the Why-Community-Matters `.grid--4` (4→2→1) and
  What-You'll-Receive `.grid--3` (3→2→1) collapses all confirmed
  correct.
- FAQ accordion verified via direct DOM inspection
  (`hasAttribute('open')`) on a specific item (not just the first),
  confirming exactly one item opens per click; the FAQ answer's
  `/contact/` link confirmed present.
- Both anchor links (`#newsletter-signup` from the Community
  Invitation CTA) and the newsletter form (fill → submit → confirmation
  message) tested end-to-end.
- Confirmed Community intentionally has no header-nav `aria-current`
  target, consistent with Contact (both are footer-only links; Books/
  Blog/Resources/About are the four header-nav items).
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, H3s correctly nested under the six What-You'll-
  Receive cards.
- Zero console errors, zero failed network requests, zero duplicate
  IDs, zero inline styles, zero new/changed CSS.

### Sprint 8 — Contact Page — 2026-07-04

`contact/index.html`, serving `/contact/` — built entirely from the
existing design system. **Zero new CSS was needed**; `css/` is
byte-for-byte unchanged from Sprint 7.

**Added**
- `contact/index.html` — hero, Contact Methods (three cards), Before
  You Email Us checklist, FAQ, Community Invitation, newsletter CTA,
  and the shared footer.
- `ContactPage` JSON-LD (`mainEntity` → Organization with the General
  enquiries email), alongside the existing Organization and FAQPage
  schema.
- `<lastmod>2026-07-04</lastmod>` added to the existing `/contact/`
  sitemap entry.

**Reused, not duplicated**
- `.hero--split` for the hero — its second real use (after About),
  now with a "Browse our guides" / "Join the newsletter" action pair
  instead of a single CTA.
- `.card` in a `.grid--3`, `.badge` (info/success/warning, one per
  card), and `.check-item` for each Contact Method — the mail icon +
  email pattern reuses the same icon already shown in `components.html`
  and used on About's Core Values, this time as a real `mailto:` link
  rather than decoration.
- `.check-item` again (in a `.grid--2`, matching About's Promises
  layout) for Before You Email Us, with three of its four items linking
  to `/resources/`, `#faq` (this page), and `#newsletter-signup` (this
  page) — genuinely actionable, not just decorative bullets.
- `.faq` for the FAQ section.
- `.feature-banner__eyebrow` / `__title` / `__copy` reused standalone
  for the Community Invitation — third use of this pattern after
  Resources and About, following the same "no natural cover image"
  reasoning.
- `.newsletter-band`, partials/footer.html — no new one-off styles.

**Verified**
- Full pass at mobile (375px), tablet (768px), and desktop (1280px):
  hero--split layout, the `.grid--3` card grid's 3→2→1 collapse, and
  the Before-You-Email-Us checklist's 2→1 collapse all confirmed
  correct.
- FAQ accordion confirmed via direct DOM inspection (`hasAttribute
  ('open')`), not just visually — one screenshot during testing showed
  what looked like two items open at once, traced to a rendering/
  timing artifact in the screenshot capture tool itself, not a real
  state bug (`.faq` is native `<details>` with zero custom JS, so
  there's no code path for spurious multi-open behavior; direct DOM
  inspection confirmed only the single clicked item was actually open).
- All contact page links verified individually: three `mailto:` links,
  `/resources/`, `#faq`, `#newsletter-signup`, `/books/`, `/newsletter/`.
- Newsletter form tested end-to-end (valid email → confirmation
  message swap).
- Confirmed Contact intentionally has no header-nav `aria-current`
  target — it's a footer-only link (Books/Blog/Resources/About are the
  four header-nav items), consistent with the existing site structure,
  not a gap introduced here.
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, H3s correctly nested under the three Contact Method
  cards.
- Zero console errors, zero duplicate IDs, zero inline styles, zero
  new/changed CSS. The only failed network requests seen during
  testing were pre-existing, expected 404s for `/legal/terms-of-use/`
  and `/legal/disclaimer/` (unbuilt in every prior sprint, listed as
  such in `sitemap.xml`) — unrelated to anything added this sprint.

### Sprint 7 — About Page — 2026-07-04

`about/index.html`, serving `/about/` — built entirely from the
existing design system. **Zero new CSS was needed for this page**;
`css/` is byte-for-byte unchanged from Sprint 6.5.

**Added**
- `about/index.html` — hero, Why Robayer WealthLab Exists, Founder
  story, Mission & Vision, Core values, Brand manifesto highlights, Our
  promises to readers, Why trust Robayer WealthLab (testimonials),
  Timeline & roadmap, FAQ, newsletter CTA, and the shared footer.
- `<lastmod>2026-07-04</lastmod>` added to the existing `/about/`
  sitemap entry.

**Reused, not duplicated**
- `.hero--split` — demoed in `components.html` since Phase 1 with this
  exact "About Robayer / Someone slightly ahead on the journey" copy,
  and never actually used on a real page until now.
- `.feature-banner__eyebrow` / `__title` / `__copy` reused standalone
  (no image side) for "Why Robayer WealthLab Exists" — same pattern as
  Resources' featured-resource section.
- `.article-body` (Sprint 6) for the founder story's multi-paragraph
  prose — first use of it for narrative biography rather than an
  instructional article.
- `.card` in a `.grid--2` for Mission & Vision — two cards, no new
  variant needed.
- The exact icon+heading+description pattern from Home's trust section
  (Sprint 1) for Core Values — same structure, different (and
  deliberately non-duplicate) content: Home covers founder-led/no-hype/
  Ghana-first/free-to-start; About goes deeper into honesty, meeting
  readers where they are, plain language, and Ghana-first specifically
  in the guides.
- `.pull-quote` + `.check-item` for the manifesto section, and
  `.check-item` again (in a `.grid--2`) for the promises section — same
  component, two different tones (belief statements vs. concrete
  commitments).
- The same three established testimonials (Ama, Kwame, Efua) for "Why
  trust Robayer WealthLab" rather than inventing new ones — reused
  exactly as they appear on Home and Book Detail.
- `.toc` (Sprint 3) reused for a **fifth** distinct purpose: a
  sequential company timeline, after book chapters, popular resources,
  popular articles/beginner's path, and in-page article navigation —
  further confirmation the component is genuinely generic.
- `.faq`, `.newsletter-band`, partials/footer.html — no new one-off
  page styles anywhere.

**Content note**
- The founder biography expands the facts already established
  elsewhere on the site (founder-led, simplifies financial education
  for ordinary Ghanaians, honest guidance one step at a time) into a
  fuller narrative, without introducing new unverifiable biographical
  claims (no invented employer history, credentials, or dates) —
  consistent with the brand's "no hype, ever" principle.

**Caught and fixed one inline style before it shipped**
- Copied an old pattern (`style="display:block"` on an eyebrow span)
  out of habit while drafting the "Why trust us" section — caught
  immediately in the zero-inline-styles check. `.eyebrow` has been
  `display: block` by default since Phase 1, so the span was removed
  entirely rather than fixed, same resolution as the identical issue
  found and fixed on Home back in Sprint 1.5.

**Verified**
- Full regression-style pass: mobile (375px), tablet (768px), and
  desktop (1280px) — hero--split side-by-side layout, Mission/Vision
  and Core Values grid collapse (2→1 and 4→2→1), testimonials grid,
  and the founder-story prose measure all confirmed correct at each
  width.
- FAQ accordion, the hero's `#founder-story` anchor link, and nav
  `aria-current="page"` on the About link all confirmed working.
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, correctly nested H3s under Mission/Vision and Core
  Values, and a `sr-only` H2 giving the combined Mission/Vision section
  a proper accessible name without a redundant visible heading.
- Zero console errors, zero failed network requests, zero duplicate
  IDs, zero inline styles, zero new/changed CSS.

### Sprint 6.5 — Architecture Refinement — 2026-07-04

A pure technical-improvement sprint following Architecture Review 2 —
no new pages or user-facing features. Every item below was scoped,
prioritized, and approved in the review before work began.

**Priority 1 — Accessibility (critical)**
- Fixed the `--color-text-secondary` WCAG AA contrast failure
  identified in the review (computed ~2.76:1 on Warm Paper, ~2.98:1 on
  white — both well under the 4.5:1 requirement for normal text).
  Added a new `--color-slate` token (`#6B675E`) and repointed
  `--color-text-secondary` to it — now ~5.2:1 on Warm Paper and ~5.6:1
  on white, comfortably passing AA on both. `--color-stone-grey`
  itself is unchanged (still used for `--color-border-strong` and the
  disabled-button background, both non-text uses with no contrast
  requirement to fix), so no border or disabled-state appearance
  changed — only text got darker.
- Found and fixed one place this token change wouldn't have reached
  on its own: `.blog-card__meta` (article date + reading time)
  referenced `--color-stone-grey` directly instead of through
  `--color-text-secondary`. Repointed it, since it's unambiguously
  secondary body text. Checked every other usage of both tokens across
  `components.css` and confirmed no other text-color usage was missed.
- Deliberately left `dev-showcase.css`'s `.showcase-label` (a
  `components.html`-only caption label) on `--color-stone-grey` —
  it's dev tooling, not real body text on a real page, so it's out of
  the stated scope ("all normal body text").

**Priority 2**
- Consolidated `buy-button.js` into `placeholder-action.js` and
  deleted the former, closing the duplication flagged (and left
  unresolved) in both the Sprint 4 and Sprint 5 CHANGELOGs. The Book
  Detail buy button now uses `data-placeholder-action` with an
  explicit `data-message` reproducing the original wording exactly
  ("Checkout is launching soon — subscribe to know the moment it
  opens.") — verified byte-for-byte after the swap, not just visually.
- Rewrote `README.md` to describe the project's actual current state:
  a sprint-by-sprint table (5.1 through 6.5), the real folder structure
  (`books/`, `blog/`, `resources/`, all `js/components/` files), what's
  still unbuilt (About/Newsletter/Contact/Community/Legal), and an
  accurate open-items list (production domain confirmed; placeholder
  favicons already in place; final art and font self-hosting still
  open). Removed every "Phase 5.2 onward" reference — that framing was
  frozen at Phase 5.1 and hadn't been touched since, despite 6 shipped
  sprints since then.
- Brought `components.html` — the project's living style guide — back
  in sync. It hadn't been updated since Phase 1 and was missing every
  component introduced from Sprint 1.5 through Sprint 6. Added 8 new
  numbered sections (20–27): Feature Banner, Pull Quote, Filter Bar,
  Table of Contents, Check Items, Breadcrumbs, Article Body & Layout,
  and Reading Progress Bar — plus the new color tokens (Slate, the four
  semantic tints, the two hover-darken shades) added to the Color
  Palette section, and a new Z-index Scale table appended to the
  Spacing section.

**Priority 3**
- Moved the last 8 hardcoded hex values out of `components.css` and
  `dev-showcase.css` into new `tokens.css` custom properties:
  `--color-growth-green-dark` / `--color-sika-gold-dark` (button hover
  states) and `--color-success-tint` / `--color-warning-tint` /
  `--color-error-tint` / `--color-info-tint` (badge/alert backgrounds).
  `grep` confirms zero hardcoded hex values remain outside
  `tokens.css`.
- Added a semantic z-index scale to `tokens.css` — `--z-sticky` (100),
  `--z-overlay` (200), `--z-skip-link` (1000) — and wired the three
  existing raw z-index values (`.site-header`, `.reading-progress`,
  `.skip-link`) to them. Values are unchanged, so layering behavior is
  identical; only future additions now have a scale to fit into
  instead of picking another ad hoc number.
- Added the missing `favicon-32.png` `<link>` to `index.html` (Home
  was the one page, dating to Phase 5.1, that never had it).
- Set `font-weight: var(--weight-medium)` explicitly on `.pull-quote`
  and `.testimonial__quote` (the latter wasn't named in the sprint
  brief but has the identical issue) — Fraunces only loads one italic
  weight (500), and both components were rendering italic text at an
  inherited weight the font set doesn't actually include.

**Explicitly not done**
- The newsletter-band partial extraction was intentionally deferred,
  per instruction — the block is still duplicated verbatim across all
  6 pages. Revisit once the remaining pages are built, if the
  duplication still looks worth solving at that point.

**Verified — full regression pass, not just the changed areas**
- Contrast fix confirmed via computed style (`rgb(107, 103, 94)` =
  `#6B675E`) on Home, and visually on every other page's card
  descriptions, testimonial context, blog-card meta, and FAQ answers.
- `buy-button.js` → `placeholder-action.js` swap confirmed via the
  exact rendered message text on Book Detail, plus a network-tab check
  that the deleted file produces no 404 anywhere.
- Books' category filter and Resources' combined category+search
  filter re-tested and still correct after the token/CSS changes (they
  don't touch color, but this was a full regression pass, not a
  targeted one).
- Blog Article's reading-progress bar and TOC active-highlighting
  re-verified at three distinct scroll positions (0%, ~45%, ~94%) with
  the correct section active at each — this actually caught a
  methodology bug in my own testing (see note below), not a site bug.
- z-index values confirmed identical before/after tokenization via
  computed style (100/200/1000).
- `components.html`'s 8 new sections and updated color palette
  rendered and visually checked one by one; confirmed the two new
  demo-only classes needed for the Reading Progress Bar section
  (`.showcase-progress-track`/`.showcase-progress-demo`, added to
  `dev-showcase.css`) since the real `.reading-progress` component is
  `position: fixed` and can't be shown in-flow.
- Mobile (375px) spot-check on Blog Article (the most structurally
  complex page) — layout intact, contrast fix legible, no regressions.
- Zero console errors, zero failed network requests, zero inline
  styles anywhere in production pages; `components.html`'s inline-style
  count is 26, all pre-existing or newly-documented exceptions (unique
  per-swatch/per-bar values), consistent with the rule established in
  Sprint 1.5.

**Testing note:** while re-verifying the reading-progress bar, I hit
inconsistent readings that turned out to be caused by my own test
methodology, not the site: `html { scroll-behavior: smooth }` (global,
from `base.css`) makes `window.scrollTo()` animate asynchronously, so
checking computed styles synchronously right after a scroll call read
a stale, mid-animation position. Switching to
`window.scrollTo({top, behavior: 'instant'})` in verification fixed it
immediately and confirmed the underlying feature was never broken.

### Sprint 6 — Blog Article Template — 2026-07-04

`blog/what-are-treasury-bills-in-ghana/index.html` — the first real
article, and the canonical template every future article will be
built from. Four small, genuinely reusable additions to the design
system; everything else composes existing components in new ways.

**Added**
- `blog/what-are-treasury-bills-in-ghana/index.html` — breadcrumbs,
  hero (category, title, subtitle, author byline with publish/update
  dates and reading time), a sticky-on-desktop table of contents, a
  fully-written article body (pull quote, two info/warning callouts, a
  comparison table, numbered and bulleted lists, a "Key takeaways"
  box), FAQ, related articles, newsletter CTA, disclaimer, and the
  shared footer.
- `js/components/article-reading.js` — one scroll listener driving two
  related affordances: a fixed reading-progress bar and active-section
  highlighting in the table of contents. Both are optional per-page
  (each checks its own markup exists before doing anything), so a
  future short article can skip either without touching this file.
- Four new CSS additions in `css/components.css`, each checked against
  the existing system first and each reusable by every future article:
  - `.article-layout` / `.article-layout__sidebar` — a sticky
    sidebar-TOC + content grid (260px + 1fr, ≥1200px only; single
    column below that). Nothing existing provided an asymmetric
    2-column layout — `.grid--2` is equal-width, `.hero--split` isn't
    sticky and isn't meant for this.
  - `.article-body` — restores real `disc`/`decimal` list markers and
    heading/paragraph vertical rhythm for long-form prose, scoped so
    it doesn't touch the site-wide `list-style: none` reset that every
    other (non-prose) list on the site correctly relies on.
  - `.toc__title a[aria-current="location"]` — active-link styling for
    the table of contents, set by `article-reading.js`.
  - `.reading-progress` — the fixed progress bar. Its width is driven
    by a `--reading-progress` custom property set from JS, not an
    inline `style` attribute, keeping the "zero inline styles" rule
    intact even for a continuously-variable runtime value.
- `Article`, `BreadcrumbList`, and `FAQPage` JSON-LD, plus `og:type:
  article` with `article:published_time` / `article:modified_time` /
  `article:author` / `article:section` — the first page on the site to
  use Open Graph's article type, appropriately, since it's the first
  page that actually is one.
- Two new sitemap entries with `<lastmod>` dates: `/blog/` (today) and
  `/blog/what-are-treasury-bills-in-ghana/` (2026-07-01, the article's
  own stated update date, not the sprint's build date).

**Reused, not duplicated**
- `.breadcrumbs` (Sprint 3) for wayfinding.
- `.testimonial__attribution` / `__avatar` / `__name` / `__context`
  reused standalone (no `.testimonial` card wrapper) for the author
  byline — same "reuse the color/layout classes outside their original
  component" pattern as `.feature-banner__*` in Sprints 4–5.
- `.pull-quote` (Sprint 1.5) for the mid-article pull quote — first
  use inside actual long-form body copy rather than a marketing
  section.
- `.alert--info` / `.alert--warning` (Phase 1) reused as in-article
  information and caution callout boxes — no new "callout" component
  needed, the existing alert styling already fit.
- `.table` (Phase 1, only ever shown in the `components.html` style
  guide) gets its first real use, for the tenor/rate comparison.
- `.card` + `.check-item` (Sprint 3) combined for the "Key takeaways"
  box — zero new CSS for a component that looks purpose-built.
- `.toc` (Sprint 3) used for real in-page navigation this time (with
  working anchor links and JS-driven active state), its fourth
  distinct context after book chapters, popular resources, and popular
  articles/beginner's path.
- `.faq`, `.blog-card` (Related Articles), `.newsletter-band` — no new
  one-off page styles anywhere.

**Honesty in financial content**
- The tenor/rate comparison table is explicitly labeled "Illustrative
  rate" with a callout immediately below stating the numbers are for
  teaching the tenor/rate relationship only, not a current-rate claim,
  and pointing readers to confirm real rates with their bank or the
  Bank of Ghana — consistent with the brand's established "no hype,
  ever" principle rather than presenting invented figures as fact.

**Verified**
- Reading-progress bar and TOC active-highlighting both checked via
  direct property/attribute inspection at multiple scroll positions
  (not just visually) — confirmed correct percentage and correct
  active link at each position tested.
- Sticky sidebar confirmed via computed style (`position: sticky`,
  correct `top` offset) at desktop width (1280px); single-column
  stacking confirmed at tablet (768px) and mobile (375px), with the
  comparison table and callouts remaining fully readable at 375px.
- FAQ accordion, TOC anchor navigation, and the Related Articles /
  breadcrumb links all confirmed working.
- Caught and fixed a local-verification-only issue: the ad-hoc static
  server used for manual testing didn't resolve directory-style URLs
  (e.g. `/blog/…/`) the way GitHub Pages does in production, which
  initially made a same-site link check look inconclusive. Patched the
  throwaway dev server (not part of the project) to resolve
  `index.html` for any directory, then re-verified every cross-page
  link (Home → Books → Book Detail → Blog → Article → back via
  breadcrumb) resolves correctly.
- Heading hierarchy (single H1, one H2 per section/subsection, no
  skipped levels) confirmed via a full heading dump.
- Zero console errors, zero failed network requests, zero inline
  styles.

### Sprint 5 — Blog Index — 2026-07-04

`blog/index.html`, serving `/blog/` — the destination the "Blog" nav
link and footer link have pointed to since Phase 5.1. Built entirely
from the existing design system: **no new CSS was added this
sprint** — the only structural change is a JavaScript consolidation
that removes duplication instead of adding to it.

**Added**
- `blog/index.html` — hero, Featured Article spotlight, a
  search+category-filterable "Latest articles" grid (8 articles),
  Popular Articles, a Beginner's Path reading order, newsletter CTA,
  FAQ, and the shared footer (per the section order requested for this
  sprint, Newsletter comes before FAQ here, unlike Sprints 2–4).
- `js/components/content-filters.js` — see "engineering decision"
  below.
- `FAQPage` JSON-LD, alongside the existing Organization schema.
  Individual `BlogPosting` schema is deferred to Sprint 6's article
  pages, where it belongs, not the index.
- `<lastmod>2026-07-04</lastmod>` added to the existing `/blog/`
  sitemap entry.

**Engineering decision: generalized the filter script instead of
writing a third copy**
- By this sprint there would have been three near-identical filter
  scripts: `book-filters.js` (Sprint 2, category-only),
  `resource-filters.js` (Sprint 4, category + search), and a
  hypothetical `blog-filters.js`. Per this sprint's explicit
  instruction not to duplicate JavaScript that can be generalized,
  replaced both existing scripts with one `content-filters.js`,
  driven by generic data attributes (`[data-filter-grid]`,
  `[data-filter-controls]`, `[data-filter-search]`,
  `[data-filter-empty]`) instead of page-specific ones. `book-filters.js`
  and `resource-filters.js` are deleted; `books/index.html` and
  `resources/index.html` were updated to the generic attribute names
  and now include `content-filters.js` — a pure rename with no
  behavior change, re-verified below. (This is a deliberate exception
  to the general rule of not touching already-shipped sprints without
  being asked — justified here because the instruction for this
  sprint explicitly called for it, and the change is mechanical and
  low-risk.)

**Reused, not duplicated**
- `.blog-card` (defined since Phase 1, only ever shown in the
  `components.html` style guide until now) gets its first full real
  use — category via `.eyebrow`, reading time + publication date via
  `.blog-card__meta` (with a semantic `<time datetime>` element), and
  a "Read article" link using the existing arrow icon, alongside the
  already-linked title. No new fields needed new CSS.
- `.feature-banner__eyebrow` / `__title` / `__copy` for the Featured
  Article, this time with the full flex `.feature-banner` layout
  (image + text side by side) since `.blog-card__image` (16:9) works
  as a "cover" the way it didn't for Sprint 4's resources.
- `.filter-bar` / `.filter-pill` (Sprint 2) for the Saving / Investing
  / Budgeting category pills.
- `.toc` (Sprint 3) reused for a **third** distinct purpose: a
  ranked "Popular articles" list and a sequential "Beginner's path"
  reading order — different content, same component, on the same
  page, which is the clearest evidence yet that the component is
  genuinely generic rather than book-specific.
- `.alert--info` (empty state), `.faq`, `.newsletter-band` — no new
  one-off page styles anywhere.

**Prepared for Sprint 6**
- All eight articles use the `/blog/<slug>/` URL convention (matching
  Books' `/books/<slug>/` pattern from Sprint 3) in the title link,
  the "Read article" link, and the Featured Article CTA — Sprint 6 can
  build each detail page at its already-referenced address with no
  link changes needed here.
- Category taxonomy (Saving/Investing/Budgeting) is consistent with
  Resources' taxonomy so a future cross-page "related content" feature
  wouldn't need a mapping layer.

**Verified**
- Confirmed **zero new CSS was needed** — checked the existing system
  first, per this sprint's explicit instruction, before writing any
  markup.
- Regression-tested Books and Resources after the `content-filters.js`
  migration: Books' category filter and Resources' combined
  category+search filter both still work correctly, confirmed via
  direct DOM inspection, not just visually.
- Blog's own search, category filter, and combined use tested the same
  way; empty-state message and its subscribe link confirmed.
- Every Popular Articles / Beginner's Path anchor link jumps to the
  correct card.
- FAQ accordion, nav `aria-current="page"` on the Blog link, and
  heading hierarchy (single H1, one H2 per section) all verified.
- Local static-server pass at mobile (375px), tablet (768px), and
  desktop (1280px).
- Zero console errors, zero failed network requests, zero inline
  styles.

### Sprint 4 — Resources page — 2026-07-04

`resources/index.html`, serving `/resources/` — the destination the
resource-card links on Home have pointed to since Phase 5.1. Built as
a filterable/searchable free-resource library, reusing the design
system throughout; only two genuinely new, generic pieces were added.

**Added**
- `resources/index.html` — hero (with a "Browse resources" anchor
  action), a Featured Free Resource spotlight, a searchable/filterable
  "Templates & checklists" grid (5 resources), a "Financial
  calculators" coming-soon section (3 resources), a "Popular
  resources" ranked list, FAQ, newsletter CTA, and the shared footer.
- `js/components/resource-filters.js` — combines category-pill
  filtering with live text search over the same grid in one module
  (deliberately not two separate scripts — see "engineering decision"
  below).
- `js/components/placeholder-action.js` — a **generalized** version of
  Sprint 3's `buy-button.js` pattern: any element with
  `[data-placeholder-action]` gets an honest "not connected yet" note
  on click instead of behaving like a dead link, with the message
  configurable via `[data-message]`. Used here for the resource
  download buttons, since no real files exist yet. `buy-button.js`
  itself was left untouched (still working, still in use on the Book
  Detail page) — consolidating the two is a reasonable follow-up but
  wasn't done here to avoid touching already-shipped Sprint 3 code
  without being asked.
- Two new, genuinely reusable additions to the design system (checked
  the existing system first; everything else on this page reuses
  Sprints 1–3 components as-is):
  - `css/utilities.css`: `.flex-1` (lets a flex child, like the search
    input, fill its row) and `.mx-auto` (centers a max-width block —
    needed once I'd reused `.feature-banner__copy` outside its
    original flex layout; see bug note below).
  - `css/components.css`: `.resource-card--upcoming` (dashed border,
    reduced opacity) for the three "coming soon" calculator cards —
    reusable for any future "not built yet" card, on any page.
- `FAQPage` JSON-LD, matching the visible FAQ content, alongside the
  existing Organization schema. No `ItemList`/`Product` schema added,
  consistent with the Books listing page's precedent of reserving that
  for actual product/detail pages, not listing pages.
- `<lastmod>2026-07-04</lastmod>` added to the existing `/resources/`
  sitemap entry now that the page is real.

**Reused, not duplicated**
- `.filter-bar` / `.filter-pill` (Sprint 2) for the category pills —
  taxonomy here is Budgeting/Saving/Debt/Investing, distinct from
  Books' own categories, same component.
- `.feature-banner__eyebrow` / `__title` / `__copy` (Sprint 1.5/2) for
  the Featured Free Resource's color treatment — reused standalone
  without the `.feature-banner` flex wrapper, since a resource has no
  natural "cover" image the way a book does.
- `.toc` / `.toc__item` (Sprint 3, originally built for a book's table
  of contents) repurposed as the Popular Resources ranked list —
  proof the component is genuinely generic, not book-specific. Its
  entries are real anchor links to the cards above, not a second copy
  of them.
- `.resource-card`, `.badge`, `.grid--3`, `.alert--info` (empty state),
  `.faq`, `.newsletter-band`, `.content-column` — no new one-off page
  styles.
- Nav `aria-current="page"` on the Resources link required **no code
  change** — `nav.js`'s pathname-matching logic (Phase 5.1) already
  handles any page generically. Verified rather than reimplemented.

**Engineering decision: one filter module, not two**
- Initially considered a separate search script alongside category
  filtering (mirroring `book-filters.js` exactly), but category and
  search both need to narrow the *same* grid at the *same* time — two
  independent scripts toggling the same `.hidden` class would fight
  each other (e.g. typing a search term could undo the active
  category). `resource-filters.js` keeps one `activeCategory` state
  and a single `applyFilters()` that checks both conditions together.

**Caught and fixed two bugs before shipping**
- Wrote `style="margin-inline:auto"` inline while reusing
  `.feature-banner__copy` outside its flex context, then caught it
  immediately in the zero-inline-styles check — replaced with the new
  `.mx-auto` utility instead of leaving the inline style in.
- No repeat of Sprint 2/3's `hidden`-attribute-vs-`display` cascade bug:
  `resource-filters.js` toggles the `.hidden` utility class from the
  start, not the native attribute.

**Accessibility**
- Search input has a visible placeholder plus an associated `.sr-only`
  `<label>` (accessible name independent of placeholder text).
- Filter pills remain a `role="group"` labelled by visible text, each
  toggling `aria-pressed`, exactly as established in Sprint 2.
- Empty-state result message uses `aria-live="polite"`.
- Placeholder-action notes use `role="status"`.
- Single H1, one H2 per section, verified via a heading-tag dump
  during testing (see below) — no skipped levels.

**Verified**
- Local static-server pass at mobile (375px), tablet (768px), and true
  desktop (1280px).
- Search alone, category filter alone, and both **combined**
  (Budgeting + "tracker" correctly narrows to just Monthly Expense
  Tracker) — confirmed via direct DOM inspection, not just visually.
- Empty-state message appears only when a combination truly matches
  nothing, and its subscribe link works.
- Every "Popular resources" link jumps to the correct card via its
  anchor id.
- Placeholder-action download note appears correctly and only once
  per click (no duplicate notes on repeated clicks).
- FAQ accordion opens/closes correctly.
- Confirmed `aria-current="page"` is set on the Resources nav link on
  both desktop and the mobile menu.
- Confirmed heading hierarchy (H1 then one H2 per section) via a
  console dump of all headings.
- No console errors, no failed network requests.

### Sprint 3 — Book Detail page — 2026-07-04

First detail page: `books/starting-to-invest-with-gh100/index.html`,
serving `/books/starting-to-invest-with-gh100/` — the destination the
"Get the guide" links on Home and the Books page have pointed to since
Sprint 2. Built as a focused sales/trust page for the one published
book, from existing components wherever one already fit.

**Added**
- `books/starting-to-invest-with-gh100/index.html` — breadcrumb, hero
  (cover/title/subtitle/price/buy button), What You'll Learn, Table of
  Contents, Who This Book Is For, About the Author, an inline
  testimonial, FAQ, Related Books, a financial-education disclaimer,
  newsletter CTA, and the shared footer.
- `js/components/buy-button.js` — the buy button is a temporary
  placeholder (no SkillsPad checkout integration yet). Clicking it
  doesn't behave like a dead link: it reveals an honest "Checkout is
  launching soon — subscribe to know the moment it opens" note next to
  the button, same progressive-enhancement pattern as
  `newsletter-form.js`.
- `css/components.css`: `.toc`/`.toc__item`/`.toc__number`/
  `.toc__title` (chapter list, reusable for any future book) and
  `.check-item`/`.check-item__icon`/`.check-item__text` (icon + body
  copy list rows that need to wrap correctly — see the fix below).
- `Book` (with a nested `Offer`, price GH₵39/GHS, `InStock`),
  `BreadcrumbList`, and `FAQPage` JSON-LD, alongside the existing
  Organization schema — matches the visible breadcrumb and FAQ content
  exactly, per Google's structured-data guidance.
- `/books/starting-to-invest-with-gh100/` added to `sitemap.xml`.

**Reused, not duplicated**
- `.breadcrumbs` — the component Sprint 1.5 documented as "reserved for
  the detail pages that need it" now has its first real use.
- `.hero--split` (previously only demoed in `components.html`) for the
  cover/title/subtitle/price/CTA hero — no new hero variant needed.
- `.book-card__cover`, `.book-card__cover--green`, `.grid--3` for
  Related Books — the exact same pattern as the Books page grid.
- `.testimonial--inline` — used exactly where its own code comment
  says it's meant to go ("used on Book Detail immediately before a
  CTA"), reusing Ama's existing treasury-bills testimonial rather than
  writing a new one, since it's a direct topical match for this book.
- `.faq` (Sprint 2), `.content-column`, `.alert--warning` (disclaimer),
  `.newsletter-band`, the About-teaser `grid--2` + `.aspect-4-5`
  pattern for the author bio — no new one-off page styles anywhere on
  the page.

**Caught and fixed a bug before it shipped**
- The icon + text checklist rows (What You'll Learn, Who This Book Is
  For) initially reused `.cluster`, which sets `flex-wrap: wrap` — on
  narrow viewports this moved the whole text item to a new flex line
  below the icon instead of letting the text wrap next to a
  fixed-position icon. Caught during the mobile visual-verification
  pass. Fixed by adding the `.check-item` component instead of patching
  `.cluster` (which is used too widely elsewhere to safely change its
  behavior).

**Accessibility**
- Breadcrumb is a `<nav aria-label="Breadcrumb">` with the current page
  marked via a plain `aria-current="page"` span, separators hidden from
  assistive tech.
- Single H1 (book title) in the hero; every subsequent section has
  exactly one H2, matching the rest of the site's heading discipline.
- "Who This Book Is For" pairs check/x icons with `aria-hidden="true"`
  and relies on the visible text for meaning, not color/icon shape
  alone.
- Buy button placeholder note uses `role="status"` so screen reader
  users hear it appear without needing to find it manually.

**Verified**
- Local static-server pass at mobile (375px), tablet (768px), and true
  desktop (1280px, wide enough to exercise `.hero--split`'s side-by-side
  layout for the first time with real content — previously only ever
  seen in the `components.html` demo).
- Clicked the buy button (placeholder note appears correctly) and every
  FAQ item (native accordion opens/closes, icon flips from + to −).
- No console errors, no failed network requests.
- Confirmed the two "Get the guide" links pointing here (Home's
  featured banner, the Books page grid) now resolve.

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
  **Resolved as of the Sprint 18/Production Baseline audit:** a
  `.field__error[hidden] { display: none; }` override now exists in
  `components.css` and the error span was verified hidden on page load
  — closing this out, no further action needed.

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
