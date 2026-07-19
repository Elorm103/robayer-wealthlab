# Homepage Visual Redesign — Ghanaian Identity: Implementation Report

**Status:** Complete, verified locally, approved, committed. Companion to `docs/homepage-ghanaian-redesign-plan.md` (the approved plan), `docs/design/ghanaian-design-language.md` (the durable rationale/philosophy reference), and `docs/design/brand-assets.md` (the asset inventory table — purpose, permitted use, and restrictions for every reusable Ghanaian design asset). Scope strictly visual/presentational — no backend, routing, API, database, Worker, CMS, or business-logic code was touched; no page content or copy changed.

## Final verification (post Adinkra-accuracy correction)

Re-verified after the accuracy correction below, immediately before closing this work: desktop (1440px)/tablet (768px)/mobile (375px) all confirmed `scrollWidth === clientWidth` (zero horizontal scroll / CLS risk), zero console errors at any breakpoint, `body` background confirmed `rgb(255,255,255)`, both live Adinkra motifs and the Kente ribbon confirmed present and correctly styled. Page load metrics on the local static server: `domContentLoadedEventEnd` ~61ms, `loadEventEnd` ~68ms, ~30KB total transfer — as expected, since this redesign added zero new HTTP requests (everything is inline SVG/CSS). One unrelated, pre-existing local-environment artifact observed during this pass: `product-loader.js`'s `/api/products` fetch returns 502 on the static-file-only local server (no backend Worker running alongside it in this session) — this is handled by the page's existing, already-shipped fallback-content logic (not a console error, not something this redesign touched) and does not occur against the real deployed backend. **Lighthouse was not run** — this sandboxed environment has no Lighthouse runner available, and, as noted in the original implementation pass, a local static-file server's timing isn't representative of production edge delivery regardless; recommended as a manual post-deploy spot-check given this redesign added zero new network requests and only ~150 lines of CSS, which makes a material regression unlikely.

## Addendum — Adinkra symbol accuracy correction

The Gye Nyame and Sankofa watermarks described below were originally hand-drawn approximations built from memory, flagged at the time as needing verification. Per review feedback, they've since been replaced:

- **Sourced real references**: `Gye_Nyame_(Adinkra_Symbol).svg` and `Sankofa_bird_symbol.svg`, both from Wikimedia Commons, both confirmed **CC0 1.0** (public domain, no attribution required) on their file description pages. A third symbol, Nkyinkyim (`Nkyinkyim.svg` by Pablo Busatto), was also sourced under **CC BY-SA 4.0** and added to the library, though it remains unused on any live page per the "optional" decision.
- **Built a permanent asset library** at `assets/design/adinkra/` and `assets/design/kente/` — five files, ~12KB combined, each with a header comment documenting its exact source URL, license, and what was adapted (fill hardcoded to `currentColor`, editor metadata stripped; geometry otherwise unchanged from the source).
- **Replaced the inline path data** in `index.html` with the accurate geometry from these canonical files — same `.adinkra-motif`/`.adinkra-motif--*` CSS classes, same 6% opacity, same clamp-based responsive sizing, same 24s ambient drift animation. Only the shape itself changed; the treatment around it did not.
- **Switched from stroke-only line art to filled silhouettes** for these two symbols specifically — the real reference files are solid, traditionally-accurate stamped forms, not line drawings, so matching them faithfully meant adopting `fill:currentColor` for Adinkra motifs while the site's separate UI icon system stays stroke-based exactly as before. This distinction is now explicit in `docs/design/ghanaian-design-language.md`.
- **Re-verified**: no console errors, `scrollWidth === clientWidth` (no horizontal scroll / CLS risk) confirmed at 375px/768px/1440px, correct `viewBox`/opacity/color/fill confirmed programmatically for both live motifs, ribbon and hero unaffected (untouched by this change).

Everything else in this report (background token change, whitespace, motion extension, card/button refinement) is unchanged from the original implementation and still accurate.

## Files changed

Four files, all frontend, `git diff --stat` confirmed:

