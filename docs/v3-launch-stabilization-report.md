# Version 3.0 Launch Stabilization — Final UI Refinements

Final pre-launch stabilization pass. Scope: dark-mode readability, header/logo presence, CMS-driven hero completeness, remaining decorative-symbol removal, real social icons, a full branding/favicon audit, and the footer's dark-mode logo. Grounded in the UI/UX Pro Max skill's accessibility rules throughout — no redesign, no new features, no business-logic changes.

## 1. Branding Audit Report

Audited every surface listed: homepage, header, footer, admin, emails, Open Graph, favicon, manifest, schema.org, browser tabs, search previews, downloadable assets, social sharing.

| Surface | Status found | Action |
|---|---|---|
| Header/footer `<img>` logo | Correct file, too small (24px), footer never updated for dark mode | Enlarged to 40px; fixed the dark-mode update bug (see §2 below) |
| `favicon.svg` | **Legacy** — a coded navy square with 3 gold ascending bars (an old "growth chart" placeholder, not the current logo, and in the old gold hex besides) | Regenerated from the real logo mark |
| `favicon-32.png` | **Legacy** — same 3-bar placeholder, rasterized | Regenerated from the real logo mark |
| `apple-touch-icon.png` | **Legacy** — same 3-bar placeholder | Regenerated from the real logo mark, 180×180, warm-paper background |
| `og:image` (all pages) | Already correct — the real logo lockup + tagline on a cream background | No change needed |
| `twitter:card`/description | Present; no separate `twitter:image` set, correctly falls back to `og:image` per the spec | No change needed |
| Schema.org `Organization.logo` (every page) | Already correct — `assets/branding/logo/logo.png`, verified identical across all 44 pages | No change needed |
| `robots.txt` / `sitemap.xml` | No logo/branding references of any kind | N/A |
| Web App Manifest | **Does not exist in this project** | Not created — adding one would be new PWA-installability functionality, out of scope for a stabilization pass |
| Email templates | No logo image in any template (text-only branding, already correct/intentional — see the CMS branding system's own docs, which explicitly scoped this as "not yet wired") | No change made — adding an image would be a new feature |
| Downloadable assets (eBook/free-guide PDFs) | Already regenerated with current branding in an earlier phase this session | Not touched again |
| `assets/config/site.json` / `assets/icons/README.md` | Stale comments describing the favicon files as "coded placeholders pending a future phase" | Updated to describe the current, real state |

**Known limitation, not fixable from this repo:** browsers and Google's search-result cache both cache favicons independently and can take anywhere from hours to weeks to show the new one, regardless of what's deployed. This is normal, expected behavior — not a sign the fix didn't work.

## 2. Legacy Logo References Removed

1. `assets/icons/favicon.svg` — replaced the coded 3-bar navy/gold "growth chart" icon with the real logo mark (embedded as a base64 raster inside the SVG wrapper — no vector source for the logo exists yet, see `assets/branding/logo/README.md`).
2. `assets/icons/favicon-32.png` — same replacement, 32×32.
3. `assets/icons/apple-touch-icon.png` — same replacement, 180×180 on a warm-paper background (Apple has historically rendered transparent apple-touch-icons with a black fill on older iOS).
4. `js/components/branding.js` — the footer's own `.nav__logo-mark` was never being updated at all (a `document.querySelector` only ever touches the *first* DOM match, and the header's `<img>` comes first) — it silently stayed on the light-mode logo file regardless of theme. Fixed to `querySelectorAll`, updating every logo image on the page.
5. Stale documentation describing the above as placeholders (`assets/config/site.json`, `assets/icons/README.md`) — updated to reflect the real, current state.

Nothing else referenced the old logo — verified by grep across every `.html`/`.ts` file for `og:image`, `"logo"` (JSON-LD), and favicon `<link>` paths; all were already consistent.

## 3. Dark-Mode Accessibility Report

All contrast ratios computed with the WCAG relative-luminance formula, not estimated.

