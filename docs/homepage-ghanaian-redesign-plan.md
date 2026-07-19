# Homepage Visual Redesign — Ghanaian Identity: Design Plan

**Status: plan only — no code changed.** Per the request, this document is the audit + design review that must be approved before any implementation begins. Scope is strictly visual/presentational: no backend, routing, API, database, Worker, CMS, or business-logic changes anywhere in this plan, and no content/copy changes — every section's existing text stays as-is unless explicitly noted.

## 1. Executive Summary

The homepage's flatness has one root cause, not many: the site's *default background color role* (`--color-bg`) resolves to a muted beige (`#FAF6EF`), and every "plain" section inherits it. This is fixable as a small, surgical token change rather than a rebuild — the CSS architecture here is already disciplined (role-mapped tokens, not raw hex scattered through markup), so most of the brightening effect cascades automatically once the token changes.

The Ghanaian identity work is additive: two new lightweight, hand-authored inline SVG components (a Kente ribbon accent, a small set of line-art Adinkra motifs) layered onto the existing visual system at very low visual weight, plus wider use of the scroll-reveal motion system that already exists but is only applied to 3 of the homepage's 9 sections today.

Nothing about the page's HTML content, section order, or written copy changes. Typography, layout grid, and component structure (cards, buttons, sections) are refined in place, not replaced.

## 2. Current State Audit

**Design tokens (`css/tokens.css`)** — a disciplined, already-approved system (confirmed against `docs/brand-ux-review-v1.md`, which explicitly praised it for having "no invented colors" in production use):
- Primary: Growth Green `#1F5C4E`, Ink Navy `#16233D`
- Accent: Sika Gold `#D4A017`, **Kente Red `#B33A3A` — already exists, already reserved, currently unused anywhere on the site.** The prior brand review's own open item ("decide whether this reserved accent color... carries a color with no defined purpose indefinitely") is still unresolved. This redesign is the natural place to finally give it a job.
- Neutrals: Warm Paper `#FAF6EF`, Light Sand `#E8E4DC`, Stone Grey/Slate (text), Charcoal Ink `#22252B` (body text color), White `#FFFFFF`.
- Everything components actually consume goes through **role tokens**, not raw palette values: `--color-bg`, `--color-bg-alt`, `--color-bg-inverse`, `--color-surface`, `--color-accent`, `--color-highlight`, etc. This is why the fix below is small.

**The "dull background," precisely:**
- `--color-bg: var(--color-warm-paper)` (`#FAF6EF`) is the sitewide default — set once in `base.css` (`body{background-color:var(--color-bg)}`), reasserted per-section via the `.bg-paper` utility (used on the hero).
- `--color-bg-alt: var(--color-light-sand)` (`#E8E4DC`) is the alternating "sand" band, applied via `.bg-sand` (Services, Coming Soon).
- Dark bands (`.bg-navy`, Free Guide promo + Featured eBook) use raw Ink Navy, pinned outside the light/dark-mode token swap by design.
- Result: outside the two navy bands, the entire homepage today alternates between two low-saturation beiges. That's the flatness.

**Typography** — Fraunces (display serif, headings) + Space Grotesk (UI/eyebrow) + Work Sans (body) + IBM Plex Mono (financial figures), loaded from Google Fonts, only the specific weights actually used (500/600 Fraunces, 500 Space Grotesk, 400/500 Work Sans). The prior brand review already audited this pairing and found it clean — "no invented colors... typography sound." I'm not proposing a new font. Adding a "Ghanaian" display typeface would also directly work against the user's own stated anti-goal (tourism-brochure territory) — restraint here *is* the premium choice.

**Motion** — a real, working system already exists: `[data-reveal]` + `js/components/scroll-reveal.js` (`IntersectionObserver`, fades/slides content up 16px on first viewport entry, threshold 0.15) and a CSS-only hero shape drift (`@keyframes hero-shape-drift`, 12s, ±16px). Both are already correctly gated by the site's global `@media (prefers-reduced-motion: reduce)` rule in `base.css`, which zeroes all animation/transition durations sitewide — so any new motion I add inherits this protection automatically, no new reduced-motion logic needed. Only 3 of the homepage's 9 sections currently use `data-reveal` (Hero, Services, Meet the Founder) — the rest render with no entrance animation at all.

