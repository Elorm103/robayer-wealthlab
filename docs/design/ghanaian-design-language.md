# Robayer WealthLab — Ghanaian Design Language

**Purpose:** a durable reference so every future page — not just the homepage — introduces Ghanaian identity consistently rather than each page reinventing it. Treat this as an extension of `css/tokens.css`'s existing "Source of truth: Phase 2 Brand Identity System (approved)" discipline, not a separate, competing system. Anyone adding a new page should read this before adding any cultural or decorative element.

**Guiding principle:** trust, pride, and aspiration — communicated through restraint, craft, and premium execution, never through volume of decoration. If a page feels like it's trying to prove it's Ghanaian, the balance is wrong. The goal is recognition, not announcement.

## Asset Library

The single source of truth for every cultural visual asset on this site — reuse these, never hand-approximate a symbol again. All five files are lightweight, hand-optimized SVG (no rasters, no external dependencies):

```
assets/design/
    adinkra/
        gye-nyame.svg      — CC0 1.0 (Wikimedia Commons)
        sankofa.svg        — CC0 1.0 (Wikimedia Commons)
        nkyinkyim.svg      — CC BY-SA 4.0, © Pablo Busatto (attribution required)
    kente/
        ribbon-primary.svg   — original design for this project (hero corner)
        ribbon-secondary.svg — original design for this project (section-divider, not yet placed on any live page)
```

**Provenance, verified before use.** The two CC0 Adinkra files were sourced directly from Wikimedia Commons (`Gye_Nyame_(Adinkra_Symbol).svg` and `Sankofa_bird_symbol.svg`), confirmed CC0-licensed on their respective file description pages, and require no attribution — reproduced here with a source-link comment in each file for traceability regardless. The Nkyinkyim file (`Nkyinkyim.svg`, by Pablo Busatto) is CC BY-SA 4.0: this project's adapted copy is itself licensed CC BY-SA 4.0 as a derivative work, and any page using it must carry the attribution already present in the file's own header comment. Do not replace any of these three with a hand-drawn approximation again — if a symbol needs adjusting, edit the path data in place and note the change in the file's header, keeping the source citation intact.