| Element | Before | After | Rule applied |
|---|---|---|---|
| `.badge--success/warning/error/info`, `.alert--*` (Investment Centre's info banner, every topic card's Beginner/Intermediate/Advanced badge) | Light-mode tint background unchanged in dark mode — measured **3.48:1** on the text/background pair, failing AA 4.5:1, and reading as a bright pale rectangle on a near-black page | Dedicated dark-mode tint + text pairs, one per semantic color: success 7.7:1, warning 7.9:1, error 6.0:1, info 6.6:1 — all AA, most AAA | Skill's `color-dark-mode` ("desaturated/lighter tonal variants, not inverted") + `color-accessible-pairs` |
| Form `::placeholder` (newsletter email field, etc.) | Browser default grey `#757575`, theme-invariant — **3.47:1** against a dark input, failing AA (passed by coincidence in light mode at 4.61:1) | `var(--color-text-secondary)` — 7.97:1 on `--color-bg`, 7.02:1 on `--color-surface` | `color-accessible-pairs` |
| Disabled form fields | `background-color: var(--color-light-sand)` — a raw, theme-invariant palette color, so disabled fields stayed light-beige on dark pages | `var(--color-bg-alt)` (theme-aware) | `color-dark-mode` |
| `.blog-card__image` placeholder, `.table` zebra striping | Same raw-palette-color issue (`--color-light-sand`/`--color-warm-paper`/`--color-white` used directly) | Same fix, theme-aware tokens | `color-dark-mode` |
| Logo mark (header + footer) | Solid ink-navy "R" on a transparent background — **1.16:1** against the dark header, effectively invisible | Dedicated `logo-mark-dark.png` (navy pixels recolored to warm cream, green/gold untouched, generated via pixel-level `sharp` processing) | `color-accessible-pairs`, applied to a non-text element per the same contrast principle |
| `--color-accent` (nav hover, links, eyebrows — over 20 call sites) | *(Already fixed in the prior Version 3.0 pass; re-verified still correct here — 8.4:1/7.4:1)* | — | — |

Deliberately **not** flattened to plain white/black: `--color-text-primary` (warm off-white), `--color-text-heading` (pure white, headings only), and `--color-text-secondary` (dimmer grey) remain three distinct tiers, and the new badge/alert treatment reuses that same "quiet chip, bright text" hierarchy rather than making every element maximally bright.

## 4. Screenshots

Before/after pairs captured live from `robayerwealthlab.com` (production, pre-deploy) and the local build (post-implementation), for: Homepage (light), Investment Centre (dark mode — badges/alert), Footer (dark mode — logo/social icons), Mobile Homepage. See the conversation for the actual images; summarized differences:

- **Investment Centre, dark mode:** every badge and the info banner go from bright near-white rectangles to quiet dark chips with bright colored text.
- **Footer, dark mode:** the logo's "R" goes from invisible to fully legible (warm cream); the six social links go from `f`/`ig`/`in`/`yt`/`wa`/`tt` text to real brand SVG icons.
- **Homepage:** logo is visibly larger (24px → 40px); nav gains a "Home" item as the first, first-class entry.
- **Mobile Homepage:** same logo/nav changes, confirmed at 375px.

## 5. Regression Summary

- **Desktop** (homepage, books, investment centre, blog, resources, footer, navigation): all verified, zero console errors, nav breakpoint math recalibrated and re-verified live (10 items + larger logo required widening the header's own max-width from 1360px to 1440px, confirmed with zero overflow at the boundary).
- **Mobile** (header, logo, hero, footer, navigation): verified at 375px — hamburger menu, larger logo, Home nav item, CMS-driven hero all correct.
- **Dark mode** (typography, logo, buttons, cards, footer, investment centre): all verified live, see §3 above.
- **Branding** (favicon, structured data, Open Graph, social preview): see §1. Manifest N/A (doesn't exist).
- **Accessibility**: Lighthouse accessibility **96/100** (unchanged from prior baseline — no regression), `color-contrast` audit **passes cleanly** with the new dark-mode values. The only remaining flagged issue (`link-in-text-block`, the footer copyright link) is a pre-existing, out-of-scope item already tracked separately. The social-icon SVG swap also happened to resolve a previously-flagged `label-content-name-mismatch` on those same links.
- **Performance**: no new assets left unreferenced; the three regenerated favicon files replace the old ones at identical paths (no orphaned old files remain in the repo). `favicon.svg` grew from 331 bytes to ~10.5KB (a real logo instead of three rectangles costs more bytes, but remains negligible against page weight).

## 6. Hero Book — CMS Completeness

The hero's book title was already live-bound (from the prior Version 3.0 pass). This pass completed the remaining fields using the same `[data-feature-*]` mechanism (`js/components/product-loader.js`'s `initFeatureBanners()`, already used identically by the homepage's "Featured eBook" section — no new mechanism invented):

- **Subtitle** — new `[data-feature-subtitle]` hook, filled from the product's real `subtitle` field.
- **Cover** — new `[data-feature-cover-img]`/`[data-feature-placeholder]` pair: shows the product's real uploaded cover image when one exists, otherwise leaves the existing honest typographic placeholder in place (never fabricated artwork) — verified against a real local D1 product record with a cover image assigned, confirmed the swap works and the placeholder correctly stays hidden.
- **CTA** — new small "Get the guide →" link beneath the cover, `[data-feature-cta]`, reusing the exact same price-label logic as the other banner.

Whichever product is flagged `featured: true` and `active` in the admin panel drives all four fields automatically — no code change required to change the flagship book.
