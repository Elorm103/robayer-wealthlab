# Robayer WealthLab — Website

Financial education for ordinary Ghanaians, built as a static site: no
frameworks, no build step, per the approved Phase 1 technical stack.
Deploys directly to GitHub Pages.

**Current status:** Phase 5 is underway. The foundation (design tokens,
global components, navigation, accessibility/SEO groundwork) shipped in
Phase 5.1, and real pages have been built sprint by sprint since:

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

Still to come: the three Legal pages (Privacy Policy, Terms of Use,
Disclaimer), the remaining Blog articles, and the second Book are
referenced throughout the site (nav, footer, sitemap) but not yet
built — this is expected at this stage, not a bug. `CHANGELOG.md` has
the full detail behind every sprint above.

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
│   └── components/
│       ├── nav.js                  Mobile menu toggle, active-link detection
│       ├── newsletter-form.js      Client-side validation + confirmation for the newsletter form
│       ├── content-filters.js      Generic category-pill + search filtering for any card grid
│       ├── placeholder-action.js   Honest "not connected yet" feedback for buttons with no backend
│       └── article-reading.js      Reading-progress bar + table-of-contents active-section highlighting
├── partials/
│   ├── header.html         Shared site header + navigation
│   └── footer.html         Shared site footer
├── templates/
│   └── page-template.html Master template every real page is built from
├── assets/
│   ├── images/logo/        Logo artwork (currently a coded placeholder — see its README)
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
├── about/
│   └── index.html         About page
├── contact/
│   └── index.html         Contact page
├── community/
│   └── index.html         Community page
├── newsletter/
│   └── index.html         Newsletter page
├── components.html         Living style guide — every reusable component, shown in every state
├── robots.txt
├── sitemap.xml
├── CHANGELOG.md            Full sprint-by-sprint history
└── README.md               You are here
```

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

## Open items

- [ ] Replace the coded Sika step-mark SVG and favicon files with
      final production artwork once available (`assets/images/logo/`,
      `assets/icons/`) — currently honest, documented placeholders
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

The three Legal pages, the remaining Blog articles, and the second
Book are the main content still missing (see the Sprint 10.5 audit in
`CHANGELOG.md` for the full launch-readiness picture — pages already
linked sitewide that don't exist yet are the main gap, not the
architecture). Building any of them continues to use this foundation
exactly as-is — no new global styles or components should be
introduced ad hoc at the page level; if a page needs something the
design system doesn't yet provide, that's a signal to extend
`components.css` (and update `components.html`), not to write a
one-off style.
