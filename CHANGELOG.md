# Changelog

All notable work on the Robayer WealthLab website is recorded here. Dates
are in `YYYY-MM-DD`. This project has no releases yet — entries are
grouped by development phase/sprint instead of version number.

## [Unreleased]

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
