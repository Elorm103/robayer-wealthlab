# Commerce Architecture — Version 1.2 Sprint 1

## Purpose of this document

This is the entry point for Version 1.2's commerce planning. It
records the Phase 1 audit (where commerce naturally connects to the
existing site), the overall architecture decisions, and the Product
Loader design. Deeper, phase-specific documents live alongside it:

- [`content/products/README.md`](../content/products/README.md) — Digital Product content model (Phase 2)
- [`content/product-types/README.md`](../content/product-types/README.md) — Product Type taxonomy, renamed from `content/categories/` (Phase 2, renamed Sprint 2.1)
- [`content/topics/README.md`](../content/topics/README.md) — Product Topic taxonomy, split out of `category` (Sprint 2.1)
- [`content/SCHEMA.md`](../content/SCHEMA.md) — the `Product`/`Product Type`/`Topic` JSON schemas (Phase 4, extended Sprint 2.1)
- [`product-platform-architecture.md`](product-platform-architecture.md) — full Sprint 2.1 platform architecture, loader API, adding/removing products
- [`download-security.md`](download-security.md) — Download security research (Phase 6)
- [`paystack-integration.md`](paystack-integration.md) — Paystack integration planning (Phase 7)
- [`admin-module.md`](admin-module.md) — Admin Module planning (Phase 8)

**Nothing in this sprint sells anything.** No payment code, no backend,
no live storefront page, no fake product data. This sprint designs the
architecture Paystack (and a future storefront) will plug into.

**Version 1.2 Sprint 2.1 note:** this architecture was extended, not
replaced — see `docs/product-platform-architecture.md`. `category`
split into `topic` (`content/topics/`) and `productType` (renamed
`content/categories/` → `content/product-types/`), the product card
component was corrected to match the real, live `/books/` page, and
the loader gained a full query API. Still nothing sells anything, and
still nothing is wired to a live page.

---

## Phase 1 — Audit: where commerce naturally connects

Every existing section was reviewed for whether and how paid digital
products should surface there, without disturbing what's already
working.

### Books — the clearest, highest-priority connection point