**Cards & existing components** — `.resource-card` (icon/title/description, used 9× across Services + Resources preview), `.book-card` (rendered dynamically by `product-loader.js`), `.feature-banner` (the promo-band pattern used twice), `.newsletter-band`. A `.testimonial` component **already exists in `components.css` with full CSS (avatar/quote/attribution) but no homepage section uses it** — there are no testimonials on the homepage today. See Open Question 5 below; I can't invent testimonial content given this project's explicit no-unverifiable-claims discipline (`docs/brand-ux-review-v1.md`'s trust-signal audit).

**Icons** — every icon sitewide is hand-authored inline SVG in a consistent Feather/Lucide-style line convention (`stroke:currentColor; fill:none; stroke-width:1.75`), no icon font or external library. New Adinkra/Kente assets should follow this exact convention to look native rather than pasted-in.

**Performance baseline** — genuinely light today: zero background images on the homepage (all "cover" placeholders are flat CSS color blocks), two lazy-loaded JPGs (one file, 46KB, used twice), no build step/bundler, no JS animation libraries anywhere in the codebase. This is a good baseline to preserve, not a gap to fix.

## 3. Color Palette — Reconciliation, Not Replacement

The request's proposed hex values are each *very close* to an existing, already-approved token — close enough that introducing them as new, separate values would create near-duplicate colors sitting a few percent apart, which would quietly undermine the "no invented colors" discipline the last brand review specifically praised. My recommendation is to express the same intent through the existing tokens wherever they already match, and add genuinely new tokens only where a real gap exists.

| Requested | Closest existing token | Recommendation |
|---|---|---|
| Primary Green `#0F5C4D` | `--color-growth-green: #1F5C4E` | **Keep the existing token unchanged.** Already brand-approved, already used everywhere; the two greens are close enough that using both would read as an inconsistency, not a refresh. |
| Gold `#C79A2B` | `--color-sika-gold: #D4A017` | **Keep the existing token unchanged.** Same reasoning. |
| Warm Cream `#F8F6F1` | `--color-warm-paper: #FAF6EF` | **Reuse the existing token, but change its *role*** — see Section 4. This is the one case where the request and the existing system are pointing at the same thing already. |
| Soft Gold Highlights `#E7C66A` | *(no existing equivalent — genuinely new)* | **Add one new token**, `--color-sika-gold-soft: #E7C66A`, for low-opacity Adinkra/Kente accent strokes (Section 5–6) — nothing this light currently exists in the palette. |
| Deep Charcoal `#1F2937` | `--color-charcoal-ink: #22252B` (already exists, used for body text) + `.bg-charcoal` utility (exists in `css/utilities.css`, **currently unused anywhere**) | **Flagging, not deciding — see Open Question 2.** A prior brand pass deliberately replaced charcoal *section backgrounds* with navy (recorded task: "Sitewide dark-band color fix (bg-charcoal → bg-navy)"). The utility class still exists but nothing uses it today. Reintroducing charcoal as a background would reverse that earlier, deliberate decision. |
| *(not requested, but available)* Kente Red `#B33A3A` | Already exists, already reserved, currently unused | **Put to use** as the primary color for the Kente ribbon and Adinkra motif strokes (Section 5–6) — this is exactly the kind of tasteful, textile-rooted accent color the request is asking for, and it resolves the open item from the last brand review at the same time. |

## 4. The Actual Background Fix

One token-role change, cascading sitewide with zero markup edits (every section already reads the role token, not a raw color):

```css
/* Before */
--color-bg:     var(--color-warm-paper);   /* #FAF6EF — default page background */
--color-bg-alt: var(--color-light-sand);   /* #E8E4DC — alternating band */

/* After */
--color-bg:     var(--color-white);        /* #FFFFFF — default page background */
--color-bg-alt: var(--color-warm-paper);   /* #FAF6EF — becomes the occasional warm accent, not the default */
```

`--color-light-sand` stays defined (still used elsewhere as a border/decoration token) but stops being a full-section background. The `.bg-paper`/`.bg-sand` utility classes need no changes — their *names* stay accurate to what they now point at (`bg-paper` → white-ish/default, `bg-sand` → the warm cream tone), and every page that uses them (not just the homepage) brightens consistently.

**This is a sitewide change, not homepage-only** — see Open Question 3. The request's own wording ("replace... throughout the public website") reads as intentionally sitewide to me, and doing it at the token layer is genuinely the only clean way to achieve that without hand-editing every page. I'm flagging it explicitly rather than assuming, since the request otherwise frames this as a homepage task.

Practical effect on the homepage's 9 sections: Hero and the four currently-`bg-paper`/plain sections (Credibility, Resources preview, Meet the Founder, Newsletter) become white; Services and Coming Soon (currently `bg-sand`) become the warm cream tone — so the page still has gentle rhythm/alternation, just brighter and with more contrast between bands than two similar beiges had. The two navy bands (Free Guide promo, Featured eBook) are untouched — they're already the page's visual anchors and don't need to change.

## 5. Ghanaian Identity — Kente Ribbon

**What:** one new inline SVG component, `.kente-ribbon` — a slender flowing ribbon shape (bezier curve, not a straight band) carrying 3 thin interwoven stripes in Kente Red, Sika Gold, and Growth Green, at reduced opacity (roughly 12–18% of full stripe saturation, tuned during implementation against the new white background for contrast).

**Where:**
- **Hero, one corner only.** Replaces one of the three existing `hero__shape` circles (keeping the other two as-is, or restyling all three as a small ribbon-and-shapes cluster) — entering from the top-right or bottom-left corner, never crossing the headline/subtitle/CTA column. This directly satisfies the request's "flowing ribbon entering from one corner."
- Optionally, a much thinner version (a single flowing stroke, no fill) as a section-divider accent between two sections lower on the page — I'd recommend at most one additional placement (e.g. the transition into "Meet the Founder") to keep it a signature rather than a repeated pattern.
- **Never full-width, never a page background** — matches the request's explicit constraint.

**Technical approach:** a single hand-authored `<svg>` with 2–3 `<path>` elements, `aria-hidden="true"` (purely decorative, same convention as the existing hero shapes), positioned `absolute` within the hero's already-`position:relative` container. Motion is a slow (18–24s) `stroke-dashoffset` animation on the outline path — same category of effect as the existing `hero-shape-drift` keyframe, so it inherits the same reduced-motion handling with no new logic. Fully vector, no raster asset, negligible file weight (a few hundred bytes of inline markup).

## 6. Ghanaian Identity — Adinkra Symbols

**Which symbols, and why fewer than the full list:** the request names six candidates. I'd recommend picking **two, at most three**, and using them well, rather than scattering all six — "discovered rather than shouted" is easier to keep true with fewer, more deliberate placements:

- **Sankofa** ("go back and get it" — learning from the past to move forward) — thematically exact for the **Meet the Founder** section, which is literally about a personal history informing present guidance.
- **Gye Nyame** (supremacy/omnipresence — commonly read as a symbol of trust and providence) — fits the **Credibility/"Why trust us"** section.
- *(optional third)* **Nkyinkyim** (dynamism, versatility, growth through life's twists) — could anchor the **hero** itself, reinforcing "growth" without being literal.

I'd hold off on Fawohodie, Aya, and Dwennimmen for the homepage — they're better suited to other pages (e.g. Fawohodie/independence could suit `/about/` or `/services/business-financial-advisory/` later) than to a single homepage that's meant to stay uncluttered.

**Visual treatment:** simplified **line-art** versions matching the site's existing icon convention (`stroke:currentColor`, no fill, same stroke-width as `.icon`) — not literal, ornate traditional renderings, which would clash with the site's clean, minimal icon language and risk tipping into the "cultural museum" territory the request explicitly wants to avoid. Rendered large (150–260px) but at **very low opacity (5–8%)**, positioned as background watermarks in section corners/margins — e.g., a large faint Sankofa behind the founder portrait's negative space, a faint Gye Nyame behind the trust section's icon grid. `aria-hidden="true"`, `pointer-events:none`, and explicitly kept clear of the text column via absolute positioning + `z-index` under the content — never overlapping a headline or paragraph.

**A note on accuracy:** Adinkra symbols carry specific cultural meaning. I'll build these as clean, respectful line-art interpretations rather than free-hand approximations, and would appreciate a quick sanity check from you (or a source you trust) on the specific line forms before they ship, since precision matters here more than almost anywhere else in this redesign.

## 7. Motion Plan

- **Extend `data-reveal` to all 9 homepage sections** (currently only 3 have it) — Trust, Free Guide promo, Featured eBook, Coming Soon, Resources preview, and Newsletter all get the same fade/slide-up entrance the Hero/Services/Founder sections already have. Zero new code — just adding the existing attribute to 6 more `<section>` tags.
- **New, slow keyframe for the Adinkra watermarks** — a very small-amplitude (2–4px), slow (20s+) drift, same pattern as the existing `hero-shape-drift`, so it reads as "alive" without being distracting, and is caught by the same global reduced-motion override automatically.
- **Kente ribbon stroke animation** — described in Section 5, same reduced-motion coverage.
- **Parallax — recommend deferring.** The request lists it as a possibility, but genuine scroll-linked parallax needs a JS scroll listener (even a passive, `will-change`-optimized one), which is real additional complexity and the single riskiest item here for both performance and reduced-motion correctness. Given the request's own priority ordering ("performance remains a priority," "everything should feel premium" — not "everything should move"), I'd rather ship the fade-ins, ribbon, and Adinkra drift first, and treat parallax as an optional follow-up only if it's still wanted after seeing the rest in place.

## 8. Section-by-Section Summary

| Section | Background change | Other changes |
|---|---|---|
| Hero | `bg-paper` → white (via token change) | Kente ribbon in one corner; possibly restyle the 3 existing floating shapes to sit alongside it; wider `hero__subtitle` measure if line length is too short after the brighter background increases perceived contrast |
| Credibility/Trust | plain → white | Faint Gye Nyame watermark; add `data-reveal` |
| Free Guide promo | unchanged (navy) | Add `data-reveal`; card hover refinement |
| Services | `bg-sand` → warm cream (via token change) | Add `data-reveal` (already partially has it at section level — verify); `.resource-card` hover polish |
| Featured eBook | unchanged (navy) | Add `data-reveal` |
| Coming Soon | `bg-sand` → warm cream | Add `data-reveal` |
| Resources preview | plain → white | Add `data-reveal` |
| Meet the Founder | plain → white | Faint Sankofa watermark behind portrait; already has `data-reveal` |
| Newsletter | plain → white | Add `data-reveal`; button/field polish |

No section's content, copy, or order changes.

## 9. Cards & Buttons

All refinements are CSS-only, reusing existing shadow/radius/duration tokens — no new component classes needed beyond what's listed in Section 10:

- **`.resource-card`** — already has a hover lift (`translateY(-2px)`, shadow bump to `--shadow-3`); refine by adding a subtle `scale(1.01)` alongside the lift and slightly slowing the transition to `--duration-base` → feels more deliberate, less snappy.
- **`.book-card`** — similar treatment; the gold/green flat-color cover placeholders get a very subtle inner highlight (a soft radial `Soft Gold Highlight` glow at low opacity) so they read less like a flat placeholder and more like a deliberate design choice while the real cover art is still pending.
- **`.btn--primary`** — richer hover via existing `--color-growth-green-dark` (already defined, likely already used — verify) + shadow elevation from `--shadow-1` → `--shadow-2` on hover for a lifted feel.
- **`.btn--secondary`** — cleaner outline treatment: verify current border uses `--color-border-strong`; soften the hover background transition timing to `--duration-base`.

## 10. Reusable Components This Plan Introduces

Everything below is added at the shared CSS/token layer (`css/tokens.css`, `css/components.css`), not inline in `index.html` alone — so it's available to any future page, not homepage-only:

1. **`--color-sika-gold-soft` token** (new) — the one genuinely new palette value.
2. **`.kente-ribbon` component** — the SVG ribbon accent, parameterized enough (via a modifier class or two) to be reused on other pages later (e.g. `/about/`) without rebuilding it.
3. **`.adinkra-motif` component** — a small system (base class + `data-symbol="sankofa|gye-nyame|nkyinkyim"` or per-symbol modifier classes) for placing any of the line-art symbols as a low-opacity watermark anywhere on the site, not just these two homepage placements.
4. **Wider `data-reveal` adoption** — not new, just used more consistently; worth noting as a "component" in the sense that it's now the default expectation for any homepage-level section, not an ad-hoc choice.

## 11. What Will Not Change

Restating the request's own constraints, explicitly, so this plan is checkable against them: no changes to `backend/`, no routing changes, no API changes, no database/migration changes, no Worker changes, no CMS/admin changes, no business logic anywhere. No new npm packages, no build step, no external animation library, no new web fonts. No content or copy changes to any homepage section. No new raster images.

## 12. Performance & Accessibility Commitments

- All new decorative assets are inline SVG (vector, lightweight, no new HTTP requests).
- All new motion uses only CSS `transform`/`opacity`/`stroke-dashoffset` — no JS animation library, and (parallax aside, which is deferred) no new scroll-linked JS.
- Every new decorative element gets `aria-hidden="true"` and `pointer-events:none` — zero impact on screen readers or keyboard navigation, consistent with how the existing hero shapes and every icon sitewide are already marked up.
- All new motion is covered by the *existing* global `prefers-reduced-motion` rule in `base.css` — no new reduced-motion logic to write or forget.
- Contrast: the new white/cream backgrounds need a fresh contrast pass against `--color-text-primary`/`--color-text-secondary`/`--color-accent` — white generally *improves* contrast over the beige it replaces, but I'll verify all text/background pairs meet WCAG AA during implementation, not assume it.
- Semantic HTML structure (`<section aria-labelledby>`, heading hierarchy, `<blockquote>`, form labeling) is untouched — this plan only adds decorative, non-semantic elements and CSS.

## 13. Verification Plan (Post-Approval)

1. Implement the token-layer background change first, in isolation, and check every page that uses `.bg-paper`/`.bg-sand`/plain `.section` (not just the homepage) for visual regressions — since this is a shared token, not a homepage-scoped class.
2. Add the Kente ribbon + Adinkra motifs to the homepage only, per Section 8.
3. Extend `data-reveal` coverage.
4. Refine card/button hover states.
5. Browser-verify: desktop, tablet, and mobile breakpoints (768px/1199px are the real breakpoints in this codebase); confirm no layout shift (CLS) from the new decorative elements (all `position:absolute`/`pointer-events:none`, so they shouldn't affect document flow, but I'll confirm directly); confirm `prefers-reduced-motion` genuinely disables every new animation, not just the old ones; take before/after screenshots at each breakpoint; spot-check Lighthouse performance to confirm no material regression (expectation: negligible impact, since nothing new is a network request beyond the token/CSS diff itself).
6. Document every change in a short implementation report, matching this project's existing documentation discipline.

## 14. Open Questions — Need Your Decision Before Implementation

1. **Green/Gold hex values** — keep the existing, already-approved `#1F5C4E`/`#D4A017` tokens (recommended), or do you specifically want the new `#0F5C4D`/`#C79A2B` values even though they're a few percent off the current ones?
2. **Deep Charcoal `#1F2937`** — a prior brand pass deliberately moved dark section backgrounds from charcoal to navy. Do you want to revisit that decision (reintroduce charcoal somewhere), or should dark bands stay Ink Navy as they are today (recommended, since nothing in the request specifically calls for a second dark tone)?
3. **Background scope** — I'm reading "replace... throughout the public website" as intentionally sitewide (achieved via the shared token), not homepage-only. Confirm that's the intended scope?
4. **Adinkra selection** — comfortable with Sankofa + Gye Nyame (+ optionally Nkyinkyim), or do you want different symbols from your list of six?
5. **Testimonials** — no testimonials section exists on the homepage today, and I can't fabricate customer quotes given this project's established no-unverifiable-claims discipline. Do you have real testimonial content to add, or should this line item be deferred until some exists?

Once these are resolved, implementation can begin immediately — everything else in this plan is ready to build as described.
