# Digital Product Content

## Purpose

Holds the structured record of every sellable digital product on
Robayer WealthLab — ebooks, PDF guides, templates, spreadsheets,
premium reports, checklists, courses, and any future digital product
type.

*(Updated — Sprint 2.2, `docs/product-discovery-architecture.md`.)*
Two real records now exist:
`starting-to-invest-with-gh100` (the already-live, already-selling-via-placeholder
eBook — moved into this data layer, not new content) and
`momo-savings-playbook` (`status: "coming-soon"`, matching its existing
teased placement on `/books/`). No fabricated products — everything in
both files was already genuinely public before this sprint. Every
other field on both records that wasn't already publicly stated
(cover images, reading time precision, publish dates) is either `null`
or clearly flagged as an estimate — see each file's own values.

**`js/components/product-loader.js` is now live** on `/books/` and the
homepage (Sprint 2.2) — see `docs/product-discovery-architecture.md`
for the discovery-experience architecture. See
`docs/commerce-architecture.md` for the Sprint 1 audit of where a
storefront will eventually connect, and `docs/product-platform-architecture.md`
(Sprint 2.1) for the full loader API and how to add a real product
when the time comes.

## Why one schema for every product type

A course and a checklist differ in what they *are*, not in what a
storefront needs to know to sell them: a title, a price, a cover
image, one or more downloadable files, and metadata for
search/filtering and Paystack. `productType` (see
`content/product-types/`) is what distinguishes an ebook from a
checklist — not a separate schema per type. This mirrors how the Goal
Planner already handles 8 different goals with one config shape rather
than 8 bespoke ones.

## File shape

- `content/products/index.json` — a real, currently-empty array
  (`[]`). This is the product registry a future storefront page would
  fetch to know what exists. It is empty because no product exists
  yet — not a placeholder standing in for invented data.
- `content/products/{slug}.json` — one file per product, added only
  once a real product is ready to sell. None exist yet.

See `content/SCHEMA.md` for the field-by-field schema (the `Product`
entry).

## Field-by-field rationale

