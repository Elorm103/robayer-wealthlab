# Robayer WealthLab — Website

Phase 5.1 — Foundation. This is the scalable base every future page is
built from. It contains no page content yet (Home, Books, Blog, etc.
come in later Phase 5 sub-phases) — only the architecture, design
tokens, global components, navigation, and accessibility/SEO groundwork
that every page will share.

Built with semantic HTML5, modern CSS (custom properties, `clamp()`,
CSS Grid/Flexbox), and vanilla JavaScript only — no frameworks, no
build step, per the approved Phase 1 technical stack. Deploys directly
to GitHub Pages.

## Folder structure

```
robayer-wealthlab/
├── css/
│   ├── tokens.css        Design tokens — colors, type, spacing, radius, shadow, motion
│   ├── base.css           Reset + element defaults + accessibility foundation
│   ├── layout.css         Container, grid system, section rhythm
│   ├── components.css     Header, nav, footer, buttons, cards, forms, testimonials
│   └── utilities.css      Small single-purpose helper classes
├── js/
│   ├── includes.js        Loads header/footer partials into every page
│   ├── main.js             Site-wide behavior (footer year, etc.)
│   └── components/
│       └── nav.js         Mobile menu toggle, active-link detection
├── partials/
│   ├── header.html         Shared site header + navigation
│   └── footer.html         Shared site footer
├── templates/
│   └── page-template.html Master template every real page is built from
├── assets/
│   ├── images/logo/        Final logo artwork goes here (see its README)
│   ├── icons/               Favicon files go here (see its README)
│   └── fonts/                Reserved for future self-hosted fonts (see its README)
├── robots.txt
├── sitemap.xml
└── README.md               You are here
```

## How the pieces fit together

1. **`tokens.css` is the single source of truth.** Every color, font,
   spacing, radius, shadow, and motion value used anywhere on the site
   is a CSS custom property defined once here, taken directly from the
   approved Phase 2 Brand Identity System. No other file should contain
   a hardcoded hex value, pixel spacing number, or font name.
2. **`base.css`, `layout.css`, `components.css`, `utilities.css`** build
   on top of tokens.css in that order — each file assumes the ones
   before it are already loaded. `templates/page-template.html` links
   them in the correct order.
3. **`partials/header.html` and `partials/footer.html`** are the actual
   markup for the site header and footer, written once. `js/includes.js`
   fetches and injects them into any page that has a
   `<div data-include="/partials/header.html"></div>` (or footer
   equivalent). This means every future page automatically stays in
   sync with navigation and footer changes — update the partial once,
   every page picks it up.
4. **`templates/page-template.html`** is the starting point for every
   real page built in later Phase 5 sub-phases. It already has the SEO
   meta tag placeholders, Open Graph tags, structured data, font
   loading, stylesheet links, the skip link, and the header/footer
   include divs wired up. Building a new page means copying this file
   and filling in `<main id="main-content">`.

## Running locally

The include system uses `fetch()`, which requires the site to be served
over `http://`, not opened directly from disk (`file://`). From the
project root, run any simple static server, for example:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000/templates/page-template.html` to see
the header, footer, and navigation render.

## Accessibility foundation already in place

- Skip-to-content link, first focusable element on every page
- Semantic landmarks (`<header>`, `<nav>`, `<main>`, `<footer>`)
- Visible focus states on every interactive element (`:focus-visible`,
  2px Growth Green outline) — never removed, only refined
- `prefers-reduced-motion` respected globally in `base.css`
- 44×44px minimum touch target on all buttons and form fields
- Mobile menu: proper `aria-expanded`, `aria-controls`, closes on
  Escape and outside click, moves focus into the menu on open

## SEO foundation already in place

- `robots.txt` and `sitemap.xml` at the project root (update
  `robayerwealthlab.com` in both once the final domain is confirmed —
  see the open question below)
- Meta title/description, canonical URL, Open Graph, and Twitter Card
  placeholders in `page-template.html` for every future page to fill in
- Site-wide Organization structured data (JSON-LD) already included;
  add per-page Article/FAQ structured data on content pages as they're
  built, per the Phase 1 PRD SEO requirements
- Clean, human-readable URL structure per the approved Phase 3
  Information Architecture

## Before Phase 5.2 (first real pages)

- [ ] Replace the coded Sika step-mark SVG in `partials/header.html`
      with final production logo artwork once available
      (`assets/images/logo/`)
- [ ] Add real favicon files (`assets/icons/`)
- [ ] Confirm the production domain and update `robots.txt`,
      `sitemap.xml`, and the canonical/Open Graph URLs in
      `page-template.html` accordingly
- [ ] Decide whether to self-host fonts (`assets/fonts/`) instead of
      loading from Google Fonts, per the performance requirements in
      the Phase 1 PRD

## What comes next

Phase 5.2 onward builds individual pages (Home first) using this
foundation exactly as specified in the approved Phase 3 wireframes and
Phase 4 high-fidelity design specification — no new global styles or
components should be introduced ad hoc at the page level; if a page
needs something the foundation doesn't yet provide, that's a signal to
extend `components.css`, not to write a one-off style.
