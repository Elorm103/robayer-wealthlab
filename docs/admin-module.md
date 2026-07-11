# Admin Module Planning (Phase 8)

**Status: architecture only. No login page, no dashboard, no admin
code of any kind exists in this repository.** This document designs
*where each future admin capability would live and what kind of
system it needs* — not its UI, not its implementation.

## Starting point: this project already has an admin-module vision

This isn't a new idea introduced by commerce. `README.md` already
describes the long-term plan for editing this site's content: **a
future local editor or Git-backed CMS**, operating directly on the
plain JSON files in `content/`, with no database and no proprietary
format (see `README.md`'s "Future roadmap" section). Commerce doesn't
replace that plan — it extends it, and also introduces a few
capabilities that plan was never designed to cover, because they
aren't content at all. Splitting those two kinds of things clearly is
the main architectural decision this document makes.

## Two fundamentally different kinds of "admin"

| Kind | Examples | Storage model |
|---|---|---|
| **Content editing** | Product Management, Resources, (parts of) Newsletter | Plain JSON files in `content/`, edited by hand or a future editor/CMS, committed to git like any other change |
| **Transactional records** | Order Management, Downloads, Customers, Consultations, Analytics | Data generated continuously by real-world events (a purchase, a form submission) — **cannot** live as git-committed JSON, because that would mean committing a file to this repository for every single order or enquiry |

Treating both the same way — e.g., trying to make an "order" a
git-committed JSON file — would mean deploying a new version of the
site on every sale, which is both impractical and a misuse of what
git/GitHub Pages is for. The sections below apply the right model to
each capability.

---

## Product Management

**Model: content editing**, following the existing plan exactly.

A future admin experience for products means editing
`content/products/{slug}.json` (create, update `status`, adjust
`price`) and `content/product-types/index.json` / `content/topics/index.json`
(renamed/split from Sprint 1's single `content/categories/index.json`
in Sprint 2.1) — either by hand (as every other content type on this
site is edited today) or through a
future small local tool / Git-backed CMS that opens a pull request
with the edited JSON, per `README.md`'s existing plan. No new storage
model is needed. The one addition commerce brings: **file uploads**
(a cover image into `assets/covers/`, a product file into
`assets/products/`) — something the existing content model has never
needed before, since no prior content type included a purchasable
file. A future editing tool needs a place to put an uploaded file
before referencing its path from JSON; that's a tooling detail for
whoever builds the editor, not an architecture decision this sprint
needs to make.

## Order Management

**Model: transactional records — needs real storage, decided later.**

An order is created the moment a Paystack transaction is verified
(see `docs/paystack-integration.md`) and needs to record at minimum:
the transaction reference, the product slug, the amount and currency,
the buyer's email, the verified timestamp, and the current fulfillment
state (e.g., "paid," "download issued," "refunded"). This cannot be a
file in this git repository — it needs a real datastore that the same
serverless function performing Paystack verification can write to.
**This document does not choose that datastore** (options range from a
lightweight hosted database to simply Paystack's own dashboard as the
system of record for basic needs) — that choice is coupled to the
hosting decision for the verification function itself
(`docs/paystack-integration.md`) and the object storage decision
(`docs/download-security.md`), and should be made once, together, not
three separate times.

## Downloads

**Model: transactional records, derived from Order Management.**

"Downloads" as an admin capability is a *view* over the download-
issuance log described in `docs/download-security.md` — which
reference issued a signed URL, when, and how many times against
`downloads.maxPerPurchase`. It doesn't need its own separate storage
system; it needs the Order Management datastore (above) to also record
each issuance event, and an admin view that queries it per order or
per product.

## Customers

**Model: a derived view, not a new stored entity.**

This project should resist building a full customer/CRM record system
it doesn't need. A "customer" is realistically just **an email address
with a history of orders** — grouping the Order Management records
above by email *is* the customer view. Building a separate `Customer`
schema with its own ID, login, and profile would be exactly the kind
of premature structure this project has consistently avoided
elsewhere (no accounts, no passwords — matching the explicit "No
authentication" instruction for this sprint, and the download-delivery
design in `docs/download-security.md` that deliberately avoids
requiring a login to redeem a purchase).

## Newsletter

**Model: content editing (curated issues) + an existing, separate gap
(subscriber capture).**

Two different things share the name "Newsletter" on this site today:

1. `content/newsletter/` (documented, no real data yet) — the *archive
   of past issues*, which is content editing, no different from any
   other content type.
2. **Subscriber capture** — `js/components/newsletter-form.js` (and,
   worth noting plainly here, `contact-form.js` and
   `consultation-form.js` too) currently validates its form
   client-side and shows a success message, but **sends the submitted
   data nowhere** — there is no backend, so no address is actually
   captured today. This is a pre-existing gap, not something this
   sprint changes, but any future Admin Module work on "Newsletter,"
   "Customers," or "Consultations" inherits the same missing piece:
   **a real endpoint to receive form submissions.** The standard,
   proportionate fix for a site this size is a third-party email
   service provider (e.g., Mailchimp, Buttondown) with a hosted
   sign-up endpoint, rather than building custom subscriber storage —
   consistent with this project's "reuse, don't rebuild" instinct.

## Resources

**Model: content editing**, and this sprint's own core reframing.

Per this sprint's explicit brief, free resources become `Product`
records with `price: 0` rather than a separate system — so "Resources"
as a future admin capability *is* Product Management, filtered to
`price === 0`, not a second admin section. No separate storage or
tooling required beyond what Product Management already needs.

## Consultations

**Model: transactional records — blocked on the same gap as
Newsletter.**

Consultation requests have the identical "form validates, but submits
nowhere" gap described above under Newsletter. A future Admin Module's
"Consultations" section — a list of submitted requests, their manual-
review status (matching Sprint 3's "reviewed manually, not booked"
design), and Robert's response state — cannot exist until form
submissions actually reach *some* backend. That backend could be as
simple as a form-to-email service (e.g., Formspree-style) or as
involved as the same serverless layer handling Paystack — a decision
for whoever closes this gap, out of scope for a commerce-focused
sprint, but flagged here because "Consultations" was explicitly named
in this sprint's Admin Planning brief.

## Analytics

**Model: mostly derived, mostly external — not a custom build.**

- **Sales analytics** (revenue, top products, conversion) — a derived
  view over Order Management once it exists; most Paystack dashboards
  already provide basic versions of this without any custom work.
- **Site traffic/behavior analytics** — this project has never added
  its own analytics today (per the existing site, no tracking script
  is loaded anywhere) — introducing one (e.g., a privacy-respecting,
  cookie-free option) is a separate decision from commerce and isn't
  scoped by this sprint.

Building a custom analytics store is very unlikely to be worth it at
this project's scale — this section deliberately recommends *reusing*
existing tools (Paystack's own dashboard, a lightweight external
analytics service if one is ever added) over building anything new.

---

## Summary: what actually needs new infrastructure

Everything above reduces to the same short list already emerging from
`docs/download-security.md` and `docs/paystack-integration.md`:

1. One serverless function (Paystack verification + fulfillment).
2. One real datastore for orders/downloads (feeds Order Management,
   Downloads, and the derived Customers view).
3. One resolved gap for form submissions generally (feeds Newsletter
   subscriber capture and Consultations — pre-existing, not commerce-
   specific, but relevant to plan alongside).

Product Management and Resources need **no new infrastructure** — they
extend the content-editing model this project already has. Analytics
needs **no custom infrastructure** — it's a view over the above plus
existing third-party tools.

**Update (Version 1.2 Sprint 2):** all three items above are now
resolved. The serverless function is a Cloudflare Worker
(`docs/cloudflare-architecture.md`), the datastore is Cloudflare D1
(`docs/database-design.md`), and the form-submission gap is closed by
`POST /api/newsletter` and `POST /api/consultation`
(`docs/worker-api-design.md`). Nothing above needed to be revised —
Sprint 1's architecture predicted exactly this shape.

---

## Sprint 2 — Dashboard Modules & Permissions (Phase 8 expansion)

With authentication now designed (`docs/authentication-strategy.md`'s
three roles: `super_admin`, `editor`, `support`), each admin capability
above maps to a specific future dashboard module and a specific
permission per role. **No frontend exists for any of this yet** — this
is the permission model such a frontend (and its underlying API calls)
would enforce.

| Module | `super_admin` | `editor` | `support` |
|---|---|---|---|
| **Dashboard** (summary view: recent orders, pending consultations, subscriber count) | View | View | View |
| **Products** (create/edit `content/products/` records, change `status`, price) | Full | Full | View only |
| **Orders** (view order list/detail, `docs/database-design.md`'s `orders` table) | Full, including refund | Full, including refund | View only |
| **Downloads** (view issuance log, manually reissue a download for a support case) | Full | Full | Reissue only (no policy changes) |
| **Customers** (the derived email + order-history view — no separate stored entity, see above) | Full | View only | View only |
| **Newsletter** (view/export subscriber list; this project does not recommend building custom bulk-send tooling — see "Newsletter" above) | Full | View + export | No access |
| **Consultations** (view queue, update `status` per `docs/database-design.md`'s `consultation_requests` table) | Full | Full | View + update status only |
| **Analytics** (derived views — see "Analytics" above) | Full | View only | No access |
| **Settings** (manage other `admin_users` rows, roles, site-level config, and — per `docs/email-architecture.md`'s Stage 1 — a read-only preview of email templates) | Full | No access | No access |

### Why `support` cannot change prices or issue refunds

The `support` role exists specifically for handling buyer questions
("I didn't get my download," "can you resend my receipt") without
needing the ability to alter what something costs or reverse a
payment — a real operational boundary, not an arbitrary restriction.
This mirrors the same "least privilege" reasoning behind
`docs/authentication-strategy.md`'s decision to have roles at all,
rather than a single all-or-nothing admin account.

### Why `editor` cannot manage other admins

Per `docs/authentication-strategy.md`, only `super_admin` can create,
deactivate, or change the role of another `admin_users` row — an
`editor` who could grant themselves `super_admin` would make the role
distinction meaningless. This is enforced the same way every other
permission here eventually will be: a check in `backend/middleware/auth.ts`
against the role stored in the KV-backed session, before a route's own
logic runs.
