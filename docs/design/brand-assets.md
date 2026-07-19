# Robayer WealthLab — Ghanaian Design Asset Inventory

**Purpose:** the single reference for every reusable Ghanaian design asset on this platform — what exists, what it means, where it may be used, and its hard restrictions. Companion to `docs/design/ghanaian-design-language.md` (the fuller rationale/philosophy document) and `docs/homepage-ghanaian-redesign-plan.md`/`docs/homepage-ghanaian-redesign-implementation.md` (the homepage work that introduced these assets). Any future designer or developer adding a cultural element to a new page should start here, not by redrawing something from scratch.

## Asset Inventory

| Asset | File | Purpose | Where It May Be Used | Restrictions |
|---|---|---|---|---|
| Gye Nyame | `assets/design/adinkra/gye-nyame.svg` | Supremacy/omnipresence — trust, providence | Hero, Trust/credibility sections | Decorative only. Background watermark, never a foreground graphic. Never as a functional icon. |
| Sankofa | `assets/design/adinkra/sankofa.svg` | "Go back and get it" — learning from the past | Founder/about/story sections, education contexts | Decorative only. Background watermark, never a foreground graphic. Never as a functional icon. |
| Nkyinkyim | `assets/design/adinkra/nkyinkyim.svg` | Life's twists and turns, adaptability, dynamism | **Hero anchor illustration** (homepage) — this is now its one approved placement | Decorative only. This is the sole "anchor tier" use of a named Adinkra symbol; do not duplicate it elsewhere. Requires attribution (CC BY-SA 4.0, © Pablo Busatto — see file header). |
| Kente Ribbon (Primary) | `assets/design/kente/ribbon-primary.svg` | Hero framing — a flowing corner accent | Edge/corner framing of a hero section only | Never as a full-page or full-width background. Never more than one ribbon treatment per page. |
| Kente Ribbon (Secondary) | `assets/design/kente/ribbon-secondary.svg` | Thin section-divider accent | Occasional section transitions (at most once or twice per page) | Never behind body text or inside a content/card area. Not currently placed on any live page. |

**Current live usage** (as of the mobile refinement pass): Gye Nyame in the Trust section, Sankofa in the Meet the Founder section (both "watermark tier" — see Approved Opacity Ranges below, both with a mobile-specific size/offset override so their corner-bleed stays deliberate on narrow viewports), Nkyinkyim as the hero's large "anchor tier" illustration (homepage, right column on desktop, leading the composition on mobile), Kente Ribbon Primary in the hero's top-right corner — filled gradient bands plus a set of small rotated "weft" rects crossing them for woven-fabric character. Kente Ribbon Secondary is built and available but not yet placed anywhere — see its file header for guidance on when it'd be appropriate.

**Provenance summary** (full detail in each file's header comment): Gye Nyame and Sankofa are sourced from Wikimedia Commons under CC0 1.0 (public domain, no attribution required). Nkyinkyim is sourced from Wikimedia Commons under CC BY-SA 4.0 (attribution required, and this project's adapted copy is itself CC BY-SA 4.0 as a derivative work). Both Kente ribbons are original designs for this project — inspired by Kente cloth's flowing, interwoven quality, not a reproduction of a specific traditional pattern, so no external license applies to them.

**How to use these assets:** this project has no build step, so every SVG (these included) must be embedded inline in a page's HTML — copy the markup directly from the canonical file, do not reference it via `<img src>`, since `currentColor`/gradient theming only works when the SVG is actually in the DOM. Apply the existing shared CSS classes (`.adinkra-motif`, `.kente-ribbon`, `.hero__nkyinkyim`, and their modifiers — defined in `css/components.css`) rather than writing new per-page styles. The hero's Nkyinkyim anchor illustration is a special case: it composites the same canonical polygon geometry twice (a blurred shadow duplicate plus a gradient-filled main shape) inside a larger `<svg>`, using an explicit `fill` on each nested `<svg>` rather than `currentColor` — see `index.html`'s hero markup for the reference pattern before reusing this symbol anywhere else.

## Approved Colours

Every asset uses colours already in the approved brand palette (`css/tokens.css`) — no asset-specific colours exist, and none should be introduced without updating this document deliberately.