| Field | Why it exists |
|---|---|
| `id` | A stable internal identifier, separate from `slug`. A slug can reasonably change later (SEO, a typo fix) without orphaning a future order/download-token record that references `id`. *(Sprint 2.1)* |
| `slug` | Matches the URL segment a future `/store/{slug}/` (or similar) page would use — same convention as every other content type's `slug`. |
| `title` / `subtitle` | The product's real name and a one-line clarifier, matching the `title`/`summary` pattern already used by every other content type. |
| `shortDescription` / `description` | Card-grid teaser vs. full detail-page copy — the same split already used by Services (`overview` vs. `summary`) and Calculators (`educationalExplanation` vs. `summary`). |
| `topic` | Points to a `content/topics/{slug}.json` record (investing, personal-finance, budgeting, business, mindset) — the *subject*. See that folder's README. *(Sprint 2.1, split out of Sprint 1's single `category` field)* |
| `productType` | Points to a `content/product-types/{slug}.json` record (ebook, guide, template, spreadsheet, report, checklist, course) — the *format*. Renamed from Sprint 1's `category` for the same reason. |
| `status` | `draft` / `active` / `archived` / `coming-soon`. Lets a product exist in the registry before it's publicly listed, or be publicly teased without being purchasable (`coming-soon` matches the already-live `.book-card--upcoming` treatment on `/books/`). Only `active` products would ever render as purchasable on a future storefront. |
| `price` / `currency` | The listed price and its currency code (`GHS` by default, matching every existing price on the site, e.g. the eBook's GH₵39). Stored as a number in the smallest sensible display unit (whole Cedis) — **not** Paystack's subunit (pesewas) format; that conversion happens at checkout time, not in content. |
| `pricingModel` | `"one-time"` today (the only value in use). Present now, at zero cost, so a future subscription/membership product extends this enum rather than requiring the field to be invented later. *(Sprint 2.1 — see "Future Compatibility" below)* |
| `sku` | A short, human-assignable internal code (`RWL-` prefix + product type + running number, e.g. `RWL-EBOOK-001`) — useful for support conversations and matching a Paystack transaction back to a specific product, not a barcode/inventory system (digital products have no physical stock to track). |
| `coverImage` | The one image a detail-page hero uses. Path under `assets/covers/`. |
| `thumbnail` | A smaller/cropped variant of `coverImage` for dense grid cards, so a future grid of dozens of products doesn't load full-size covers everywhere. *(Sprint 2.1)* |
| `previewImage` | The one "here's a sample" image shown prominently before purchase — distinct from `gallery` (general product images) and `previewPages` (a multi-page sample array). *(Sprint 2.1)* |
| `gallery` | Optional additional images (e.g., interior spreads of an ebook, or screenshots of a template). |
| `downloadFiles` | An array of Digital Asset records (`assetId`, `productSlug`, `filename`, `displayName`, `fileType`, `fileSizeBytes`, `version`, `checksum`, `storageKey`, `status`) — **never served directly to an unpaid visitor**; see `docs/digital-fulfilment.md` and `docs/download-security.md`. Sprint 2.1 changed this from a single `downloadFile` path to an array (supporting a product shipping more than one file); Sprint 2.5 enriched each entry from a bare `{ label, path, format }` into a full asset record, since `assetId`/`storageKey`/`status` are what the new entitlement/delivery system actually references. |
| `previewPages` | An optional array of preview-only images or a preview PDF path — lets a buyer see a sample before paying, without exposing the full file. |
| `fileFormat` | Array of format strings (`["PDF"]`, `["XLSX", "PDF"]`) — shown on a storefront card/filter. *(Sprint 2.1)* |
| `language` | Defaults to `"en"` — matches the Blog Article schema's `inLanguage` JSON-LD convention already used elsewhere. *(Sprint 2.1)* |
| `estimatedReadingTime` | Minutes, nullable — mainly relevant to ebooks/guides. *(Sprint 2.1)* |
| `author` | Matches `content/founder/bio.json`'s `name` by default (Robert Loh Kobla) — kept as its own field rather than a hardcoded assumption, since a future course could have a guest instructor. |
| `version` | For products revised after release (e.g., the eBook's 2nd edition) — lets a past buyer's download permission logically map to "any version" or "version purchased," a decision deferred to `docs/download-security.md`. |
| `publishedDate` / `updatedDate` | Matches the `publishedDate`/`modifiedDate` convention already used by the Blog Article schema. |
| `featured` / `bestseller` / `newRelease` | Three independent badges a card can show simultaneously (a product can be both new *and* a bestseller) — `featured` existed in Sprint 1; the other two are Sprint 2.1 additions, matching how `.badge` is already used elsewhere on the site. |
| `tags` | Free-text array for search/filtering, matching the Blog Article schema's own `tags` field. |
| `seo` | `{ title, metaDescription, canonical }` — matches the Investment Centre Topic schema's own `seo` object, kept as a structured record of what a future product detail page's `<head>` would contain. |
| `paystack` | `{ metadata }` — a free-form object passed through to Paystack's `metadata` field on transaction initialization, so a webhook payload can be matched back to this exact product without guessing. See `docs/paystack-integration.md`. |
| `downloads` | `{ maxPerPurchase, expiresAfterDays }` — the *policy* a future download-delivery system would enforce (see `docs/download-security.md`), not an active limit today. |
| `license` | *(future support, not required today)* — `{ type, seats }`, present so a future course or template sold with usage terms doesn't require a schema migration later. Every current field works with `license` entirely absent. |
| `relatedProducts` / `relatedResources` / `relatedServices` | Slug/path arrays, matching the exact cross-linking convention already used by every other content type — resolved the same way, via a small hardcoded lookup or direct href, never a second fetch. |

## Future Compatibility

Design targets named in Sprint 2.1's brief, and how the schema
anticipates each **without building it now**:

| Future need | How the schema is ready for it |
|---|---|
| Multiple currencies | Already supported per-product — `currency` is already a field, not a sitewide constant. A future multi-currency *display* (showing a price converted for a visitor's locale) is a rendering concern, not a schema one. |
| Discounts / coupon codes | Not a `Product` field — a discount applies *across* products or for a limited time, which is a separate future content type (e.g. `content/coupons/{code}.json`: `{ code, percentOff, validUntil, appliesTo }`), not a property of any one product. |
| Bundles | A future `productType: "bundle"` entry in `content/product-types/`, plus a new `bundleItems: [slug, slug, …]` field on the bundle's own `Product` record — no change needed to any existing product. |
| Subscriptions / membership products | `pricingModel` (added this sprint) extends from `"one-time"` to `"subscription"` — the field already exists; only the second enum value and the actual billing logic are future work. |
| Multiple file downloads | Already done — `downloadFiles` is an array today, not deferred. |
| Product updates / version history | `version`/`updatedDate` already capture "what's the current version." A future `versionHistory: [{ version, date, notes }]` array is a straightforward additive field once a product actually needs revision history — not added speculatively now, since no product exists yet to have a history. |

## Compliance note

No product listed here should ever claim a guarantee, a specific
financial outcome, or licensed advice — the same compliance posture
already established for every other content type on this site. A
product's `description` is marketing copy for something real and
delivered; it is not, and must never become, a substitute disclaimer
for investment advice.
