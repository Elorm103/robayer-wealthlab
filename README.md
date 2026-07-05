# Robayer WealthLab — Website

Financial education for ordinary Ghanaians, built as a static site: no
frameworks, no build step, per the approved Phase 1 technical stack.
Deploys directly to GitHub Pages.

**Current status:** `v1.0.1-launch-polish` shipped, and Version 1.1
("Financial Education Platform") is underway — Sprint 1 (Services
Platform), Sprint 2 (Financial Calculators Platform), Sprint 3
(Consultation Platform), Sprint 4 (Financial Goal Planner), and
Sprint 5 (Learning Hub) are complete, followed by a platform-wide
integration audit (footer navigation, CTA wording, and documentation
staleness fixes — see the `v1.1 Platform Audit` CHANGELOG entry) and
Sprint 6 (Ghana Investment Centre); Sprint 7 is next. See
`CHANGELOG.md`'s `v1.1 Sprint 1`/`2`/`3`/`4`/`5`/`6` entries, and the
Version 1.1 PRD / 1.1.1 addendum on file, for the full roadmap. The
site remains
production-ready and deployed to GitHub Pages behind the
`robayerwealthlab.com` custom domain. The foundation (design tokens,
global components, navigation, accessibility/SEO groundwork) shipped in
Phase 5.1, and every real page plus the centralized configuration,
branding, and content-scaffolding layers were built sprint by sprint
since:

