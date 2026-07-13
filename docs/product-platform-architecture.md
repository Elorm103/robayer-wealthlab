# Digital Product Platform Architecture — Version 1.2 Sprint 2.1

**Note (Version 2.0 Phase 2):** the `content/products/*.json` storage layer this doc describes has since been migrated into a D1 `products` table and retired as a live data source — see `docs/products-module-implementation.md`. The `content/product-types/` and `content/topics/` taxonomies described below are still the reference vocabulary for the `product_type`/`topic` columns.

## Status

**Architecture only. Nothing in this sprint sells anything, and
nothing here is wired to a live page.** No payment code, no checkout,
no delivery, no customer accounts, no backend changes, no new HTML
page routes. This sprint extends Sprint 1's commerce architecture
(`docs/commerce-architecture.md`) into a genuinely scalable foundation
— a product catalogue capable of supporting dozens or hundreds of
products (ebooks, PDF guides, templates, spreadsheets, premium
reports, checklists, and future courses) without a future redesign.

Phase 1 (the Lead Magnet System — `docs/lead-magnet-architecture.md`)
is complete, frozen, and untouched by this sprint. Nothing below
modifies `/free-guide/`, the homepage promo section, the newsletter
signup flow, or any Worker/backend code.

## What changed from Sprint 1

Sprint 1 already built a real Product schema, a category taxonomy, and
a dormant product loader. This sprint didn't rebuild that — it found
and fixed the gaps between what Sprint 1 designed and what Sprint 2.1
actually needs, then extended it:

1. **`category` split into `topic` + `productType`.** Sprint 1's
   single field conflated *subject* (Investing, Personal Finance,
   Budgeting, Business, Mindset) and *format* (eBook, PDF Guide,
   Template, Spreadsheet, Report, Checklist, Course) — a storefront
   needs to filter by both independently. `content/categories/` is
   renamed `content/product-types/`; a new `content/topics/` holds the
   subject taxonomy. See `content/SCHEMA.md`'s Product entry for the
   full field-level rationale.
2. **The product card component was fixed to match the real, live
   `/books/` page.** Sprint 1's `product-loader.js` generated
   `.resource-card` markup — but the actual Books listing page
   (`books/index.html`) already uses `.book-card` (cover, title,
   price, description, CTA), a component purpose-built for exactly
   this. The loader now generates `.book-card` markup, so a future
   real product grid renders identically to what's already proven
   live, and the Books page's currently-hand-coded cards *could* later
   be replaced by loader-rendered ones with zero visual change.
3. **The loader gained a real query API**, not just a grid
   auto-renderer: `getBySlug`, `getFeatured`, `getBestsellers`,
   `getNewReleases`, `getActive`, `getByType`, `getByTopic`,
   `sortByDate`, `sortByPrice`, plus `validateProduct` (used
   internally on load, also exported for reuse) and `renderCard` (the
   reusable card, callable directly — not only via the grid
   auto-renderer). See "Loader API" below.
4. **Schema fields added**: `id` (stable identifier, separate from
   `slug`), `thumbnail`, `previewImage`, `fileFormat`, `language`,
   `estimatedReadingTime`, `bestseller`, `newRelease`, `pricingModel`,
   and a `"coming-soon"` status value (matching the already-live
   `.book-card--upcoming` treatment on `/books/`). `downloadFile`
   (single path) became `downloadFiles` (array), directly supporting
   multi-file products at zero migration cost, since no real product
   data exists yet to migrate.

## Architecture principles (unchanged from Sprint 1, reaffirmed)

- Static, framework-free, no build step. No React, no Vue, no bundler.
- Real content, JSON as the structured record — **zero fake product
  data**, same discipline as `content/services/`, `content/calculators/`,
  and every other content type on this site.
- One schema for every product type, distinguished by `productType`,
  not one schema per format — matches how the Goal Planner already
  handles 8 different goals with one config shape.
- Code is written and ready before it has a real consumer, but never
  *included* on a live page until it does — an unused `<script>` tag
  is dead weight this project consistently avoids.

## Loader API

`js/components/product-loader.js` exports `window.RobayerProducts`.
Not included on any page today — see the file's own header comment.

```js
// A future Store page, once it exists:
RobayerProducts.loadAll().then((products) => {
  const active = RobayerProducts.getActive(products);
  const featured = RobayerProducts.getFeatured(active);
  const byNewest = RobayerProducts.sortByDate(active, 'desc');
  document.querySelector('#grid').innerHTML = byNewest.map(RobayerProducts.renderCard).join('');
});

// A future product detail page, once it exists:
RobayerProducts.fetchProduct('starting-to-invest-with-gh100').then((product) => {
  // render the detail page from `product`
});
```

`loadAll()` fetches `content/products/index.json`, then every
referenced `content/products/{slug}.json`, validates each against the
required-field list (`id`, `slug`, `title`, `productType`, `status`,
`price`, `currency`), and silently drops (with a `console.warn`, not a
thrown error) anything invalid or that failed to fetch — a future
storefront page never crashes because one product record has a typo.

