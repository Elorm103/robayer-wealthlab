# Robayer WealthLab — Ghanaian Design Asset Inventory

**Purpose:** the single reference for every reusable Ghanaian design asset on this platform — what exists, what it means, where it may be used, and its hard restrictions. Companion to `docs/design/ghanaian-design-language.md` (the fuller rationale/philosophy document) and `docs/homepage-ghanaian-redesign-plan.md`/`docs/homepage-ghanaian-redesign-implementation.md` (the homepage work that introduced these assets). Any future designer or developer adding a cultural element to a new page should start here, not by redrawing something from scratch.

## Asset Inventory

| Asset | File | Purpose | Where It May Be Used | Restrictions |
|---|---|---|---|---|
| Gye Nyame | `assets/design/adinkra/gye-nyame.svg` | Supremacy/omnipresence — trust, providence | Hero, Trust/credibility sections | Decorative only. Background watermark, never a foreground graphic. Never as a functional icon. |
| Sankofa | `assets/design/adinkra/sankofa.svg` | "Go back and get it" — learning from the past | Founder/about/story sections, education contexts | Decorative only. Background watermark, never a foreground graphic. Never as a functional icon. |
| Nkyinkyim | `assets/design/adinkra/nkyinkyim.svg` | Life's twists and turns, adaptability, dynamism | Optional accent — hero or general growth/progress framing | Decorative only. Not currently placed on any live page. Requires attribution (CC BY-SA 4.0, © Pablo Busatto — see file header) if used. |
| Kente Ribbon (Primary) | `assets/design/kente/ribbon-primary.svg` | Hero framing — a flowing corner accent | Edge/corner framing of a hero section only | Never as a full-page or full-width background. Never more than one ribbon treatment per page. |
| Kente Ribbon (Secondary) | `assets/design/kente/ribbon-secondary.svg` | Thin section-divider accent | Occasional section transitions (at most once or twice per page) | Never behind body text or inside a content/card area. Not currently placed on any live page. |

**Current live usage** (as of the homepage redesign): Gye Nyame in the Trust section, Sankofa in the Meet the Founder section, Kente Ribbon Primary in the hero's top-right corner. Nkyinkyim and Kente Ribbon Secondary are built and available but not yet placed anywhere — see each file's own header comment for guidance on when they'd be appropriate.

**Provenance summary** (full detail in each file's header comment): Gye Nyame and Sankofa are sourced from Wikimedia Commons under CC0 1.0 (public domain, no attribution required). Nkyinkyim is sourced from Wikimedia Commons under CC BY-SA 4.0 (attribution required, and this project's adapted copy is itself CC BY-SA 4.0 as a derivative work). Both Kente ribbons are original designs for this project — inspired by Kente cloth's flowing, interwoven quality, not a reproduction of a specific traditional pattern, so no external license applies to them.

**How to use these assets:** this project has no build step, so every SVG (these included) must be embedded inline in a page's HTML — copy the markup directly from the canonical file, do not reference it via `<img src>`, since `currentColor` theming only works when the SVG is actually in the DOM. Apply the existing shared CSS classes (`.adinkra-motif`, `.kente-ribbon`, and their modifiers — defined in `css/components.css`) rather than writing new per-page styles.

## Approved Colours

Every asset uses colours already in the approved brand palette (`css/tokens.css`) — no asset-specific colours exist, and none should be introduced without updating this document deliberately.

| Token | Value | Used by |
|---|---|---|
| `--color-growth-green` | `#1F5C4E` | Kente ribbons (green stripe) |
| `--color-sika-gold` | `#D4A017` | Kente ribbons (gold stripe) |
| `--color-kente-red` | `#B33A3A` | Kente ribbons (red stripe) |
| `--color-ink-navy` | `#16233D` | Adinkra motifs (Gye Nyame, Sankofa, Nkyinkyim) |

Do not introduce a new colour for a future asset unless no existing token — including an `rgba()`/`color-mix()` derivation of one — can express the need. See `docs/design/ghanaian-design-language.md`'s "Colour Usage" for the full reasoning.

