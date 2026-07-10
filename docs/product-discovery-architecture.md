# Product Discovery Architecture — Version 1.2 Sprint 2.2

## Status

**Discovery only. Nothing in this sprint sells anything.** No
Paystack, no checkout, no payment verification, no secure downloads,
no customer accounts, no purchases. The Buy CTA on every product
surface remains a link to the product page (or, on a detail page, a
placeholder button) — never a payment action. This sprint is entirely
about how a visitor finds, understands, and compares products before
Sprint 2.3 makes them buyable.

Sprint 2.1 (`docs/product-platform-architecture.md`) built the schema
and the loader's query API but wired it up to nothing — no live page
included `product-loader.js`. This sprint is the first time the
Product Platform is actually live: `/books/`, the homepage, and the
eBook detail page all render from real `content/products/*.json`
records via `window.RobayerProducts`.

## Discovery flow

A visitor can reach a product from four entry points, all converging
on the same detail page:

1. **Homepage → Featured eBook banner.** The existing
   `.feature-banner` section (unchanged markup) has its title,
   description, and CTA filled from `getFeatured(getActive(products))[0]`
   via `initFeatureBanners()`. If no product is `featured: true` and
   `active`, the section's original hand-written copy is left exactly
   as it was — the static fallback and the dynamic content are the
   same words, so there is no visible seam either way.
2. **Homepage → Coming Soon section.** A new section, hidden entirely
   (via `data-hide-section-if-empty`) if nothing has
   `status: "coming-soon"`. Exists so a visitor sees the catalog is
   growing, not just the one available item.
3. **Books page (`/books/`).** The full public catalog —
   `getPubliclyListed()` (active + coming-soon), filterable by the
   real topic taxonomy (Investing, Personal Finance, Budgeting,
   Business, Mindset) via the shared pill+search component
   (`js/components/content-filters.js`).
4. **Related Products (on a detail page).** Cross-sell into the rest
   of the catalog from wherever a visitor already is — see "Related
   Products ranking strategy" below.

All four render the exact same `.book-card` markup via the one
`renderCard()` function — a visitor sees a consistent card everywhere,
and a 50th product needs zero new rendering code.

## Related Products ranking strategy

`getRelatedProducts(products, product, limit = 3)` fills the slots in
four ordered tiers, never repeating a product and stopping once `limit`
is reached:

1. **Same topic** as the source product (e.g. two Investing titles).
2. **Same product type** (e.g. two eBooks), for anything topic didn't
   already fill.
3. **Featured products**, as a fallback to fill remaining slots —
   surface the catalog's best material even when nothing is
   topically close yet.
4. **Catch-all** — anything else at all, publicly listed and not the
   source product itself.

The catch-all tier was added after live testing on the real two-product
catalog: `starting-to-invest-with-gh100` (Investing, eBook, featured)
and `momo-savings-playbook` (Personal Finance, guide, not featured)
share no topic, no product type, and the second isn't featured — so
tiers 1–3 legitimately matched nothing, and the Related Products
section rendered empty. A "You might also like" rail should degrade
gracefully as the catalog grows from 2 products to 50; showing
"something else in the library" beats showing nothing.

