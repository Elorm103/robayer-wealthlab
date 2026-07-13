# Version 2.0 — Product Management Specification

**Superseded by implementation:** during build-out this design's D1-mirrors-JSON model was replaced with D1 as the sole source of truth (content JSON migrated once, then retired). See `docs/products-module-implementation.md` for what was actually built. This doc's workflow/UX reasoning (create/edit/archive/versions) is still broadly accurate; its data-flow description is not.

**Grounding:** the real, live product model is `content/products/{slug}.json`, validated by `content/SCHEMA.md`, read at runtime by `backend/services/productCatalogService.ts` (checkout) and `js/components/product-loader.js` (public pages) — confirmed, unchanged since Version 1.2. This spec designs an admin layer *on top of* that existing model — it does not replace content-as-source-of-truth with a database, which would be a much larger, unjustified rewrite of a system that already works correctly.

---

## The core design decision: D1 mirrors, JSON remains authoritative

Every write from the admin (create/edit/publish/archive) does two things, in order, atomically as far as the Worker can make them:
1. Write the updated product JSON via the R2/publish pipeline (see below).
2. Insert a `product_versions` snapshot row (D1) for history/versioning.

The **public site continues to read `content/products/*.json` exactly as it does today** — zero change to `productCatalogService.ts`, `product-loader.js`, or the checkout flow. The admin dashboard's product *list/detail* reads, meanwhile, load from the same JSON files (fetched server-side by the Worker, same `SITE_BASE_URL` pattern `productCatalogService.ts` already uses) rather than a duplicated D1 table — there is no `products` D1 table in this design (the dead one stays dead, per the database-expansion doc). This means **zero risk of the two ever disagreeing about what a product actually is** — there's only ever one real record, the JSON file; D1 only ever stores its history.

**How admin writes actually reach the file:** since a Cloudflare Worker cannot write to a GitHub-Pages-served static file directly, the publish action commits the updated JSON via the GitHub API (a new, narrowly-scoped capability — see `docs/v2-migration-strategy.md`'s "Publishing pipeline" for the exact mechanism, secrets required, and failure handling). This is the single most architecturally significant new capability in all of V2.0 and is treated with corresponding care in the risk assessment.

---

## Workflows

### Create
Admin fills the Details/Pricing/Digital Assets/Cover tabs (see UX spec) → "Save as Draft" writes a new `content/products/{slug}.json` with `status: "draft"` (a real, already-supported status value — draft products are simply never surfaced by `product-loader.js`'s `getFeatured()`/listing calls, which already filter to `active` — no new filtering logic needed anywhere on the public site).

### Edit
Loads the real current JSON, admin edits, "Save" writes the updated file + a version snapshot. **Price changes on an already-purchased product never retroactively affect a past purchase** — `purchase_sessions.amount_pesewas` already snapshots the price at checkout time (confirmed in the real schema), so this is inherently safe with zero new code.

### Delete
**Not offered as a real capability — only Archive is.** A digital product that's ever been purchased has real customers with real entitlements (`deliveries` rows) referencing it; hard-deleting the product record would orphan those. The UI does not present a "Delete" option for products with any real order history (checked via a live `purchase_sessions` count at the moment the Product Details page loads) — only "Archive." A product with zero orders ever *may* be hard-deleted (a genuine draft that was never worth publishing), gated behind an explicit "This product has never been purchased — permanently delete?" confirmation, distinct copy from Archive's confirmation.

### Archive
Sets `status: "archived"`. Public site: already-purchased customers keep their existing `deliveries`/download access untouched (nothing about archiving touches the fulfilment tables); the product simply stops appearing in `active`-filtered listings/checkout. This is a real, already-correct behavior of the existing `status` field — the admin action just needs to set it.

### Publish
`status: "draft" → "active"`. A distinct, explicit action (not implied by "Save") — matches the UX spec's confirmation-modal treatment.

### Upload PDF / Cover / Thumbnail
All three route through the shared Media pipeline (`docs/v2-media-library-spec.md`), writing to R2 under the established key convention (`ebooks/{slug}.pdf`, `covers/{slug}.jpg`) and updating the product JSON's `downloadFiles[].storageKey`/`coverImage`/`thumbnail` fields to point at the real key — closing the exact real gap the production readiness audits found (placeholder cover art, since Version 1.0's very first brand review).

### Pricing
A single `price` (GHS) field, matching the real, live schema exactly — no new pricing model is introduced (subscriptions, tiered pricing) because none exists in the checkout flow today; inventing admin UI for a pricing model the payment layer can't actually process would be a placeholder implementation, explicitly disallowed by this sprint's own rules.

### Categories / Topics
Dropdowns populated from the real `content/product-types/index.json` and `content/topics/index.json` files — not free text, not a new taxonomy. Adding a new category/topic is a separate, smaller admin action (or, for V2.0's first phase, remains a manual content edit — see risk assessment for why taxonomy management is explicitly deferred rather than built half-heartedly).

### Versions
Every save appends a `product_versions` row (full JSON snapshot). The Versions tab lists them newest-first with editor attribution and a plain-text diff of the fields that changed (title, price, description, status — not a byte-diff of the whole JSON, which would be unreadable). **No one-click revert in V2.0's first phase** — reverting a product is rare enough, and consequential enough (it could silently change a live price), that requiring a human to manually re-edit using an old version as reference is the safer default; a true revert button is a reasonable fast-follow once the version history has real usage to learn from.

### Status
`draft` / `active` / `archived` — exactly the three values the real schema already supports. No new status is introduced.

### Inventory
**Not applicable in the traditional sense — these are unlimited digital goods.** "Inventory" in this brief maps to: download policy (`maxDownloads`, `expiresAfterDays` — already real fields), and (informationally) a live count of how many `deliveries` rows exist for this product (i.e., how many times it's actually been fulfilled) — shown as a read-only stat on the product detail page, not an editable stock number.

### Digital Assets
The Digital Assets tab manages `downloadFiles[]` — today always exactly one PDF per product, but the schema already supports an array (bundles, multi-file products) — the admin UI supports adding more than one file per product from day one, since the underlying schema already does and building a single-file-only UI would mean redoing this work later for no reason.

---

## What Product Management does NOT do (explicit scope cuts)

- No bundle/multi-product-package builder (a real V2.0-later feature per `docs/v2-development-roadmap.md`, not this phase).
- No inventory/stock management (not applicable to unlimited digital goods).
- No pricing experiments/A-B pricing.
- No direct database table for products — reiterated because it's the single most important constraint this entire spec is built around.