## Approved Opacity Ranges

| Asset type | Opacity | Why |
|---|---|---|
| Adinkra motifs (background watermarks) | **6%** (`opacity: 0.06`) | "Discovered rather than shouted" — registers as atmosphere on a casual scroll, not a conscious graphic. Acceptable range: 5–8%, per the design language document; 6% is what's currently live. |
| Kente ribbon stripes | **14–22%** (`0.14`–`0.22` per stripe, varied slightly so the three interwoven colours read as distinct rather than blending into one tone) | A framing accent needs to be visible enough to register as an intentional design element, but must stay clearly secondary to the hero's actual content. |

Never raise either range for a "more visible" effect — if an asset isn't reading as intended, the fix is size or placement, not opacity. Never use full (100%) opacity for either asset type; that is reserved for functional UI icons, which these are not.

## Approved Animation Behaviour

| Asset | Animation | Duration | Character |
|---|---|---|---|
| Kente ribbons | `stroke-dashoffset` flow along each stripe path | 22s, linear, infinite | A slow, continuous "flowing" motion — no easing curve, since a flow shouldn't visibly speed up or slow down |
| Adinkra motifs | Small-amplitude vertical drift (`translateY`, ±6px) | 24s, `ease-in-out`, infinite | Barely perceptible ambient movement — "alive" without being distracting |

Both durations sit in the same slow register as the pre-existing hero shape drift (`hero-shape-drift`, 12s baseline) that predates this asset system — new ambient motion should always err slower rather than faster, never below ~12s for a decorative loop. Hover/entrance motion (unrelated to these specific assets) follows separate rules in `docs/design/ghanaian-design-language.md`'s "Motion Principles."

**Reduced motion:** every animation listed above is automatically disabled by the site's existing global `@media (prefers-reduced-motion: reduce)` rule in `css/base.css`, which zeroes all animation/transition durations sitewide via `!important` on the universal selector. No asset-specific reduced-motion code exists or is needed — this is a structural guarantee, not a per-component opt-in.

## Responsive Behaviour

Both asset types scale via CSS `clamp()`, not fixed pixel sizes or breakpoint-specific overrides:

| Asset | Desktop | Mobile floor |
|---|---|---|
| Kente Ribbon (Primary) | `clamp(140px, 20vw, 300px)` | `clamp(90px, 32vw, 150px)` below 767px |
| Adinkra motifs | `clamp(140px, 18vw, 220px)` at every breakpoint (already scales smoothly via `vw`) |

Both are `position: absolute` with `pointer-events: none`, removed from normal document flow — they cannot cause layout shift (CLS) at any viewport width by construction, confirmed live at 375px/768px/1440px during verification (no horizontal scroll introduced at any of the three). Any section carrying an Adinkra watermark needs `position: relative; overflow: hidden` (the shared `.section--motif` class) so the motif's slight off-corner bleed clips cleanly rather than causing overflow.

## Accessibility Considerations

- Every asset instance carries `aria-hidden="true"` — none are announced to screen readers, matching how every other purely decorative element on this site (the pre-existing hero shapes, every functional icon) is already marked up.
- `pointer-events: none` on every asset — none are focusable, clickable, or reachable by keyboard, and none can intercept a click intended for real content beneath or beside them.
- None of these assets carry any text, so there is no contrast requirement in the WCAG sense (decorative-only graphics at low opacity are exempt) — but the underlying colour (`--color-ink-navy` for Adinkra motifs) was chosen because it's already a proven, high-contrast text colour elsewhere on the site, so it never reads as visually "off" against the light backgrounds it sits on.
- No asset changes heading structure, landmark regions, form labelling, or focus order on any page it appears on — confirmed during the homepage redesign's verification pass, where the only elements added to the DOM were these `aria-hidden` decorative graphics.
- Background contrast (text against the page's own background colour, unrelated to these assets) is covered separately in `docs/homepage-ghanaian-redesign-implementation.md`'s contrast table — all pairs pass WCAG AA with wide margin.