`books/starting-to-invest-with-gh100/index.html` already behaves like
a product page in every way except the checkout itself: it has a real
price (GH₵39), a dedicated CTA ("Buy the guide — GH₵39"), and explicit
"Instant digital access" messaging. Today that CTA uses
`data-placeholder-action` (an honest "not connected yet" pattern,
consistent with this site's no-fake-functionality standard) and its
supporting copy says **"Secure checkout via SkillsPad."**

**Finding:** "SkillsPad" is a stale reference to a payment provider
that is no longer the plan — Paystack is. This isn't fixed in this
sprint (no payment code yet, and claiming a specific checkout process
before Paystack is actually wired up would overstate readiness), but
it's flagged here so Sprint 2 corrects it as part of actually wiring
Paystack in, not forgotten.

**Resolved — Version 1.2 Sprint 2.3 (Commerce Foundation):** the Buy
CTA now calls a real checkout flow (`js/components/buy-button.js` →
`POST /api/checkout/sessions`), so the copy was corrected to "Secure
checkout via Paystack" — see `docs/commerce-foundation.md`.

**Conclusion:** the eBook is the natural first real Product once
commerce goes live. `content/books/` doesn't exist yet as a content
type (the book's real content is hand-written directly in its own
HTML, same as everywhere else on this site) — when this book becomes
a real `Product` record, it will live in `content/products/`, not a
new `content/books/`, since "digital product for sale" is the more
accurate model than "book" specifically (the schema is written to
equally support templates, courses, and checklists — see
`content/products/README.md`).

### Resources — the natural home for a future paid tier

`resources/index.html` already has 6 real, honestly-labeled **free**
downloads (Budget Planner, Emergency Fund Checklist, Debt Snowball
Worksheet, Monthly Expense Tracker, Investment Readiness Checklist,
and one more), each using the same `data-placeholder-action` "not
finalized yet" pattern. These stay free — nothing here should be
retroactively paywalled.

**Conclusion:** Resources is the natural place a *future* premium tier
would sit alongside the free one, reusing the exact same
`.resource-card` component with a price shown instead of a "Free"
badge (no new component needed — see `content/products/README.md`'s
note on reusing `.resource-card`). Not built this sprint.

### Goal Planner & Calculators — future cross-sell surface, not a rebuild

Both already have a "Related resources/services/calculators" pattern
on every page, driven by real, curated cross-links (Goal Planner
additionally reads structured JSON per goal). Once real products
exist, a `relatedProducts` field is the natural extension of both the
Goal Planner's and Calculators' existing content schemas — for
example, the "Retirement" goal recommending a future "Retirement
Planning Workbook" template. This is documented as a **planned future
field**, not implemented now (see `content/products/README.md`'s
"Future cross-linking" section) — adding it today with no real
products to reference would be exactly the kind of premature,
speculative build this project has consistently avoided (the same
lesson already learned from `js/content-loader.js` being removed for
having zero real consumers).

### Services — a genuinely different commerce model, kept separate

`content/services/*.json` already has a `pricing` field
(`{ "display": "Contact for pricing", "amount": null, "currency":
"GHS" }`). This is **quote-based, conversation-driven pricing** for
coaching/advisory time — categorically different from a fixed-price,
instant-download product. The two should never share one checkout
flow: a consultation is scheduled and quoted per person; a digital
product is bought instantly at a listed price. This sprint's Product
schema and Paystack plan apply only to the latter. Services keep
routing to `/consultation/`, unchanged.

### Consultation — not a commerce target this sprint

Consultation requests remain manually reviewed with no booking system
(Sprint 3's deliberate design). Whether a *deposit* or *paid priority
booking* fee is ever charged through Paystack is a service-payment
question, not a digital-product question — explicitly out of this
sprint's scope ("this sprint is NOT about adding payments," and
booking was separately and explicitly ruled out in Sprint 4). No
changes made here.

### Newsletter — a distribution channel, not an integration point

The newsletter has no direct commerce role, but it's already the
site's fallback CTA on every `data-placeholder-action` message
("subscribe to know the moment it's ready"). Once products exist,
announcing new ones to subscribers is the natural launch channel —
this requires no architecture change, just future email content.

### Summary table

| Area | Commerce role | Action this sprint |
|---|---|---|
| Books | First real Product (eBook) | Documented only — flagged stale "SkillsPad" copy (resolved: the buy button is now wired to real Paystack checkout via `data-buy-button`, and the "SkillsPad" copy was corrected during the Version 1.0 Launch Readiness legal-page pass — see docs/launch-readiness.md Task 1) |
| Resources | Future paid tier alongside free downloads | Documented only |
| Goal Planner / Calculators | Future `relatedProducts` cross-sell | Documented only |
| Services | Separate, quote-based commerce model — not a Product | Explicitly excluded, no change |
| Consultation | Separate, service-payment question — not a Product | Explicitly excluded, no change |
| Newsletter | Marketing/distribution channel | No change |

---

## Architecture decisions

1. **One content type for every sellable thing.** Ebooks, templates,
   courses, and checklists are all `content/products/{slug}.json`
   records distinguished by `category`, not separate content types.
   This avoids four near-identical schemas and matches how this
   project already generalizes (e.g., the `Goal Planner Config`
   schema handles 8 different goals with one shape).
2. **Real content in HTML, JSON as the structured record — until a
   genuine live consumer exists.** Following the exact precedent of
   `content/services/` and `content/calculators/`: this sprint creates
   `content/products/` as a real, documented schema with zero fake
   entries. `content/products/index.json` is a real, empty `[]` — an
   honest "no products exist yet" registry, not a placeholder with
   invented data.
3. **The Product Loader is built now, wired to nothing.** Phase 5
   asks for loader *architecture*, capable of rendering products *in
   the future*. `js/components/product-loader.js` is written,
   defensive (no-ops safely with zero products or no target
   container), and not added to any page's `<script>` tags — there is
   no page with a product grid yet, so including the script anywhere
   would be dead weight (the same "don't ship JS with zero real
   consumers" discipline applied throughout this project).
4. **Commerce planning docs live in a new `docs/` folder**, separate
   from `content/`. `content/` holds content *data* schemas;
   `download-security.md`, `paystack-integration.md`, and
   `admin-module.md` are operational/architecture research, not content
   schemas — a new, purely additive top-level folder, not a rename or
   move of anything existing.
5. **Services and Products are architecturally distinct and stay
   that way.** No shared "commerce" abstraction is introduced between
   quote-based services and fixed-price products — they have
   different pricing models, different checkout needs, and conflating
   them would be exactly the kind of premature unification this
   project's own precedent (`calculator-utils.js` vs. the deliberately
   separate `goal-planner.js` lookup tables) argues against doing
   without a genuine shared need.

## What this sprint does NOT do

- No live Shop/Store page.
- No product data (real or fake) beyond the empty `index.json` registry.
- No Paystack code, keys, or SDK.
- No payment, checkout, download-delivery, or admin code.
- No changes to navigation, branding, or any existing page's visible content.