| Sprint | Delivered |
|---|---|
| 5.1 | Foundation — tokens, base/layout/components/utilities CSS, header/footer partials, master page template, Home page, dev-only component showcase |
| 1.5 | Cleanup pass — git init, placeholder production assets, inline-style removal, breadcrumbs documented |
| 2 | Books listing page (`/books/`) |
| 3 | Book Detail page (`/books/starting-to-invest-with-gh100/`) |
| 4 | Resources page (`/resources/`) with search + category filtering |
| 5 | Blog listing page (`/blog/`) with search + category filtering |
| 6 | Blog Article template (`/blog/what-are-treasury-bills-in-ghana/`) |
| 6.5 | Architecture refinement — accessibility, JS consolidation, documentation, design-token cleanup |
| 7 | About page (`/about/`) |
| 8 | Contact page (`/contact/`) |
| 9 | Community page (`/community/`) |
| 10 | Newsletter page (`/newsletter/`) |
| 10.5 | Production Readiness Audit (read-only — no code changes) |
| 10.6 | Launch readiness fixes — newsletter form validation-error bug, stale footer label, this table |
| 11 | Privacy Policy page (`/legal/privacy-policy/`) |
| 12 | Terms of Use page (`/legal/terms-of-use/`) |
| 13 | Disclaimer page (`/legal/disclaimer/`) |
| 14 | Site polish — nav scroll-shadow, hero redesign, homepage services section, founder section, contact page upgrade, footer redesign, JSON-LD telephone/address, scroll-reveal, dark mode |
| 15 | Centralized business-info configuration (`assets/config/site.json` + `js/content-inject.js`) |
| 16 | Brand asset & content architecture foundation (`assets/branding/`, `content/` scaffolding) |
| 17 | Real branding integration — real logo and founder portrait replace coded placeholders |
| 18 | Production Readiness Audit — sitewide fixes (see `CHANGELOG.md`), then finalized as the `v1.0.0-production-baseline` tag |
| Launch Polish | Hero copy, portrait framing, button/card micro-interactions, nav active-state a11y fix, `.resource-card` shadow consistency — finalized as the `v1.0.1-launch-polish` tag |
| v1.1 Sprint 1 | Services Platform — `/services/` landing page + six service detail pages, `content/services/` JSON, `.service-card` component (see `CHANGELOG.md` for the full breakdown) |
| v1.1 Sprint 2 | Financial Calculators Platform — `/calculators/` landing page + Compound Interest/Savings Goal/Investment Growth calculators, shared `calculator-utils.js` math, `content/calculators/` JSON (see `CHANGELOG.md` for the full breakdown) |
| v1.1 Sprint 3 | Consultation Platform — `/consultation/` request form (manual review, no booking system), 18 existing "Book a Consultation" CTAs repointed from `/contact/` (see `CHANGELOG.md` for the full breakdown) |
| v1.1 Sprint 4 | Financial Goal Planner — `/goal-planner/`, 8 goals, `content/goal-planner/` JSON (site's 2nd live `fetch()` consumer after founder bio), reuses `RobayerCalc.requiredContribution()` — no duplicated formula (see `CHANGELOG.md` for the full breakdown) |
| v1.1 Sprint 5 | Learning Hub — `/learn/`, 5 learning paths + 6 topic sections organizing existing content (zero new CSS/JS), nav breakpoint widened to 1199px for 8 items (see `CHANGELOG.md` for the full breakdown) |
| v1.1 Platform Audit | Integration audit — fixed stale footer nav, 18 inconsistent CTA labels, 2 mismatched homepage links, 3 stale doc sections; no features added (see `CHANGELOG.md` for the full breakdown) |
| v1.1 Sprint 6 | Ghana Investment Centre — `/investment-centre/`, 10 topic pages + 3 learning paths, `content/investment-centre/` JSON (`relatedGoals` — first cross-link into the Goal Planner from reading content), nav holds at 1199px for 9 items (see `CHANGELOG.md` for the full breakdown) |

The three Legal pages, the remaining Blog articles, and the second Book
that were "still to come" in earlier sprints are now resolved: Legal
pages are built (Sprints 11–13); the not-yet-written Blog articles and
book are represented honestly as "Coming soon" cards (see `blog/index.html`,
`books/index.html`) rather than dead links or fabricated content.
`CHANGELOG.md` has the full detail behind every sprint above.

## Folder structure

```
robayer-wealthlab/
├── css/
│   ├── tokens.css        Design tokens — colors, type, spacing, radius, shadow, motion, z-index
│   ├── base.css           Reset + element defaults + accessibility foundation
│   ├── layout.css         Container, grid system, section rhythm
│   ├── components.css     Every reusable component (see components.html for the full catalog)
│   ├── utilities.css      Small single-purpose helper classes
│   └── dev-showcase.css   Dev-only styling for components.html — never linked from a real page
├── js/
│   ├── includes.js        Loads header/footer partials into every page
│   ├── main.js             Site-wide behavior (footer year, etc.)
│   ├── content-inject.js  Populates [data-content]/[data-content-href] elements from assets/config/site.json
│   └── components/
│       ├── nav.js                  Mobile menu toggle, active-link detection, sticky-header scroll shadow
│       ├── theme-toggle.js         Dark/light mode toggle + localStorage persistence
│       ├── scroll-reveal.js        Fades/slides [data-reveal] elements in on scroll (no-ops if prefers-reduced-motion)
│       ├── founder-bio.js          Fetches content/founder/bio.json into [data-founder-bio] elements
│       ├── newsletter-form.js      Client-side validation + confirmation for the newsletter form
│       ├── contact-form.js         Client-side validation + confirmation for the contact form
│       ├── consultation-form.js    Client-side validation + honest "reviewed manually" confirmation for the consultation request form
│       ├── content-filters.js      Generic category-pill + search filtering for any card grid
│       ├── placeholder-action.js   Honest "not connected yet" feedback for buttons with no backend
│       ├── article-reading.js      Reading-progress bar + table-of-contents active-section highlighting
│       ├── calculator-utils.js               Shared pure-math (window.RobayerCalc) — no formula duplication across calculators
│       ├── calculator-compound-interest.js   Compound Interest calculator
│       ├── calculator-savings-goal.js        Savings Goal calculator
│       ├── calculator-investment-growth.js   Investment Growth calculator
│       └── goal-planner.js                   Fetches content/goal-planner/{slug}.json, renders questions, reuses RobayerCalc.requiredContribution()
├── partials/
│   ├── header.html         Shared site header + navigation
│   └── footer.html         Shared site footer
├── templates/
│   └── page-template.html Master template every real page is built from
├── assets/
│   ├── config/site.json    Single source of truth for company/founder/contact/social facts (see Configuration below)
│   ├── branding/            Home for future real logo/founder-portrait/favicon/OG-image files (see its README)
│   ├── images/logo/        Retired — real logo now lives in assets/branding/logo/ (see its README)
│   ├── icons/               Favicons (currently coded placeholders — see its README)
│   └── fonts/                Reserved for future self-hosted fonts (see its README)
├── books/
│   ├── index.html                        Books listing page
│   └── starting-to-invest-with-gh100/    Book Detail page
├── blog/
│   ├── index.html                              Blog listing page
│   └── what-are-treasury-bills-in-ghana/       Blog Article page (canonical template for future articles)
├── resources/
│   └── index.html         Resources page
├── calculators/
│   ├── index.html                 Calculators landing page (3 calculator cards)
│   ├── compound-interest/         Compound Interest calculator page
│   ├── savings-goal/              Savings Goal calculator page
│   └── investment-growth/         Investment Growth calculator page
├── goal-planner/
│   └── index.html         Financial Goal Planner — 8 goals, 3-step progressive flow, all client-side
├── learn/
│   └── index.html         Learning Hub — organizes existing content by topic + learning path (no new content)
├── investment-centre/
│   ├── index.html                          Investment Centre hub — 10-topic grid + 3 learning paths
│   ├── treasury-bills/                     Topic page
│   ├── government-bonds/                   Topic page
│   ├── money-market-funds/                 Topic page
│   ├── mutual-funds/                       Topic page
│   ├── ghana-stock-exchange/                Topic page
│   ├── fixed-deposits/                     Topic page
│   ├── ssnit-and-pension-basics/            Topic page
│   ├── real-estate-investing/               Topic page
│   ├── gold-investing/                     Topic page
│   └── emergency-funds/                    Topic page
├── services/
│   ├── index.html                            Services landing page (6 service cards)
│   ├── financial-education/                  Service detail page
│   ├── investment-education/                 Service detail page
│   ├── personal-financial-coaching/          Service detail page
│   ├── business-financial-advisory/          Service detail page
│   ├── retirement-planning-guidance/         Service detail page
│   └── financial-literacy-workshops/         Service detail page
├── about/
│   └── index.html         About page
├── consultation/
│   └── index.html         Consultation request page (manual review — no booking system)
├── contact/
│   └── index.html         Contact page — general enquiries, media, partnerships (see /consultation/ for consultation requests)
├── community/
│   └── index.html         Community page
├── newsletter/
│   └── index.html         Newsletter page
├── legal/
│   ├── privacy-policy/index.html    Privacy Policy page
│   ├── terms-of-use/index.html      Terms of Use page
│   └── disclaimer/index.html        Disclaimer page
├── content/                 Scaffold for future structured content — see content/README.md and content/SCHEMA.md
├── components.html         Living style guide — every reusable component, shown in every state
├── CNAME                    Custom domain for GitHub Pages (robayerwealthlab.com)
├── robots.txt
├── sitemap.xml
├── CHANGELOG.md            Full sprint-by-sprint history
└── README.md               You are here
```

## Architecture overview

The site is built in four layers, from most to least "finished":

1. **Design system** (`css/tokens.css` → `base.css`/`layout.css`/
   `components.css`/`utilities.css`, `components.html`) — fully built,
   the foundation everything else sits on. See "How the pieces fit
   together" below.
2. **Configuration** (`assets/config/site.json` + `js/content-inject.js`)
   — live and working. Centralizes recurring business facts (company,
   founder, contact, social) so they're edited once instead of across
   every page. See "Configuration architecture" below.
3. **Branding** (`assets/branding/`) — live for the logo and founder
   portrait (real assets, integrated in Sprint 17); favicons remain
   coded placeholders pending a future phase. See "Brand asset
   architecture" below.
4. **Content** (`content/`) — mostly scaffolding, with a few
   exceptions: the founder bio (`content/founder/bio.json`) is real and
   consumed by `index.html`/`about/index.html`, and
   `content/goal-planner/{slug}.json` is real and consumed by
   `/goal-planner/` (Sprint 4). `content/services/` and
   `content/calculators/` are real, complete content with no consumer
   yet. Every other content type remains documentation only. See
   "Content architecture" below.

Layers 2–4 were added specifically so a future local editor or
Git-backed CMS (see "Future roadmap") has clear, documented places to
read from and write to — without requiring that tool (or a person) to
parse or rewrite page HTML directly.

## How the pieces fit together

1. **`tokens.css` is the single source of truth.** Every color, font,
   spacing, radius, shadow, motion, and z-index value used anywhere on
   the site is a CSS custom property defined once here, taken from the
   approved Phase 2 Brand Identity System. No other file should contain
   a hardcoded hex value, pixel spacing number, font name, or raw
   z-index — if you need a new one, add the token here first.
2. **`base.css`, `layout.css`, `components.css`, `utilities.css`** build
   on top of tokens.css in that order — each file assumes the ones
   before it are already loaded. Every real page links them in that
   same order.
3. **`components.html` is the living style guide.** It shows every
   reusable component defined in `components.css` in its default,
   hover, focus, and disabled states. If a page needs something that
   isn't shown there, extend the design system and add it to the guide
   — don't write a one-off style on a page. Keep this file in sync
   whenever a new component is added (Sprint 6.5 caught it drifting out
   of date and brought it current — don't let that happen again).
4. **`partials/header.html` and `partials/footer.html`** are the actual
   markup for the site header and footer, written once. `js/includes.js`
   fetches and injects them into any page that has a
   `<div data-include="/partials/header.html"></div>` (or footer
   equivalent), so every page stays in sync automatically.
5. **`templates/page-template.html`** is the starting point for every
   new page. It has the SEO meta tag placeholders, Open Graph tags,
   Organization structured data, font loading, stylesheet links, the
   skip link, and the header/footer include divs already wired up.
   Building a new page means copying this file, filling in
   `<main id="main-content">`, and adding page-specific structured data
   (Article/FAQPage/BreadcrumbList/Book, as appropriate — see the Blog
   Article page for the fullest example).
6. **`js/components/content-filters.js` and `placeholder-action.js`
   are generic, not page-specific.** Any future page that needs
   category/search filtering over a card grid, or an honest
   "not built yet" click response, should opt in via the documented
   data attributes rather than writing a new script.

## Running locally

The include system uses `fetch()`, which requires the site to be served
over `http://`, not opened directly from disk (`file://`). From the
project root, run any simple static server, for example:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000/` to see the Home page, or
`http://localhost:8000/components.html` for the full style guide.

## Configuration architecture

`assets/config/site.json` is the single source of truth for company,
founder, contact, and social-link facts (company name/tagline, founder
name/title, the three contact emails, phone, location, social hrefs).
`js/content-inject.js` fetches it once per page load and populates any
element marked `[data-content="dot.path"]` (text) or
`[data-content-href="dot.path"]` (href) — currently the shared
header/footer partials, the homepage/about founder byline, and the
Contact page's email cards and direct-details block. The existing text
already in the HTML is the fallback if the fetch ever fails, so editing
`site.json` is the only step needed to update those values everywhere at
once; no page HTML needs touching.

Per-page `<title>`/meta/Open Graph/Twitter/JSON-LD tags are **not**
wired to this file — see `assets/branding/README.md` for why (social
crawlers don't run JavaScript) and what to do when one of those values
needs to change.

## Brand asset architecture

`assets/branding/` is the designated future home for real brand assets
— logo, founder portrait, favicons, Open Graph image, and (once they
exist) book covers, resource thumbnails, and team photos. Each of its
subfolders (`logo/`, `founder/`, `favicons/`, `social/`, `books/`,
`resources/`, `team/`) has its own README covering expected filenames,
dimensions, formats, optimization guidance, and exactly what happens
today if that asset is still a placeholder (nothing breaks — every
current placeholder is a real, working, documented stand-in, never a
missing file). Nothing currently in `assets/icons/` or
`assets/images/` has been moved — seeing a real asset arrive means
dropping it into the matching `assets/branding/` subfolder and
following that subfolder's README for the (small, currently manual)
list of places its path is duplicated.

## Content architecture

`content/` is mostly a **scaffold, not a working feature** — directory
structure and documentation only, covering Company, Founder, Books,
Blog, Resources, Legal, Newsletter, Community, Events, Testimonials,
and FAQ content. `content/SCHEMA.md` documents the recommended JSON
shape for each content type (Book, Blog Article, Resource, Team Member,
Testimonial, FAQ, Newsletter Issue, Community Event), matched to how
that content already looks and behaves on the live site today. One
exception: `content/founder/bio.json` is real, live content, fetched
directly by `js/components/founder-bio.js` — the reference pattern any
future consumer should follow (a small self-contained `fetch()` with
the page's existing hand-written HTML as the fallback), rather than a
shared loader module (an earlier attempt at one, `js/content-loader.js`,
had zero consumers and was removed in the Sprint 18 audit).
`content/goal-planner/{slug}.json` (Version 1.1 Sprint 4) follows the
same pattern as the second live consumer: `js/components/goal-planner.js`
fetches a goal's config on demand — only when a visitor picks that
goal, not all 8 upfront — and renders its question set and
recommendation entirely from that data. `content/services/` and
`content/calculators/` remain real, complete content with no consumer
yet (see their own READMEs for why).

Every other page's real content still lives directly in its own HTML,
unchanged by any of this. This groundwork exists so that migrating a
given page later is a rendering change, not a from-scratch content
architecture decision made under time pressure later.

## Accessibility

- Skip-to-content link, first focusable element on every page
- Semantic landmarks (`<header>`, `<nav>`, `<main>`, `<footer>`)
- Visible focus states on every interactive element (`:focus-visible`,
  2px Growth Green outline) — never removed, only refined
- `prefers-reduced-motion` respected globally in `base.css`
- 44×44px minimum touch target on all buttons and form fields
- Mobile menu: proper `aria-expanded`, `aria-controls`, closes on
  Escape and outside click, moves focus into the menu on open
- Category filter pills use `role="group"` with a visible label and
  `aria-pressed`; empty-filter-result messages use `aria-live="polite"`
- `--color-text-secondary` was audited and corrected in Sprint 6.5 to
  meet WCAG AA contrast (≥4.5:1) against both its Warm Paper and white
  card backgrounds — verify any new secondary-text color choice the
  same way before adding one

## SEO

- `robots.txt` and `sitemap.xml` at the project root, kept in sync with
  every real page as it ships, including `<lastmod>` dates
- Meta title/description, canonical URL, Open Graph, and Twitter Card
  tags on every page
- Site-wide Organization JSON-LD on every page; `FAQPage` JSON-LD on
  every page with an FAQ section; `BreadcrumbList` and `Book`/`Article`
  JSON-LD on detail pages, matching their visible breadcrumb/content
  exactly
- `og:type` is `article` (with `article:published_time` /
  `article:modified_time` / `article:author` / `article:section`) on
  Blog Article pages specifically, `website` everywhere else
- Clean, human-readable URL structure (`/section/slug/`) throughout

## Future roadmap

The configuration/branding/content layers above exist to make a few
specific future capabilities straightforward to add later, without
requiring any of them to be built now:

- **A future local editor** (a small tool run on a contributor's own
  machine, not deployed anywhere) could read and write
  `assets/config/site.json` and the files described in `content/`
  directly — both are plain JSON, readable/writable by any tool or
  script, with no proprietary format or database to integrate with.
- **A future Git-backed CMS** (e.g. a tool that opens a pull request
  containing edited JSON files) has the same starting point — the
  content model in `content/SCHEMA.md` was written to be a reasonable
  target for that kind of tool's data model, not just for hand-editing.
- **A future upload workflow** for brand assets would write into the
  matching `assets/branding/` subfolder using that subfolder's
  documented naming convention (e.g. `assets/branding/books/{slug}.jpg`
  matching a book's URL slug) — predictable enough to automate without
  a person deciding the filename each time.
- **Future automated asset optimization** (running SVGO/`pngquant`/
  similar over anything dropped into `assets/branding/` before it's
  committed) is a natural pre-commit or CI step once there's a real
  asset pipeline worth automating — not needed while every asset in
  that folder is still a documented placeholder.
- **A future build-time sync script** could regenerate the static
  per-page `<title>`/meta/Open Graph/JSON-LD blocks from
  `assets/config/site.json` before deploying, removing the last
  manual-sync step described in `assets/branding/README.md`. This is
  the one piece of the above that would introduce an actual build step
  — everything else keeps working exactly as it does today, with zero
  build step, deployed directly to GitHub Pages.

None of the above is built yet. Nothing about the current architecture
blocks building any of it later.

## Developer onboarding

New to this project? Here's where everything lives:

| Looking for… | Go to |
|---|---|
| Colors, type, spacing, shadows, motion | `css/tokens.css` |
| Reusable UI components (buttons, cards, forms…) | `css/components.css`, demoed live in `components.html` |
| The shared header/footer | `partials/header.html`, `partials/footer.html` |
| The starting point for a new page | `templates/page-template.html` |
| Company/founder/contact/social facts | `assets/config/site.json` |
| Logo, favicon, OG image, founder portrait | `assets/branding/` (see its README first) |
| Future structured content (books, blog, FAQ, etc.) | `content/` (scaffold only — see `content/README.md`) |
| Page-specific behavior (nav, forms, filters, dark mode…) | `js/components/` |
| Site-wide behavior (partial loading, config injection) | `js/includes.js`, `js/content-inject.js`, `js/main.js` |
| Full project history, sprint by sprint | `CHANGELOG.md` |

If you're not sure where something belongs, it's almost always one of
the four layers described in "Architecture overview" above — ask which
layer the thing you're adding belongs to before deciding where the file
goes.

## Open items

- [x] Replace the coded Sika step-mark SVG with real production logo
      artwork — done in Sprint 17 (`assets/branding/logo/`)
- [ ] Replace the coded favicon files with final production artwork
      once available (`assets/icons/`) — currently honest, documented
      placeholders
- [x] Confirm the production domain — `robayerwealthlab.com`, used
      consistently since Phase 5.1
- [ ] Decide whether to self-host fonts (`assets/fonts/`) instead of
      loading from Google Fonts, per the performance requirements in
      the Phase 1 PRD
- [ ] Consider extracting the newsletter-band block (identical across
      all 10 pages as of Sprint 10 — flagged again in the Sprint 10.5
      audit) into a partial once the remaining pages are built and it's
      clear the duplication still matters at that scale
- [ ] Consider a consistent page-level JSON-LD type across About/Books/
      Resources/Blog index (Community, Newsletter, and Contact each
      have one; these four currently only have Organization + FAQPage)
      — flagged in the Sprint 10.5 audit, not yet actioned

## What comes next

All 13 real pages are built and the `v1.0.0-production-baseline` tag
marks the site as deployable as-is. What's left is content and asset
work, not architecture: real favicons, real book covers, and — when
ready — writing the Blog articles and second Book that today are
honestly represented as "Coming soon" cards rather than fabricated or
dead-linked. See "Open items" above and the `Sprint 18 — Production
Readiness Audit` / `v1.0.0-production-baseline` entries in
`CHANGELOG.md` for the complete picture. Building any of the above
continues to use this foundation exactly as-is — no new global styles
or components should be introduced ad hoc at the page level; if a page
needs something the design system doesn't yet provide, that's a signal
to extend `components.css` (and update `components.html`), not to
write a one-off style.