The candidate pool is `getPubliclyListed()` (active + coming-soon), not
`getActive()` alone — a genuinely related coming-soon title is an
honest, useful recommendation ("you might also like this, coming
soon"), consistent with the `.book-card--upcoming` treatment already
live on `/books/`. This deliberately differs from the Featured banner,
which stays `getActive()`-only: *featuring* something unavailable would
overstate it, but *relating* it to what the visitor is already looking
at does not.

## Badge system

Badges are rendered entirely from product metadata inside `renderCard()`
— there is no per-product hardcoded label anywhere in HTML. A product
earns a badge purely by having the corresponding field set:

| Badge | Condition | Style |
|---|---|---|
| Coming soon | `status === "coming-soon"` | `badge--warning` |
| New | `newRelease === true` | `badge--info` |
| Bestseller | `bestseller === true` | `badge--success` |
| Free | `price === 0` (and not coming-soon) | `badge--success` |
| Updated | `updatedDate` genuinely after `publishedDate` (`isGenuinelyUpdated()`) | `badge--info` |

Badges are not mutually exclusive — a product can show several at once
(e.g. a free, newly-released guide shows both "New" and "Free"). Order
is fixed (Coming soon, New, Bestseller, Free, Updated) so multi-badge
cards are visually consistent across the catalog rather than ordered
per-product. "Updated" is computed, not author-set — a product's own
`updatedDate` can't lie about whether it's genuinely newer than its
`publishedDate`, which prevents an accidental or stale "Updated" badge
from a copy-pasted date field.

Accessibility: badges are plain `<span>` text (not color-only, not
icon-only), so the label itself — not just the color — conveys the
status. They sit before the title in reading order, so a screen reader
announces a product's state before its name.

## Empty states

Handled at two levels:

**Grid level** (`initProductGrids()`), opt-in per grid via attributes,
because different grids want different behavior:

- **Default (no opt-in):** if a filtered grid comes back empty, the
  grid's existing markup is left completely untouched. This matters
  for a page like `/books/` whose grid starts genuinely empty in the
  HTML (no fallback content to preserve) — nothing renders, no error.
- **`data-empty-message="…"`:** replaces the grid with a single honest
  message (e.g. "No guides published yet — check back soon."). Used on
  `/books/` so a topic pill with zero current matches doesn't look
  broken.
- **`data-hide-section-if-empty="true"`:** hides the grid's closest
  `<section>` ancestor entirely. Used on the homepage's Coming Soon
  section — a heading reading "More guides on the way" over an empty
  grid would look like a bug, not an honest empty catalog, so the
  whole section disappears until there's real content.

**Single-product level** (`getProductPageState()`), for anywhere a
product is looked up by slug rather than listed in a grid:

| State | Trigger | Message |
|---|---|---|
| `not-found` | slug doesn't resolve to any product | "We couldn't find that product — it may have been moved or the link may be incorrect." |
| `archived` | `status === "archived"` | "This product is no longer available." |
| `unavailable` | `status === "draft"` | "This product isn't available yet." |
| `coming-soon` | `status === "coming-soon"` | "This product is coming soon — check back or subscribe to the newsletter to know the moment it launches." |
| `active` | `status === "active"` | (no message — render normally) |

Not yet exercised by a live dynamic route this sprint — detail pages
remain hand-authored HTML (see "Why detail pages stay static" below),
so no page today looks up an arbitrary slug from a URL parameter. It's
ready for the day a dynamic detail-page route or a search results page
needs to classify an arbitrary slug, including one that resolves to
nothing at all (a mistyped or stale link).

## Why detail pages stay static

Every content type on this site (Blog, Services, Calculators) ships
its real page as hand-authored HTML, not client-side-rendered from
JSON — an established, repeatedly-reaffirmed precedent. Product detail
pages follow the same rule: `books/starting-to-invest-with-gh100/index.html`
is real HTML with real `<meta>` tags, not a shell that fetches and
renders `starting-to-invest-with-gh100.json` at runtime. Reasons this
was reaffirmed rather than revisited this sprint:

- **SEO.** Title, description, canonical, Open Graph, and Twitter Card
  tags must exist in the HTML at parse time for a crawler or a link
  preview — a client-side-only render defeats that.
- **Performance.** "No framework, no build step, minimal JavaScript,
  excellent Lighthouse performance" is a standing constraint; a detail
  page that must fetch JSON before showing anything adds a
  render-blocking round trip for zero benefit over static HTML.
- **Consistency.** Every other content type on the site already proves
  this pattern works at this project's scale.

What *is* loader-rendered on a detail page is the part that genuinely
benefits from being dynamic and cross-referential: the Related
Products rail (`data-product-grid data-related-to="{slug}"`), which by
definition depends on the rest of the catalog and shouldn't be
hand-maintained per page.

`content/products/product-detail-template.html` (from Sprint 2.1)
remains the reference structure for authoring a new detail page by
hand — not a template engine, since this project has none.

## Search preparation (not built this sprint)

No search UI or index exists yet. The data shape already supports one
without a schema change:

- `renderCard()` already emits `data-title` on every card (originally
  added for `content-filters.js`'s existing text-search behavior) —
  the same attribute a future search index would want for a full-text
  match.
- `loadAll()` returns the complete, validated product list — a future
  search page would call it once, build a client-side index (title,
  subtitle, shortDescription, tags, topic, productType) with a small
  in-page search library or a hand-rolled substring filter, and render
  results with the existing `renderCard()` — no new card markup.
- `tags` (a plain string array on every Product) exists specifically
  to give search something more granular than topic/productType to
  match against — e.g. searching "beginners" should find
  `starting-to-invest-with-gh100` via its `tags: ["ebook", "investing",
  "beginners"]` even though "beginners" isn't a topic or product type.
- The `[data-product-grid]` auto-renderer's filter-attribute pattern
  (`data-topic`, `data-product-type`, etc.) is the template a
  `data-search-query="…"` attribute would extend, staying consistent
  with how every other grid filter already works.

## Future recommendations (beyond Related Products)

`getRelatedProducts()` is topic/type/featured-based — it has no notion
of *behavior* (what a visitor viewed, what similar visitors bought).
A future "Recommended for you" personalization layer would need: (1) a
way to track view/purchase history per visitor (this project has no
visitor identity system beyond a one-time newsletter email — see
`docs/authentication-strategy.md`'s scope), and (2) a ranking signal
beyond static metadata. Out of scope until there's both real traffic
data and a reason to build visitor tracking; the current
metadata-based ranking is the honest, buildable option at this
catalog's size.

## Future ratings & reviews

No schema field exists for this yet (`Product` has no `rating` or
`reviewCount`). When built, it plugs in as: a new
`content/reviews/{product-slug}/{review-id}.json` content type (mirroring
how every other content type here is one-file-per-record), a
`Product.ratingSummary: { average, count }` field computed and
periodically written back (not computed client-side on every page
load), and a new badge tier ("Highly rated") added to `renderCard()`'s
existing badge list — no restructuring of the badge system itself,
just one more conditional badge. Genuinely deferred: no real customer
base exists yet to generate real reviews, and this project's
"real content, never fabricated" discipline means this won't be
built with placeholder review data.

## Future bundles

`Product.productType` would need a `"bundle"` value, and the schema
would need a `Product.bundleContents: string[]` (an array of member
product slugs) — both additive, non-breaking changes to the existing
schema. `getRelatedProducts()` and `renderCard()` would need no changes
to treat a bundle as just another product; only checkout (Sprint 2.3+)
would need bundle-aware logic (buying one bundle unlocks N downloads).
Documented as an extension point in `content/products/README.md`'s
"Future Compatibility" table since Sprint 2.1; still not built, since
no second real product pairing exists yet to justify a bundle.

## Future wishlists

Requires persistent visitor identity (a wishlist has to survive a
return visit), which this project doesn't have — see "Future
recommendations" above. The realistic near-term substitute, already
live, is the Coming Soon section's "Get notified" CTA to `/newsletter/`
— it captures intent without needing accounts. A true per-visitor
wishlist is a post-accounts feature, consistent with
`docs/product-platform-architecture.md`'s "Future customer dashboard"
section, which defers account infrastructure for the same reason.

## Future collections

A "collection" (an editorial grouping across topics/types — e.g. "Start
Here" or "GH₵100 Starter Kit") is a curation concern, not a filtering
concern — different from `topic`/`productType`, which describe what a
product *is*. The clean extension point is a new
`content/collections/{slug}.json` content type holding an ordered list
of product slugs plus a title/description, rendered with a
`data-product-grid data-collection="{slug}"` attribute added to
`initProductGrids()`'s filter branch — additive, no changes to the
Product schema itself. Deferred until there are enough real products
that an editorial grouping adds value beyond what topic/type filters
already provide.

## Extension points summary

| Feature | Schema change needed? | Loader change needed? | Blocked on |
|---|---|---|---|
| Search | No (uses existing `tags`/`data-title`) | New search function + UI | A live search page |
| Recommendations | New `Product.viewCount`-style signal (later) | New ranking function | Visitor tracking system |
| Ratings & reviews | New `content/reviews/` type + `ratingSummary` field | New badge tier | Real customer base |
| Bundles | New `productType: "bundle"` + `bundleContents` field | None (renders as a normal card) | A second product to bundle |
| Wishlists | New visitor-identity concept | New per-visitor storage | Customer accounts (Sprint-2.3+ territory) |
| Collections | New `content/collections/` type | New `data-collection` filter branch | Enough products to curate |

## SEO

Product metadata is generated dynamically wherever a page is already
loader-driven, and hand-authored (from the same source data, kept in
sync manually) wherever the page is static HTML:

- **Detail pages** (`books/{slug}/index.html`): `<title>`,
  `<meta description>`, canonical, Open Graph, and Twitter Card tags
  are hand-authored in the page itself, sourced from the product's own
  `seo` object in its JSON record (`content/SCHEMA.md`'s Product entry)
  — the JSON is the source of truth even though the HTML is static, so
  updating a product's copy means updating both, same as this project's
  existing content types.
- **Books listing page and homepage sections**: no per-product
  metadata needed — these pages have their own single, page-level
  `<title>`/description; individual product cards don't carry their
  own meta tags (they're not separate documents).
- **Structured data**: not added this sprint. `Product` schema already
  has everything a future `Product` JSON-LD block would need (`title`,
  `description`, `price`, `currency`, `sku`); deferred until there's a
  reason to prioritize rich-snippet SEO over the currently-higher
  priority of building out the catalog itself.

No metadata is duplicated across pages — each product's `seo` object
lives once, in its own JSON record.

## Accessibility

Verified this sprint on the homepage, `/books/`, and the eBook detail
page via live browser testing (accessibility tree snapshots, not just
visual inspection):

- **Heading hierarchy**: one `<h1>` per page; product titles inside
  cards use `<p class="book-card__title">`, not headings, since a grid
  of N products isn't N sections of the page — consistent with how
  Blog/Resources cards already work.
- **Keyboard navigation**: every card's CTA is a real `<a>`, every
  filter pill a real `<button>` — both natively focusable and
  activatable, no custom key handling needed.
- **ARIA labels**: filter pills use `aria-pressed` (already part of
  `content-filters.js`, unchanged this sprint) to convey active state
  to assistive tech.
- **Alt text**: `book-card__cover` is a decorative background-image
  `<div>`, not an `<img>` — matches how the rest of the site treats
  purely decorative cover art; a real product photo would need real
  alt text once cover images exist (currently `null` on both real
  products — honestly absent, not a broken image).
- **Focus order**: DOM order matches visual order in every grid and
  the feature banner — no CSS-driven reordering that would desync
  focus order from reading order.
- **Badge accessibility**: badges are text-bearing `<span>` elements
  read in-line by a screen reader before the product title, not
  color-only indicators (see "Badge system" above).

## Performance

Unchanged constraints, reaffirmed: no framework, no build step,
`product-loader.js` is a single dependency-free script. Product grids
render after one `fetch` for the index plus one per product (parallelized
via `Promise.all`) — at this catalog's current size (2 products) this is
effectively instant; documented here as the one place a future 50-product
catalog might eventually want a single combined JSON file instead of
per-product fetches, though not a real problem at today's scale.

## Validation performed

- Homepage: Featured eBook banner renders real product title/description/CTA
  (verified via accessibility snapshot: "Starting to Invest with GH₵100",
  "Get the guide — GH₵39.00"); Coming Soon section renders the MoMo Savings
  Playbook card with its "Coming soon" badge and "Get notified" CTA; zero
  console errors; zero failed network requests; pre-existing Free Guide
  Promo section (Phase 1, unrelated) unaffected.
- `/books/`: both real products render via the loader; topic pills filter
  correctly against the real 5-topic taxonomy; empty-state message appears
  for topics with no current matches.
- Product detail page: metadata line (topic, type, format, reading time,
  version, language, availability) and tags line render correctly; Related
  Products renders the MoMo Savings Playbook via the catch-all tier.
- Regression: newsletter signup, free-guide landing page, and all
  previously-live pages unaffected — this sprint added script includes
  and markup only to `index.html`, `books/index.html`, and the eBook
  detail page.

## Explicitly deferred to Sprint 2.3 or later

- Paystack, checkout, payment verification, secure downloads, customer
  accounts, purchases — all out of scope per this sprint's brief.
- Homepage "Newest Release" and "Free Resources" sections — not built
  this sprint. With only one active product (which is also the sole
  featured product), "Newest Release" would show the exact same single
  card as the Featured banner (redundant), and zero products currently
  have `price: 0` (an empty "Free Resources" section). Both helper
  functions (`getNewest`, `getFree`) already exist in the loader and
  are ready to power these sections the moment there's enough real
  inventory to make them non-redundant and non-empty.
- Search, recommendations, ratings/reviews, bundles, wishlists,
  collections — see "Extension points summary" above.
- `Product.features` schema field, structured data (JSON-LD) —
  carried over from Sprint 2.1's own deferred list, still not needed.