| Token | Value | Used by |
|---|---|---|
| `--color-growth-green` | `#1F5C4E` | Kente ribbon (green band), hero financial-context curve |
| `--color-growth-green-dark` | `#1A4F43` | Kente ribbon green band gradient (fold shadow) |
| `--color-sika-gold` | `#D4A017` | Kente ribbon (gold band), Nkyinkyim gradient (light stop) |
| `--color-sika-gold-dark` | `#BF8F14` | Kente ribbon gold band gradient, Nkyinkyim gradient (dark stop) |
| `--color-kente-red` | `#B33A3A` | Kente ribbon (red band) |
| `--color-ink-navy` | `#16233D` | Adinkra motifs (Gye Nyame, Sankofa), Nkyinkyim shadow duplicate, hero abstract accents |

The Kente ribbon's red band gradient uses `color-mix(in srgb, var(--color-kente-red) 78%, black)` for its darker stop, since no `--color-kente-red-dark` token exists — a derivation of an existing token, not a new colour. Do not introduce a genuinely new colour for a future asset unless no existing token (including an `rgba()`/`color-mix()` derivation of one) can express the need. See `docs/design/ghanaian-design-language.md`'s "Colour Usage" for the full reasoning.

## Approved Opacity Ranges

Two tiers, per `docs/design/ghanaian-design-language.md`'s anchor/watermark distinction:

| Asset | Tier | Opacity | Why |
|---|---|---|---|
| Gye Nyame, Sankofa (background watermarks) | Watermark | **9%** (`opacity: 0.09`) | Raised from the original 6% during the hero refinement pass, per direct guidance: begin around 8–10%, only go higher if a symbol disappears on very large displays. Still "noticed after a second glance," never "visible before reading the headline." |
| Nkyinkyim (hero anchor illustration) | Anchor | **90%** main shape (`opacity: 0.9`), **16%** blurred shadow duplicate | This is the hero's deliberate focal point, not a watermark — an editorial illustration, not a badge, so it reads as a soft, large shape rather than flat 100% opaque colour. |
| Hero financial-context curve + accent dots | Watermark (hero-only) | **9%** (curve/nodes), **12%** (abstract accent marks) | "The visitor should not consciously notice it" — deliberately static (no motion) to stay pure background texture. |
| Kente ribbon bands | Framing accent | **55%** gold / **40%** green / **32%** red (gradient-filled, `stroke-width: 20`) | Rebuilt from the original thin dashed outline (14–22%) into wider filled fabric-like bands during the hero refinement pass — a wider, softer-edged shape reads correctly richer at this range without overpowering the hero content. |
| Kente ribbon fold shadow | Framing accent | **10%**, blurred | A soft duplicate band beneath the three stripes, giving the ribbon a gentle sense of depth/fold rather than a flat outline. |
| Kente ribbon weft stitches | Framing accent | **60%** | Added during the mobile refinement pass — six small rotated rects crossing the three bands, giving the ribbon woven-fabric character rather than reading as flat parallel bands. Slightly higher than the base bands so they read as threads crossing the warp. |

Never raise the watermark-tier ranges further without confirming a real legibility problem on a large display first — if an asset isn't reading as intended, the fix is usually size or placement, not opacity. The Kente ribbon and Nkyinkyim anchor ranges above already reflect a deliberate, one-time redesign (not an incremental "make it more visible" nudge) — do not incrementally raise them again without an equivalent design review.

## Approved Animation Behaviour

| Asset | Animation | Duration | Character |
|---|---|---|---|
| Kente ribbon bands + weft stitches | Ambient `translate` drift (small amplitude) | 26s, matches `--ease-standard`, infinite | Replaces the original `stroke-dashoffset` flow now that the ribbon is filled bands, not dashed lines — a gentle sway rather than a directional flow. The weft stitches share the exact same animation/timing (no delay) so the whole ribbon moves as one shape. |
| Kente ribbon fold shadow | None (static) | — | The blurred shadow band stays still; only the coloured bands above it drift, so the "fold" reads as fixed depth rather than motion |
| Adinkra motifs (Gye Nyame, Sankofa) | Small-amplitude vertical drift (`translateY`, ±6px) | 24s, `ease-in-out`, infinite | Barely perceptible ambient movement — "alive" without being distracting |
| Nkyinkyim (hero anchor) | Small-amplitude vertical float (`translateY`, ±8px) combined with a very subtle scale "breathe" (1 → 1.015), shadow duplicate moves with it | 22s, matches `--ease-standard`, infinite | Float and breathe are combined into one keyframe (not two competing animations on the same `transform` property) — deliberately slow so it never feels like a spinner or a loading state |
| Hero financial-context curve + nodes | Whole layer: slow independent `translate` drift, ±3px. Nodes only: gentle `scale` pulse (1 → 1.25), staggered per node | Drift: 34s, `ease-in-out`, infinite. Pulse: 10s, `ease-in-out`, infinite, delays 0s/-4s/-8s | Added during the mobile refinement pass for genuine "motion graphics" feel. The drift is a lightweight, pure-CSS stand-in for parallax depth — background (context) and foreground (Nkyinkyim) move at different rates with no JS scroll listener. The staggered node pulse reads as independent signals rather than a synchronized blink. Still extremely subtle — "should not consciously notice it" still holds. |