The optional grid auto-renderer (`[data-product-grid]`, with optional
`data-product-type="…"` / `data-topic="…"` filter attributes) still
works exactly as Sprint 1 designed it — unchanged behavior, just
generating the corrected card markup.

## Adding a new product

1. Create `content/products/{slug}.json` matching the schema in
   `content/SCHEMA.md`'s Product entry. Set `status: "draft"` until
   it's ready to be public, or `"coming-soon"` to publicly tease it
   without it being purchasable yet.
2. Add the file's cover/thumbnail/preview images to `assets/covers/`,
   and its source file(s) to `assets/products/` (see that folder's
   README — never `assets/downloads/`, which is reserved for the
   future signed-URL delivery mechanism, not a source-file store).
3. Append the new slug to `content/products/index.json`'s array.
4. Set `status: "active"` when ready to go live.
5. If/when a real Store or Books-grid page exists and includes
   `product-loader.js`, the product appears automatically — no code
   change. Until then, it exists in the content system but nowhere
   public, which is the intended, honest state for a product that
   isn't sellable yet (no checkout exists).

For a hand-authored detail page (the pattern every other content type
on this site currently uses — see `content/README.md`), start from
`content/products/product-detail-template.html`, a documented
reference structure (not a live template engine — this project has no
build step) generalizing the real, proven structure of
`books/starting-to-invest-with-gh100/index.html`.

## Removing a product

Set `status: "archived"` rather than deleting the JSON file — the
record needs to keep existing for any past purchase's order/download
history to still resolve correctly once a real commerce backend
exists (an archived product is unlisted, not erased). Only delete the
file outright if the product was never real (e.g., a test entry) —
never for something that was ever actually sold.

## Categories vs. Product Types — quick reference

| Concept | Content type | Example values | Answers |
|---|---|---|---|
| Topic | `content/topics/` | investing, personal-finance, budgeting, business, mindset | "What's this *about*?" |
| Product Type | `content/product-types/` | ebook, guide, template, spreadsheet, report, checklist, course | "What *format* is this?" |

Both are independent filters a future storefront grid can combine
(e.g., "Templates about Budgeting").

## Future payment integration

Not built this sprint. When it is, it plugs in exactly where
`docs/paystack-integration.md` and `docs/commerce-architecture.md`
already describe: `POST /api/orders` creates a `pending` order
referencing a `Product.slug`, `POST /api/payments/verify` confirms it
server-side against Paystack, never trusting a client-supplied
"success" alone. `Product.paystack.metadata` (already in the schema)
is what a webhook payload gets matched back against. None of this
sprint's schema or loader changes require rework when that's built —
the Product record already has everything Paystack initialization
needs (`price`, `currency`, `sku`, `paystack.metadata`).

## Future eBook / product delivery

Not built this sprint. `docs/download-security.md` already specifies
the mechanism (a Worker-mediated, signed, single-use download token —
never a permanent public link to `downloadFiles`). This sprint's
`downloadFiles` array (vs. Sprint 1's single `downloadFile`) is exactly
what that future mechanism needs to hand a buyer more than one file
per purchase without a schema change then. See also
`docs/lead-magnet-architecture.md`'s "Future delivery workflow" section
for the closely related, already-designed email-attachment delivery
pattern for free products — a paid product's delivery would follow
the same shape, gated by a real purchase instead of a newsletter
signup.

## Future customer dashboard

Not built this sprint, and not part of this platform's near-term
roadmap — `docs/admin-module.md` covers the *admin* side (managing
products, viewing orders) in depth; a *customer-facing* "my purchases"
dashboard is a genuinely separate, larger feature (requires some form
of buyer identity/session beyond a one-time email, which this project
has explicitly avoided building — see `docs/authentication-strategy.md`'s
scope, which is admin-only). The current design's fallback is
`GET /api/orders/:id` (already speced in `docs/worker-api-design.md`)
— a buyer can check one order's status via its reference without
needing an account at all, which covers the realistic need at this
project's scale without building account infrastructure prematurely.

## Explicitly deferred to Sprint 2.2 (or later)

- A live `/store/` or `/products/` listing page that actually includes
  `product-loader.js`.
- The Books page (`books/index.html`) migrating its hand-coded
  `.book-card` markup to loader-rendered cards — not needed until
  there's a second real book to justify it (one hardcoded card is
  simpler than a fetch for a single item).
- Any real product data — the eBook becoming an actual
  `content/products/starting-to-invest-with-gh100.json` record.
- Discount/coupon content type, bundle product type, subscription
  billing logic — all documented as extension points in
  `content/products/README.md`'s "Future Compatibility" table, none
  built.
- A `Product.features` schema field (referenced as a placeholder in
  `product-detail-template.html`) — not added to the schema yet since
  no real product exists to prove out its exact shape.
- Paystack, checkout, download delivery, customer accounts — all
  explicitly out of this sprint's scope per the brief.
