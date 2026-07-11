# Migration Roadmap (Phase 9)

**Status: roadmap only. No step below has been executed.** This
document sequences every future sprint needed to go from today's fully
static site to a working, secure digital storefront — each step
depends only on the ones before it, and the static site keeps working,
unmodified, through every step until the very end.

```
Current static site
       ↓
Cloudflare backend (foundation)
       ↓
Paystack (real payments)
       ↓
Downloads (real delivery)
       ↓
Admin (real dashboard)
       ↓
Future Storefront (real /store/ page)
```

## Step 0 — Current static site (today)

GitHub Pages, fully static, no backend. `content/products/index.json`
is empty. `js/components/product-loader.js` exists but loads nothing.
This state is the baseline every later step must not disturb until
its own moment arrives.

## Step 1 — Cloudflare backend (Sprint 2's output: foundation; Sprint 3's output: newsletter/contact/consultation)

**What "done" looks like:** a real Cloudflare Worker deployed, a real
D1 database with `backend/database/schema.sql` applied, a real R2
bucket matching `docs/storage-strategy.md`'s layout, and — updated in
Version 1.2 Sprint 3 — `POST /api/newsletter`, `POST /api/contact`,
and `POST /api/consultation` genuinely implemented and wired to the
three matching live forms (`js/components/newsletter-form.js`,
`contact-form.js`, `consultation-form.js`).

This is a deliberate acceleration relative to this document's original
version, which assumed Step 1 stayed uncalled by any live page until
Paystack's Step 2. Sprint 3 was explicitly scoped to wire these three
specific forms now, precisely because they don't depend on Paystack,
Orders, or Downloads at all — only Step 2's actual payment/Buy-button
integration still waits on this step being complete, unchanged from
the original plan below.

**Depends on:** nothing — this is the foundation.

**Explicitly not included:** Paystack keys, real product files, admin
users, or any change to the eBook's "Buy the guide" button (still
`data-placeholder-action`, unchanged — that remains Step 2's job).

## Step 2 — Paystack (real payments)

**What "done" looks like:** `POST /api/payments/verify` genuinely
calls Paystack's API with real (initially *test-mode*) keys;
`content/products/{slug}.json` for the one real product (the eBook)
gets its `status` moved to `active` for the first time; the eBook's
existing "Buy the guide" button (currently `data-placeholder-action`,
per `docs/commerce-architecture.md`'s Phase 1 finding) is rewired to
actually open the Paystack popup and call the real
`POST /api/orders` → `POST /api/payments/verify` flow. **This is the
first step that changes a live page** — specifically, and only, that
one button on that one page.

**Depends on:** Step 1 (the Worker/D1 must exist and be reachable from
the live site's own domain, which means CORS — `docs/backend-security.md`
— must already be configured correctly).

**Explicitly not included:** real file delivery (Step 3) — a
successful test-mode purchase at this step can be verified via the
`orders`/`payment_transactions` tables directly, without a real
download existing yet.

## Step 3 — Downloads (real delivery)

**What "done" looks like:** the eBook's real file exists in R2
(`ebooks/starting-to-invest-with-gh100.pdf`), `GET /api/download/:token`
actually streams it, and a successful purchase results in a real,
working download — either shown immediately on an order-confirmation
page, emailed, or both (per `docs/download-security.md`'s "email as
the resilient default" recommendation).

**Depends on:** Step 2 (an order must be genuinely verifiable before
its download entitlement means anything).

**Explicitly not included:** any admin UI to manage this — at this
step, `downloads`/`download_tokens` rows are inspected directly (via
Cloudflare's own D1 dashboard/CLI) if something needs troubleshooting.

## Step 4 — Admin (real dashboard)

**What "done" looks like:** a real, deployed admin frontend
(a small, separate set of pages — not part of the public static site,
and explicitly not React/Vue/Next.js per this project's
framework restrictions, though the admin frontend is a slightly more
permissive context than the public site since it's never indexed or
publicly linked) implementing the modules and permissions from
`docs/admin-module.md`'s Sprint 2 expansion, backed by
`POST /api/admin/login` and the KV-backed session from
`docs/authentication-strategy.md`.

**Depends on:** Steps 1–3 (there must be real orders, downloads, and
products to actually administer — building an admin dashboard first,
with nothing real behind it, would be exactly the kind of premature
build this project avoids).

**Explicitly not included:** a public storefront page — the admin
dashboard manages products; it doesn't yet display them to buyers
beyond the one hand-coded eBook page from Step 2.

## Step 5 — Future Storefront

**What "done" looks like:** a real `/store/` or `/products/` page
(exact route TBD at that time — `docs/worker-api-design.md`'s
`GET /api/products` already anticipates this), where
`js/components/product-loader.js` (dormant since Version 1.2 Sprint 1)
finally has something to load, rendering every `active` product as a
`.resource-card`. Existing navigation (Books, Resources, Learn,
Investment Centre) stays exactly as it is — the Storefront is a new,
additional page, not a replacement for any of them, per this
project's explicit "avoid duplicate architectures" instruction:
Books' one real product and any future products all appear through
this same page and the same `content/products/` schema.

**Depends on:** Step 4 (a real admin dashboard should exist to manage
more than one product before a public grid gives buyers more than one
to choose from).

---

## What stays true at every step

- GitHub Pages continues serving the static site unmodified until the
  specific page/button a given step is about is intentionally changed.
- No step retroactively breaks an earlier step's promises — e.g., Step
  5's Storefront does not require re-doing Step 2's Paystack
  integration, only reusing it for more products.
- Each step is independently reversible/pausable — the project can
  stop after any step and still have a fully working site, exactly as
  this sprint's own "nothing already working should break" instruction
  requires.