All decorative motion sits in the same slow register as the site's pre-existing shape-drift precedent — new ambient motion should always err slower rather than faster, never below ~12s for a decorative loop. Hover/entrance motion (unrelated to these specific assets) follows separate rules in `docs/design/ghanaian-design-language.md`'s "Motion Principles."

**Reduced motion:** every animation listed above is automatically disabled by the site's existing global `@media (prefers-reduced-motion: reduce)` rule in `css/base.css`, which zeroes all animation/transition durations sitewide via `!important` on the universal selector. No asset-specific reduced-motion code exists or is needed — this is a structural guarantee, not a per-component opt-in.

## Responsive Behaviour

Both asset types scale via CSS `clamp()`, not fixed pixel sizes or breakpoint-specific overrides:

| Asset | Desktop | Mobile floor |
|---|---|---|
| Kente Ribbon (Primary) | `clamp(140px, 20vw, 300px)` | `clamp(90px, 32vw, 150px)` below 767px |
| Adinkra motifs | `clamp(140px, 18vw, 220px)` | `clamp(90px, 28vw, 150px)` below 767px, plus tighter corner offsets (see below) |

Both are `position: absolute` with `pointer-events: none`, removed from normal document flow — they cannot cause layout shift (CLS) at any viewport width by construction, confirmed live at 375px/768px/1440px during verification (no horizontal scroll introduced at any of the three). Any section carrying an Adinkra watermark needs `position: relative; overflow: hidden` (the shared `.section--motif` class) so the motif's slight off-corner bleed clips cleanly rather than causing overflow.

**Mobile refinement pass, Adinkra motif fix:** the sitewide `clamp()` floor (140px) doesn't shrink further below `18vw`'s crossover point, so on narrow viewports the motif was pinning at a fixed 140px and clipping arbitrarily against `.section--motif`'s `overflow: hidden` edge — an accidental crop, not a deliberate one. Below 767px, `.adinkra-motif--top-right`'s offset tightens from `top: -8%; right: -6%` to `top: -2%; right: -8%`, and `.adinkra-motif--bottom-left`'s from `bottom: -10%; left: -6%` to `bottom: -4%; left: -8%`, so the corner-bleed reads as intentional (a clean peek off the side edge) rather than a slice through glyph detail.

**Mobile refinement pass, hero composition:** below 1199px (the same breakpoint where `.hero--split` already collapses to one column), `.hero__visual` gets `order: -1` — the illustration now leads the hero (visual hook → headline → subtitle → CTAs → founder credit) instead of trailing below the founder signature as an apparently-unrelated block. `order` is visual-only; DOM order (and reading order for assistive tech) is unchanged. The illustration's own mobile `max-width` was also reduced from 260px to 220px so it reads as an accompanying visual rather than a dominant block.

## Accessibility Considerations

- Every asset instance carries `aria-hidden="true"` — none are announced to screen readers, matching how every other purely decorative element on this site (the pre-existing hero shapes, every functional icon) is already marked up.
- `pointer-events: none` on every asset — none are focusable, clickable, or reachable by keyboard, and none can intercept a click intended for real content beneath or beside them.
- None of these assets carry any text, so there is no contrast requirement in the WCAG sense (decorative-only graphics at low opacity are exempt) — but the underlying colour (`--color-ink-navy` for Adinkra motifs) was chosen because it's already a proven, high-contrast text colour elsewhere on the site, so it never reads as visually "off" against the light backgrounds it sits on.
- No asset changes heading structure, landmark regions, form labelling, or focus order on any page it appears on — confirmed during the homepage redesign's verification pass, where the only elements added to the DOM were these `aria-hidden` decorative graphics.
- Background contrast (text against the page's own background colour, unrelated to these assets) is covered separately in `docs/homepage-ghanaian-redesign-implementation.md`'s contrast table — all pairs pass WCAG AA with wide margin.