**How to use these assets — this project has no build step.** Every SVG on this site (icons, these included) is embedded inline in the HTML, not referenced via `<img src>` — `currentColor` theming (so a symbol picks up `color: var(--color-ink-navy)` or a future page's own color) only works when the SVG markup is actually in the DOM, not loaded as an opaque image resource. When adding one of these assets to a page: copy the `<svg>...</svg>` markup from the canonical file directly into that page's HTML (each file's own header comment repeats this instruction), and apply the shared CSS classes already defined in `css/components.css` (`.kente-ribbon`/`.kente-ribbon__stripe--*` for the ribbons, `.adinkra-motif`/`.adinkra-motif--top-right`/`.adinkra-motif--bottom-left` for the symbols) rather than writing new styles per page.

## Colour Usage

Reuse the existing, already-approved token system (`css/tokens.css`) — do not introduce new near-duplicate colour values. The full palette:

| Token | Value | Role |
|---|---|---|
| `--color-growth-green` | `#1F5C4E` | Primary brand colour — CTAs, links, brand accents |
| `--color-ink-navy` | `#16233D` | Dark section bands, heading text on light backgrounds |
| `--color-sika-gold` | `#D4A017` | Secondary accent — highlights, `--accent`-tier CTAs |
| `--color-kente-red` | `#B33A3A` | **Reserved cultural accent** — see "Kente Usage" below |
| `--color-warm-paper` | `#FAF6EF` | Secondary/alternating section background (not the default) |
| `--color-white` | `#FFFFFF` | Default page background, card surfaces |

**Do not introduce Deep Charcoal, or any other dark tone, as a section background.** Ink Navy is the platform's one deliberately dark colour, chosen over charcoal in an earlier brand pass specifically so the site has a single, consistent dark identity rather than two competing dark tones. Reserve dark sections for genuinely high-contrast moments (a hero band, a featured promo) — not routine content sections, which stay light.

**Deriving lighter/softer tones:** when a subtle glow or low-opacity accent is needed (e.g. behind an Adinkra motif), derive it from an existing token's hex value via `rgba()`/`color-mix()` rather than defining a new named colour — this is already the established pattern (the current hero's decorative gradient blobs are `rgba()` derivations of Growth Green, Sika Gold, and Ink Navy, not separate tokens). A new hex value should only be added to `tokens.css` if no existing colour can express the need at any opacity — this should be rare.

**Never combine saturated red, gold/yellow, and green at full strength in the same element** — that combination reads as the national flag, which this brand deliberately avoids (per the original brand review: "reference Ghana respectfully without making the website resemble the national flag"). Kente Red, Sika Gold, and Growth Green may appear together only as thin, low-opacity interwoven strokes (see Kente Usage) — never as three solid blocks of colour.

## Kente Usage

**Kente Red (`#B33A3A`) is now approved for controlled accent use** — previously a reserved, unused token, now given a specific job: framing, not filling.

**Approved uses:**
- A slender flowing ribbon or folded-fabric accent at the **edge or corner** of a hero section — entering from one side, never crossing the content column.
- A thin section-divider stroke, used sparingly (at most once or twice per page).
- Interwoven with Growth Green and Sika Gold as fine parallel stripes within a ribbon shape, each at reduced opacity.

**Never:**
- A full-width or full-page Kente background or pattern fill.
- Kente motifs behind body text or inside a card/content area where they could reduce readability.
- More than one ribbon treatment per page — it's a signature accent, not a repeating background texture.
- Literal, high-fidelity woven-pattern rendering — an elegant, simplified vector interpretation (flowing curve + thin stripes) is correct; anything resembling actual cloth photography or a busy geometric weave is not.

**Technical form:** inline SVG (matching the site's existing icon convention), `aria-hidden="true"`, `pointer-events:none`, positioned `absolute` within a `position:relative` container so it never affects document flow or layout. Canonical source: `assets/design/kente/ribbon-primary.svg` (the corner-framing form, currently live in the homepage hero) and `ribbon-secondary.svg` (a thinner single-line variant for a future section-divider placement — not yet used anywhere). Both are original designs for this project — Kente cloth's flowing, interwoven quality as inspiration, not a literal traditional pattern reproduction, so no external reference/licensing applies to these two files the way it does to the Adinkra symbols below.

## Approved Adinkra Symbols

Three symbols only, each chosen for a specific thematic fit — not a general-purpose decorative set. Adding a fourth symbol to a future page should be a deliberate decision, not a default.

| Symbol | Meaning | Where it belongs |
|---|---|---|
| **Gye Nyame** | Supremacy and omnipresence — commonly read as a symbol of trust and providence | Trust/credibility sections, sections establishing the platform's reliability |
| **Sankofa** | "Go back and get it" — learning from the past to move forward | Founder/about/story sections, anywhere personal history informs present guidance |
| **Nkyinkyim** (optional) | Dynamism, versatility, growth through life's twists | Hero sections, general growth/progress framing |

**Visual treatment — always:**
- **Accurate, filled traditional silhouettes** — sourced from verified references (see Asset Library above), not hand-drawn approximations. This is a deliberate departure from the site's stroke-only UI icon convention: a traditional Adinkra symbol is authentically a solid stamped/carved form, not a line drawing, and getting the actual symbol right matters more here than matching the icon system's line-art style. `fill:currentColor` (each canonical file sets this), no stroke.
- **Very low opacity** (5–8%), used as a background watermark, never a foreground graphic — the low opacity is what keeps a filled shape from reading as a "festival poster" graphic despite being solid rather than outlined.
- Large scale (150–260px) but positioned in section corners/margins, `aria-hidden="true"`, `pointer-events:none`, `z-index` beneath the content, never overlapping a heading or paragraph.
- "Discovered rather than shouted" — a visitor scrolling normally should register it as texture/atmosphere, not consciously notice a symbol until they look closely.

**Do not:**
- Recreate a symbol from memory or approximation, ever — always start from the canonical file in `assets/design/adinkra/`. If a symbol isn't in that folder yet, source an accurately-licensed reference (Wikimedia Commons' CC0/CC-BY-SA Adinkra collections are a good starting point) before adding it, following the same verification this document's own three symbols went through.
- Use a symbol decoratively without regard to its meaning — each placement should make thematic sense per the table above.
- Introduce additional Adinkra symbols beyond these three without a specific, considered reason (this document should be updated deliberately, not casually extended).
- Render symbols at high opacity or with drop shadows — that tips into "festival poster" territory, which this brand explicitly avoids, even though the underlying form is filled rather than outlined.
- Use Adinkra symbols as functional icons (nav, buttons, status indicators) — they are atmospheric, not UI elements. UI iconography stays in the existing Feather/Lucide-style line-icon system (see Iconography Rules below); the filled/traditional treatment above is exclusive to Adinkra motifs and should never bleed into the functional icon set.

**A note for Version 3 and beyond:** the founder has expressed interest in eventually commissioning or creating a fully custom illustration set — accurate to authentic Adinkra forms, but with a stroke weight, spacing, corner radii, and animation language unique to Robayer WealthLab (the way Stripe, Notion, and Linear each have an instantly-recognizable illustration system). The three files in this library are the accurate reference baseline that any future custom system should still be checked against for symbolic correctness, even once the surrounding visual style becomes fully bespoke.

## Motion Principles

Calm and premium, never playful or attention-seeking. Every animation should feel like something a visitor notices only in retrospect ("that felt nice") rather than something that pulls focus while it happens.

- **Entrance:** fade + slight upward slide on first scroll into view (the existing `[data-reveal]` system) — apply consistently across all sections of a page, not selectively.
- **Ambient/decorative:** slow (18–24 seconds per cycle), small-amplitude (a few pixels of drift, or a slow stroke-offset flow) — matching the existing hero shape drift's character (`hero-shape-drift`, 12s, ±16px is the current baseline; new ambient motion should sit in the same register, erring slower rather than faster).
- **Hover:** refined, not snappy — use the existing `--duration-base`/`--duration-slow` tokens, never `--duration-fast` for anything that should feel premium; pair a small lift (`translateY`) with a shadow-tier increase (`--shadow-1` → `--shadow-2`/`--shadow-3`), and an optional very subtle scale (1.01–1.02), never larger.
- **Parallax**, if used: subtle scroll-linked transform only, CSS-driven where possible; must not be the first motion a visitor experiences (reserve for secondary, already-established elements like background Adinkra watermarks, not primary content).
- **Never:** bounce/spring easing, rotation for emphasis, rapid repeated pulsing, autoplay video, or any animation whose primary purpose is to grab attention rather than add polish.
- **Reduced motion:** every animation must be covered by the site's global `@media (prefers-reduced-motion: reduce)` rule (`base.css`), which already zeroes all animation/transition durations sitewide. New motion should rely on this existing mechanism — do not write a second, parallel reduced-motion check unless a specific animation (e.g. a JS-driven parallax) falls outside what the CSS-only global rule can catch, in which case mirror the same `matchMedia('(prefers-reduced-motion: reduce)')` check already used in `scroll-reveal.js`.

## Spacing Philosophy

Generosity signals confidence. A cramped layout undermines the "premium" read faster than any colour or motion choice.

- Use the existing 8px-base spacing scale (`--space-1` through `--space-9`) — do not introduce new spacing values.
- When a section feels tight, reach for the next step up in the existing scale before adding any new visual element. More whitespace is the default fix for "this section feels flat," not more decoration.
- Maintain generous separation between a decorative element (Kente ribbon, Adinkra watermark) and the nearest text — decoration should never feel like it's competing for the same visual space as content.
- Prefer wider vertical rhythm between major sections over horizontal crowding within them; the container/grid system already caps content width (`--container-max: 1200px`) — don't fight it by cramming more into a row.

## Illustration Style

No custom illustration exists sitewide today — every "cover" placeholder is a flat CSS colour block, and this is a legitimate, working style choice, not a placeholder to be embarrassed about. If custom illustration is ever introduced:

- Flat, geometric, minimal — consistent with the line-icon system's restraint, not painterly or textured.
- Any Ghanaian visual reference within an illustration (map outline, geometric pattern inspired by Kente's structure rather than its literal weave) should follow the same restraint rules as Kente/Adinkra above: subtle, low-opacity, never the dominant element.
- Avoid literal tourism iconography (drums, masks, sunsets, wildlife) — this brand's Ghanaian identity is about the content and the person delivering it (real financial context: treasury bills, mobile money, the GSE), not visual signifiers borrowed from tourism marketing.

## Photography Style

- The one photographic subject on the site today is the founder (`founder-portrait.jpg`) — natural, unposed-feeling, warm but professional. This is the template for any future photography: real people in this platform's actual context, not stock imagery.
- No stock photography of generic "African" or "Ghanaian" scenes — if a page needs a photograph and no real, specific photograph exists yet, prefer no photograph (as most sections on the site already do) over a generic placeholder image.
- Any future photography should be lazy-loaded (`loading="lazy" decoding="async"`) and sized appropriately — matching the existing founder portrait's implementation.

## Iconography Rules

- All functional/UI icons stay in the existing inline-SVG, Feather/Lucide-style line convention: `stroke:currentColor; fill:none; stroke-width:1.75`, no icon font, no external library, no sprite sheet.
- Cultural motifs (Adinkra) are visually distinct from this system by design — low opacity, large scale, background placement — so they are never mistaken for a functional icon or interactive element.
- Never mix a literal Adinkra symbol into a functional icon slot (e.g. as a button icon or nav icon) — that would confuse a decorative/cultural element with an interactive one, and risks trivializing the symbol's meaning by treating it as clip art.

## When Adding a New Page

1. Start from the existing token system — do not introduce new colours unless truly nothing existing (including an `rgba()` derivation) can express the need.
2. Decide deliberately whether this page needs a Kente or Adinkra treatment at all — most pages won't, and that's correct. The homepage hero and one or two thematically-apt sections are the primary canvas; a page like `/calculators/` or `/admin/` (which has its own separate design system entirely) has no reason to carry cultural motifs.
3. If a cultural element is warranted, pick from the three approved Adinkra symbols by thematic fit (see table above), not by preference or novelty.
4. Reuse the `.kente-ribbon`/`.adinkra-motif` components introduced in the homepage redesign rather than building new ones — see `docs/homepage-ghanaian-redesign-plan.md` for their exact implementation.
5. Apply the same motion, spacing, and accessibility rules described above without exception — consistency across pages is the entire point of this document.