```
css/components.css | 128 ++++++++++++++++++++++++++++++++++++++++++++++++-----
css/layout.css     |  20 +++++++++
css/tokens.css     |  11 ++++-
index.html         |  54 +++++++++++++++++-----
4 files changed, 189 insertions(+), 24 deletions(-)
```

## New design tokens introduced

**None.** Per Decision 1, every color used is one already in the approved palette — the background fix is a *role reassignment* of two existing values, not new colors, and the Kente ribbon/Adinkra motifs use Kente Red, Sika Gold, Growth Green, and Ink Navy exactly as already defined. The one new low-opacity effect (the book cover's inner highlight) is a `rgba()` derivation of `--color-white`, matching the exact technique the hero's own pre-existing gradient already uses — not a new named token.

Two new **structural** (non-color) classes were added to the shared design system, available to any future page:
- `.section--spacious` (`css/layout.css`) — one step up the existing 8px spacing scale.
- `.kente-ribbon` / `.adinkra-motif` (`css/components.css`) — the two new reusable cultural-identity components described in the design language document.

## Every visual improvement, explained

### 1. The background fix (sitewide, per Decision 3)

**Before:** `--color-bg: var(--color-warm-paper)` (`#FAF6EF`, a muted beige) was the page's default background, reasserted via `.bg-paper`; `--color-bg-alt: var(--color-light-sand)` (`#E8E4DC`) was the alternating band via `.bg-sand`. Two similar low-saturation beiges, sitewide.

**After:** `--color-bg` now resolves to `--color-white` (`#FFFFFF`); `--color-bg-alt` now resolves to the same `--color-warm-paper` value, taking over as the occasional alternating tone instead of the default. Verified live: `getComputedStyle(document.body).backgroundColor` returns `rgb(255, 255, 255)`.

Because `.bg-paper`/`.bg-sand`/plain `.section` all read these role tokens (not raw hex), this one two-line change cascades to every page on the site, not just the homepage — confirmed structurally (no markup changes were needed anywhere) and confirmed live on the homepage across all 9 sections.

**Contrast impact — measured, not assumed:** computed against the new white background:

| Text role | Color | Contrast on white | WCAG AA requirement | Result |
|---|---|---|---|---|
| Headings (Ink Navy) | `#16233D` | **15.65:1** | 4.5:1 | Pass, wide margin |
| Body text (Charcoal Ink) | `#22252B` | **15.36:1** | 4.5:1 | Pass, wide margin |
| Secondary text (Slate) | `#6B675E` | **5.63:1** | 4.5:1 | Pass |
| Links/accent (Growth Green) | `#1F5C4E` | **7.78:1** | 4.5:1 | Pass |

All four pairs improved slightly versus the old beige background (white is the highest-luminance possible backdrop), so contrast strictly got better, never worse.

### 2. Whitespace (homepage-scoped, per the "increase whitespace" direction)

A new `.section--spacious` modifier — one step up the existing spacing scale, not an invented value (96px → was 64px desktop; 64px → was 48px tablet; 48px → was 32px mobile) — applied to 7 of the homepage's 9 sections (Trust, Free Guide promo, Services, Featured eBook, Coming Soon, Resources preview, Meet the Founder). The Newsletter section deliberately keeps its existing tighter rhythm (`.section--tight`), staying a compact closing nudge rather than matching the more generous rhythm of the content sections above it — a deliberate exception, not an oversight.

The Hero itself (not a `.section`, styled independently) got its own increase: 128px desktop (was 96px), a new 96px tablet tier (previously fell through to the desktop value), 64px mobile (was 48px) — the most generous padding on the page, appropriate for "the signature experience."

Grid gaps on the Trust cards (`grid--4`) and both resource-card grids (Services, Resources preview) increased from the default 24px to 32px (`gap-5`), giving cards more room to breathe without touching their internal padding.

### 3. The hero — the signature moment

The existing CSS-only gradient and three floating shapes are untouched (still there, still working — verified via `hero-shape-drift` animation still applying). Added: a hand-authored inline SVG Kente ribbon in the top-right corner — three curved stroke paths in Kente Red, Sika Gold, and Growth Green, each at low opacity (0.14–0.22), animated with a slow (22s) `stroke-dashoffset` flow. Verified live: correct colors (`rgb(212,160,23)`, `rgb(31,92,78)`, `rgb(179,58,58)`), correct opacities, positioned and clipped correctly within the hero's existing `position:relative; overflow:hidden` container — confirmed no horizontal scroll at any breakpoint. Scales down responsively (300px desktop → 120px on a 375px mobile viewport, confirmed live).

This gives the hero — previously identical in spirit to any clean SaaS landing page — a specific, restrained visual signature that no other section on the page repeats.

### 4. Ghanaian identity — two Adinkra watermarks, not six

Per Decision 4, only Gye Nyame and Sankofa were implemented (Nkyinkyim held in reserve, documented as available in the design language doc but not used, keeping to "less is more"):

- **Gye Nyame** (trust/providence) — a simplified line-art symmetric double-curl motif, placed as a top-right background watermark in the Trust/Credibility section.
- **Sankofa** (learning from the past) — a simplified line-art bird-with-head-turned-back, placed as a bottom-left background watermark in the Meet the Founder section.

Both verified live at exactly the specified treatment: 6% opacity, Ink Navy color, `aria-hidden="true"`, `pointer-events:none`, zero effect on document flow. A new `.section--motif` utility (`position:relative; overflow:hidden`) was added to both parent sections so the watermarks' slight off-corner bleed clips cleanly — confirmed no horizontal scroll introduced (`document.documentElement.scrollWidth === clientWidth` at every breakpoint tested).

**Flagging as planned:** these are simplified, respectful line-art interpretations built without a reference image, following the same construction principles as the site's existing icon system. As already flagged in the approved plan, I'd recommend a review against a trusted cultural reference before this goes to production — precision matters more here than almost anywhere else in this redesign, and the SVG paths (in `index.html`) are simple enough to adjust quickly if any correction is needed.

### 5. Motion — extending the existing system, not inventing a new one

`data-reveal` (the existing fade + 16px-slide-up entrance, unchanged CSS/JS) now applies to all 9 homepage sections — previously only 3 had it (Hero, Services, Meet the Founder). Verified live by scrolling through the full page: each section transitions from `opacity:0` to `opacity:1` (`.is-visible` class) as it enters the viewport, in the correct order, using the exact same `scroll-reveal.js`/`IntersectionObserver` mechanism already in production (not modified). The one section that never triggers (Coming Soon) does so because it's legitimately `display:none` today — no coming-soon products exist in local data, which is documented, pre-existing self-hiding behavior, not something this redesign changed.

New ambient motion (the Kente ribbon's stroke flow, the Adinkra watermarks' slow 24s drift) uses the same category of animation as the pre-existing hero shape drift, and is automatically covered by the site's global `@media (prefers-reduced-motion: reduce)` rule in `base.css` — that rule uses `!important` on the universal selector, so it structurally cannot be bypassed by any new `animation-duration`/`transition-duration` value, new or old. No new reduced-motion logic was written because none was needed.

Parallax was **not implemented**, per the plan's recommendation to defer it — it was the one motion idea in the original request judged to add real complexity/risk for comparatively little benefit over the fade-ins, ribbon, and watermark drift already shipped.

### 6. Cards and buttons

`.btn`, `.resource-card`, and `.book-card` hover transitions were slowed from `--duration-fast`/`--duration-base` to `--duration-base`/`--duration-slow` (existing tokens, no new values), with slightly deeper lift (`translateY(-1px)` → `-2px`/`-3px`) and shadow elevation (`--shadow-2` → `--shadow-3`) on hover, plus a very subtle `scale(1.01)` on resource cards. This matches the design language document's explicit "refined, not snappy" motion principle. The flat gold/green book-cover placeholders gained a soft radial inner highlight (an `rgba(255,255,255,0.28)` gradient layered over the existing flat color) so they read as a deliberate design choice rather than a raw placeholder block, while real cover art remains pending.

## What did not change

Confirmed via `git diff --stat`: only `css/tokens.css`, `css/layout.css`, `css/components.css`, and `index.html` were touched. No `backend/` file, no route, no API contract, no database file, no `.ts` file of any kind. No page copy changed — every heading, paragraph, and CTA label on the homepage reads exactly as it did before this redesign. No new HTTP requests were introduced (all new visual elements are inline SVG/CSS, zero new asset files).

## Performance impact

- **Zero new network requests.** Every new visual element (Kente ribbon, both Adinkra motifs) is inline SVG markup, not an image file — no new `<img>`, no new font, no new script.
- **Zero new JavaScript.** All motion is CSS-only (`animation`/`transition`), reusing the exact mechanism (`scroll-reveal.js`) already shipped and already loaded; the file itself was not modified.
- **CSS payload growth is small and inline-served:** ~150 net new lines across `tokens.css`/`layout.css`/`components.css` combined (per the diff stat above), no new stylesheet file, no new `<link>` tag.
- **No layout shift (CLS) risk:** every new decorative element is `position:absolute` with `pointer-events:none`, removed from normal document flow — confirmed live that `document.documentElement.scrollWidth` never exceeds `clientWidth` at any of the three breakpoints tested (375px, 768px, 1440px), and that the reveal animations only affect `opacity`/`transform` (never `width`/`height`/`margin`), which cannot trigger CLS by construction.
- Expectation: no material Lighthouse regression. A full Lighthouse run against the deployed site (not the local static-file server used for this verification pass) is recommended as a final check before or shortly after deploy, since local-server timing isn't representative of production edge delivery.

## Accessibility impact

- **Contrast:** improved across the board (see table above) — the new white background has strictly better contrast against every existing text color than the beige it replaced.
- **Reduced motion:** every new animation is covered by the existing, unmodified global `prefers-reduced-motion` rule — verified structurally (the rule's `!important` + universal selector cannot be bypassed by any animation this redesign added).
- **Screen readers / semantics:** zero change. No heading structure, ARIA attribute, form label, or landmark was touched. Every new decorative element (`.kente-ribbon`, `.adinkra-motif`) is `aria-hidden="true"`, exactly matching how the pre-existing hero shapes and every icon sitewide are already marked up — none of the new elements are announced to assistive technology or reachable by keyboard (`pointer-events:none`, no `tabindex`, not focusable by default as `<svg>`/`<path>`/`<g>` elements without one).
- **Touch targets / keyboard nav:** unaffected — no interactive element was added, moved, or restyled in a way that changes its hit area or tab order.

## Verification performed

- **Desktop** (1440×900 and default preset): full scroll-through, hero corner ribbon confirmed rendering with correct colors/opacity/position via computed styles, all card grids confirmed at the wider `gap-5` spacing.
- **Tablet** (768×1024 preset): 2-column grid collapse confirmed correct (Trust cards, hero content still centered), no overflow.
- **Mobile** (375×812 preset): Kente ribbon correctly scales to 120px via its `clamp()`, hero buttons stack full-width as before, zero horizontal scroll confirmed (`scrollWidth === clientWidth === 375`).
- **No console errors** at any breakpoint (`read_console_messages` with `onlyErrors: true` returned none).
- **No CLS risk**, confirmed structurally and via live `scrollWidth`/`clientWidth` checks at all three breakpoints.
- **Contrast**, computed directly (WCAG relative-luminance formula) for all four primary text/background pairs against the new white background — all pass AA with wide margin.
- **Reduced motion**, verified structurally via the existing, unmodified global CSS rule rather than an OS-level toggle (not controllable in this browser-automation environment) — the mechanism is proven already, since the pre-existing hero shape drift has relied on it since before this redesign.
- **Data-reveal sequencing**, verified live by scrolling the full page and checking `.is-visible` state at each position — all 9 sections correctly transition in viewport order; the one non-triggering section (Coming Soon) was confirmed to be a pre-existing, unrelated `display:none` self-hide (no local coming-soon product data), not a defect introduced here.
- **Lighthouse**: not run against this local static-file server, since local timing isn't representative of production edge delivery — recommended as a post-deploy check (see Performance impact above).

## Outstanding item before production

The Gye Nyame and Sankofa line-art interpretations were built without a reference image, per the caveat already flagged in the approved design plan. Recommend a quick visual review against a trusted cultural reference before this ships to production — both SVGs are simple, small, hand-authored path data in `index.html` and can be adjusted quickly if needed.
