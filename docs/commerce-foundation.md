# Commerce Foundation — Version 1.2 Sprint 2.3

## Status

**Foundation only. Nothing in this sprint delivers an ebook, verifies
a payment, issues a receipt, builds a customer dashboard, grants a
download, processes a refund, or handles a webhook.** Those are
Sprint 2.4 (Payment Verification), Sprint 2.5 (Secure Ebook Delivery),
and later sprints. This sprint's entire job is: when a visitor clicks
Buy, prepare a secure checkout session and send them to pay — nothing
more.

Sprint 2.1 (Digital Product Platform Foundation) and Sprint 2.2
(Product Discovery Experience) are complete and frozen; this sprint
does not modify their live pages beyond wiring the one real Buy button
that already existed as a placeholder.

## The core principle

The frontend never talks to Paystack directly, and never sees a
Paystack key of any kind. Every checkout request flows through one
path:

```
Visitor → Website (buy-button.js) → Cloudflare Worker (routes/checkout.ts)
        → Commerce Service (services/commerceService.ts)
        → Payment Provider (services/payments/paystackProvider.ts)
        → Paystack → returns a checkout URL
        → Worker returns that URL to the browser
        → Visitor is redirected to Paystack's hosted checkout page
```

The Worker owns all payment logic. The browser's only two jobs are:
send `{ productId }`, and redirect to whatever `checkoutUrl` comes
back.

## Commerce lifecycle

1. **Visitor clicks Buy.** `js/components/buy-button.js` disables the
   button, shows a loading state, and `POST`s `{ productId: "<slug>" }`
   to `POST /api/checkout/sessions`. Nothing else is sent — no price,
   no currency, no title (see "Pricing" below).
2. **The Worker validates the product.** `productCatalogService.ts`
   fetches `content/products/{slug}.json` from the live site and
   checks it's genuinely purchasable (`status === "active"`, a real
   positive price, a real currency). Anything else — unknown slug,
   draft, archived, coming-soon, or free — is rejected with one
   generic, friendly error (see "Security").
3. **The Commerce Service creates a purchase session.** A
   `purchase_sessions` row is inserted in D1 with `status: 'pending'`,
   and an internal purchase reference (`RWL-2026-000001`) is generated
   from the row's own id — before Paystack is ever contacted. See
   "Internal purchase reference" below.
4. **The Commerce Service asks the Payment Provider to prepare
   checkout.** `paystackProvider.createCheckoutSession()` calls
   Paystack's `POST /transaction/initialize` with the
   server-validated amount/currency and the internal reference, and
   gets back an `authorization_url`.
5. **The Worker records the result and responds.** The
   `purchase_sessions` row is updated with the checkout URL and
   Paystack's own reference (kept for support, never treated as the
   primary key — see below); the Worker returns
   `{ purchaseReference, checkoutUrl }` to the browser.
6. **The browser redirects.** `window.location.href = checkoutUrl` —
   the visitor lands on Paystack's own hosted payment page. The Buy
   button stays disabled through this redirect.
7. **What happens after the visitor pays is Sprint 2.4's job, not
   this one.** This sprint does not verify anything, does not mark
   the session `paid`, and does not deliver anything. The
   `purchase_sessions` row simply sits `pending` (or, if the visitor
   never completes checkout, eventually reads as abandoned/expired by
   its `expires_at`) until Sprint 2.4 exists.

## Purchase session

`backend/database/schema.sql`'s `purchase_sessions` table (migration
`0002_purchase_sessions.sql`) is the record created the moment
checkout starts — see that file for the full column-by-column
rationale. Two decisions worth calling out explicitly:

**It keys off `product_slug` (TEXT), not a D1 `products` row.**
`backend/database/schema.sql` already had `products`/`orders`/
`customers`/`payment_transactions` tables, designed in an earlier
sprint — but that was *before* Sprint 2.1 pivoted the real, live
product catalog to `content/products/{slug}.json` files, read by
`js/components/product-loader.js`. That `products` table has never
been populated under the live architecture and never will be without
a parallel content-sync mechanism nobody has asked for. Building
checkout on top of it would mean either fabricating rows into a table
nothing else touches, or silently failing every real purchase. Instead,
`purchase_sessions.product_slug` matches the Product Platform's own
identifier directly — the same one every other Sprint 2.x feature
already uses. This is "one source of truth for product data,"
Sprint 2.2's own principle, applied to the backend.

**Resolved in Sprint 2.4:** `purchase_sessions` *is* this project's
order-equivalent record — `payment_transactions` was repointed to
reference it directly, and `orders`/`customers`/`products` are now
explicitly marked deprecated in `schema.sql` rather than retired
outright (no real risk either way, since neither was ever run against
a real database). See `docs/payment-verification.md`'s "Database"
section for the full resolution.

## Internal purchase reference

Format: `RWL-{year}-{6-digit sequence}` — e.g. `RWL-2026-000001`.
Generated in `backend/utils/purchaseReference.ts` from the
`purchase_sessions` row's own D1 `AUTOINCREMENT` id (via a two-step
insert: insert with `purchase_reference = NULL` to obtain the row's
id, then `UPDATE` with the formatted value — see that file's comment
for why `NULL`, not a placeholder string, is what makes this
race-free under concurrent inserts).

This is generated **before Paystack is ever contacted**, and is what
this project treats as the primary business identifier for a purchase
— never Paystack's own transaction reference. Three reasons:

1. **It exists even if the visitor never reaches Paystack.** A closed
   tab, a declined initialize call, an abandoned checkout — all of
   these still leave a traceable, searchable record with this
   project's own ID, not a dangling nothing.
2. **Provider independence.** If Paystack is ever replaced or a second
   provider added (see "Payment provider abstraction" below), every
   purchase this project has ever recorded still has the same kind of
   identifier. A support conversation, an audit log, or a future
   admin dashboard never needs to know or care which provider a given
   purchase went through.
3. **It's human-legible.** `RWL-2026-000001` reads like an invoice
   number in a support conversation; a Paystack reference string
   doesn't.

The sequence number is the row's own id, not a per-year counter that
resets to `000001` every January — see
`backend/utils/purchaseReference.ts`'s comment for why (an honest
tradeoff: it stays strictly increasing and free of any race condition,
at the cost of the year prefix not literally meaning "the Nth purchase
of that year").

This supersedes the reference shape `docs/paystack-integration.md`
originally proposed (`RWL-{slug}-{timestamp}-{random}`, written before
`purchase_sessions` existed) — see that document's own updated note.

## Payment provider abstraction

`backend/services/payments/types.ts` defines one `PaymentProvider`
interface:

```ts
interface PaymentProvider {
  createCheckoutSession(request, env): Promise<CreateCheckoutSessionResult>;
  verifyPayment(reference, env): Promise<VerifyPaymentResult>;
  refundPayment(reference, env): Promise<RefundResult>;
}
```

`commerceService.ts` depends only on this interface — never on
Paystack's API shape directly. `backend/services/payments/index.ts`
selects an implementation by `env.PAYMENT_PROVIDER` (today, only
`"paystack"` — `paystackProvider.ts`). Adding a second provider, or
swapping providers in a specific region, means adding one more file in
that folder and one more `case` in the selector — `commerceService.ts`
and `routes/checkout.ts` never change.

**Only `createCheckoutSession()` is implemented this sprint.**
`verifyPayment()` and `refundPayment()` are fully typed
(`VerifyPaymentResult`, `RefundResult`) and both throw a clear
"not implemented — see Sprint 2.4" error if ever called — they exist
now so Sprint 2.4 and a future refunds sprint *implement* a method
already wired into the interface, rather than redesigning the
abstraction around whatever they turn out to need.

### Reconciling with `docs/paystack-integration.md`

That document, written in an earlier sprint before this one's brief
existed, recommended Paystack's **Inline/Popup** flow (client-side
JS opens a payment popup; only the *verification* step needs a
server). This sprint's required architecture — "Worker → Commerce
Service → Payment Provider → return checkout URL → redirect visitor"
— is Paystack's **Standard/Redirect** flow by definition: a server
call (`POST /transaction/initialize`) returns an `authorization_url`
the visitor is redirected to. The two aren't compatible; this sprint's
explicit brief settles it in favor of Standard/Redirect.
`docs/paystack-integration.md` has been updated with a note pointing
here rather than rewritten — its reasoning about verification,
webhooks, and reference generation still stands and remains the plan
for Sprint 2.4.

## Product validation

`productCatalogService.ts`'s `isPurchasable()` is a single whitelist
check: `status === "active"` **and** a real positive price **and** a
real currency. Every non-active status — `draft`, `archived`,
`coming-soon`, and any future status value the catalog ever adds (the
brief's "hidden"/"discontinued" among them) — is rejected by the same
one check, not by enumerating each rejected case individually. A free
product (`price === 0`) is also rejected here: checkout is for paid
purchases only; free content already has its own delivery path (the
lead-magnet flow), not this one.

## Pricing

The frontend sends exactly one field: `{ productId: "<slug>" }`.
Never price, never currency, never title. The Worker loads all three
itself, from `content/products/{slug}.json`, inside
`productCatalogService.ts` — the same file that already validates the
product exists and is purchasable. This is not merely a convenience:
it is the whole reason a client-supplied price can never reach a
payment provider. See "Security" below.

The one currency conversion in this codebase — display price (e.g.
`39`, meaning GH₵39) to Paystack's subunit format (`3900` pesewas) —
happens in exactly one place, `commerceService.ts`'s
`createCheckoutSession()`, immediately before the amount is handed to
the provider. `docs/paystack-integration.md` already flagged this
conversion as an easy, high-consequence mistake to make twice in two
places; isolating it here means it can only be gotten right or wrong
once.

## Frontend

`js/components/buy-button.js` — the only file on the site that starts
a purchase. On click:

1. Guards against a double-click (checks `.btn--disabled`, since the
   Buy CTA is an `<a class="btn">` matching every other CTA on this
   site — `<a>` has no native `disabled` property, so "disabled" is
   the existing `.btn--disabled` class from `css/components.css`,
   plus this explicit guard for keyboard activation).
2. Shows a loading state (`Processing…`, `aria-busy="true"`).
3. `POST`s `{ productId }` to the Worker.
4. On success, redirects immediately (`window.location.href = checkoutUrl`)
   — deliberately stays disabled through the redirect rather than
   re-enabling, so a visitor can't double-click Buy while navigation
   is already underway.
5. On failure, shows a friendly, retryable error message next to the
   button and re-enables it.

Failure handling matches `newsletter-form.js`'s established pattern:

| Failure | What the visitor sees |
|---|---|
| Unavailable/unknown product | The Worker's own friendly `CommerceError` message (e.g. "This product isn't available for purchase right now.") |
| Network/CORS failure | "Could not reach the server. Please check your connection and try again." — `fetch()`'s own `TypeError` message ("Failed to fetch") is never shown; it's a browser-internal string, not visitor-facing |
| Server error (Paystack unreachable, misconfigured, etc.) | The Worker's standard `INTERNAL_ERROR`/`PAYSTACK_API_ERROR` envelope message — never a raw exception or stack trace |

Wired live this sprint on the one real product detail page
(`books/starting-to-invest-with-gh100/index.html`) — its previous
`data-placeholder-action` Buy CTA is now `data-buy-button
data-product-slug="starting-to-invest-with-gh100"`. Its supporting
copy ("Secure checkout via SkillsPad") is also fixed to say
"Secure checkout via Paystack" — a stale reference flagged back in
`docs/commerce-architecture.md`'s Phase 1 audit and explicitly
deferred until "Paystack is actually wired up," which this sprint
does. `js/components/placeholder-action.js` is no longer included on
that page — the Buy CTA was its only user there.

## Security

**Price/product manipulation.** Impossible by construction, not by
validation-after-the-fact: the request body has no price or currency
field for a client to tamper with in the first place. Even a
maliciously crafted request can only ever supply a `productId`; every
number that reaches Paystack is looked up server-side from
`content/products/{slug}.json`.

**Unpublished/hidden products.** `isPurchasable()`'s whitelist
(`status === "active"` only) means a `draft` product can never be
bought even if its slug is known or guessed — there's no "everything
except these statuses" list to accidentally miss a new status value
the catalog adds later.

**Currency tampering.** Same mechanism as price: currency comes from
the Product Platform, never the request.

**Information disclosure through error messages.** A request for an
unknown slug and a request for a real-but-`draft` slug return
*different* error codes (`PRODUCT_NOT_FOUND` vs. `PRODUCT_NOT_ACTIVE`)
but the same *style* of generic, non-specific message — neither
confirms internal state (e.g. "this exists but isn't active yet")
beyond what's necessary. `CommerceError`'s message is always
visitor-safe by construction: `routes/checkout.ts` returns it as-is,
and any error that isn't a `CommerceError` falls through to the
Worker's existing top-level handler
(`middleware/errorHandler.ts`), which already guarantees a generic
`"Something went wrong on our end. Reference: {requestId}"` message —
never a raw exception or stack trace, matching every other endpoint on
this Worker.

**Rate limiting.** `POST /api/checkout/sessions` is rate-limited like
every other endpoint (`middleware/rateLimit.ts`, KV-backed, per-IP),
at 10 requests/minute — slightly more generous than the form endpoints
(5/minute) since a visitor retrying checkout after a declined card or
a closed tab is a legitimate repeat action, not abuse.

**Slug injection.** `productCatalogService.ts`'s `isPlausibleSlug()`
whitelists the exact slug shape used everywhere else on this site
(lowercase alphanumeric + hyphens) before any fetch happens — an
implausible value never reaches a network call, let alone a file path.

**No email is trusted from the client, ever — including later.**
Paystack's `POST /transaction/initialize` requires an `email` field,
but this sprint's frontend collects none (per the brief's "frontend
sends only productId" constraint). `paystackProvider.ts` passes a
synthetic placeholder scoped to the purchase reference
(`checkout+{purchaseReference}@robayerwealthlab.com`) instead of
inventing a collection step. Paystack's own hosted checkout page
prompts the buyer for their real email during payment. Sprint 2.4 then
reads the buyer's real, **provider-confirmed** email back from the
verify response — this is a stricter posture than collecting an email
client-side and trusting it, not a workaround: the first time this
project ever records a "real" customer email, it will already have
been confirmed by the payment provider itself.

## Configuration

Five environment variables, all declared in `backend/worker/env.ts`:

| Variable | Secret? | Where | Purpose |
|---|---|---|---|
| `SITE_BASE_URL` | No | `wrangler.jsonc` `vars` | Where `content/products/*.json` is publicly served — see "Where product data comes from" |
| `PAYMENT_PROVIDER` | No | `wrangler.jsonc` `vars` | Selects a `services/payments/` implementation (`"paystack"` today) |
| `PAYSTACK_BASE_URL` | No | `wrangler.jsonc` `vars` | e.g. `https://api.paystack.co` — configurable rather than hardcoded |
| `PAYSTACK_SECRET_KEY` | **Yes** | `wrangler secret put` / `.dev.vars` (local) | Server-side Paystack API calls — never sent to or readable by the frontend |
| `PAYSTACK_PUBLIC_KEY` | No, but unset | Reserved | Unused by `createCheckoutSession()` today (Standard/Redirect needs only the secret key); reserved for a possible future client-side integration |

No real Paystack account exists yet — `PAYSTACK_SECRET_KEY` and
`PAYSTACK_PUBLIC_KEY` have no real values anywhere in this repository,
committed or not, matching every prior sprint's secret-handling
discipline (`backend/config/README.md`). `backend/.dev.vars.example`
documents the shape a local developer's own `.dev.vars` needs, never a
real key.

## Deployment gate — do not deploy with a live Paystack key yet

Worth stating plainly, since it's the one way this sprint's code could
cause real harm if handled carelessly: **this Worker must not be
deployed with a real, live-mode `PAYSTACK_SECRET_KEY` until Sprint 2.4
(verification) and Sprint 2.5 (delivery) exist.** This sprint can
successfully redirect a visitor to a real Paystack payment page and
take real money — but nothing in this codebase yet confirms that
payment happened, records who paid, or delivers anything. A live
deployment today would risk a real buyer paying with no way for this
project to know, let alone fulfill it. This sprint's own validation
(see below) was deliberately run against the *undeployed* state for
exactly this reason — see "Deferred work."

**Updated — Sprint 2.4:** verification now exists (a payment can be
confirmed and recorded as `'verified'`), but the gate still holds —
Sprint 2.5 (delivery) doesn't exist yet, so a verified purchase still
has no way to receive its product. Do not deploy with a real Paystack
key until Sprint 2.5 exists too. See `docs/payment-verification.md`'s
own "Deferred work" for the current, up-to-date status.

## Configuration & docs cross-links

- `docs/paystack-integration.md` — updated with a note pointing to
  this document's "Reconciling" section (Standard/Redirect supersedes
  the original Inline/Popup recommendation); its verification/webhook/
  reference-generation reasoning otherwise stands unchanged for
  Sprint 2.4.
- `docs/worker-api-design.md` — gains a `POST /api/checkout/sessions`
  entry; the pre-existing `POST /api/orders` design is annotated as
  superseded by this sprint's shape (no email required upfront, no
  D1 `products` dependency).
- `docs/commerce-architecture.md` — the "SkillsPad" finding from its
  Phase 1 audit is annotated as resolved this sprint.
- `docs/backend-security.md` — gains a short "Checkout session
  creation" section cross-referencing this document's "Security"
  section above, rather than duplicating it.
- `docs/database-design.md` — gains a `purchase_sessions` table-by-
  table entry, matching this document's "Purchase session" section.
- `backend/services/README.md`, `backend/routes/README.md`,
  `backend/config/README.md`, `backend/worker/README.md` — status
  tables updated to mark `commerceService.ts`, `productCatalogService.ts`,
  `services/payments/`, `routes/checkout.ts`, and the new environment
  variables as implemented.

## Verification — implemented in Sprint 2.4

**Done.** See `docs/payment-verification.md` and
`docs/payment-lifecycle.md` for the full architecture:
`paystackProvider.verifyPayment()` calls Paystack's own
`GET /transaction/verify/:reference`; the Paystack webhook
(`charge.success`/`charge.failed`), not the browser's post-redirect
callback, is the authoritative trigger; `purchase_sessions.status`
becomes `'verified'` (renamed from the `'paid'` this document
originally sketched) only after status/amount/currency/metadata/
product-validity all cross-check against the values locked at checkout
time. Two-layer idempotency (a `payment_transactions.paystack_reference
UNIQUE` ledger, plus a status-gated conditional `UPDATE` on
`purchase_sessions` itself) prevents a retried webhook from
double-processing — see `docs/payment-verification.md`'s
"Idempotency" for the full reasoning, superseding this section's
original one-line mention.

## Delivery — implemented in Sprint 2.5

**Done.** See `docs/digital-fulfilment.md` for the full architecture —
a Worker-mediated, signed, single-use download token, exactly as
already designed in `docs/download-security.md` and
`docs/storage-strategy.md`. The `deliveries` table (not `downloads`,
which was deprecated in the same pass — see
`backend/database/schema.sql`) is the real entitlement record,
created once `commerceService.ts` marks a session `'verified'`
(Sprint 2.4's renamed status, superseding this document's original
`'paid'` wording).

## Future refunds

Not designed in depth yet. `paystackProvider.refundPayment()` is
typed and stubbed (`RefundResult` with `'refunded' | 'failed' |
'pending'`) so a future sprint implements Paystack's refund endpoint
against it without changing the `PaymentProvider` interface. Expected
shape: admin-triggered only (via the future admin dashboard,
`docs/admin-module.md`), never self-service, updating both the
`purchase_sessions`/order status and (once it exists) revoking any
outstanding `download_tokens` for that purchase.

## Architecture review — Sprint 2.3 freeze audit

*(Added post-implementation, before freezing the sprint. Review only —
no redesign, no verification, no delivery code added here. Findings
below are recommendations for Sprint 2.4+ or optional near-term
follow-ups, not implemented in this pass.)*

### Purchase session lifecycle — state model

`purchase_sessions.status` allows five values:
`pending | paid | failed | abandoned | expired`. What this sprint's
code actually exercises today:

```
(INSERT, purchase_reference = NULL) → pending
        ↓ (reference assigned via UPDATE, still pending)
pending → failed      [provider.createCheckoutSession() throws — see commerceService.ts's catch block]
pending → (stays pending, checkout_url/provider_reference attached)  [provider call succeeds]
```

**`paid`, `abandoned`, and `expired` are declared in the schema but
unreachable by any code path this sprint.** This is intentional
forward-provisioning, not an oversight — worth confirming explicitly
rather than leaving implicit:

- `paid` is Sprint 2.4's transition, by design (this sprint never
  verifies payment).
- `abandoned` mirrors Paystack's own transaction-status vocabulary
  (the same convention `payment_transactions.status` already uses in
  `docs/database-design.md`) — it's reserved for when Sprint 2.4's
  verify call reports a transaction Paystack itself considers
  abandoned (buyer opened checkout, never completed it), which is
  different from `failed` (our own `initialize` call error, exercised
  today) or a payment Paystack reports as declined.
- `expired` is this project's own TTL concept for a `pending` session
  nobody — not even Paystack — ever reported back on at all.

**Finding:** nothing currently *reads* `expires_at` to enforce it —
it's write-only data today (set on insert, never checked). This isn't
a defect for this sprint (expiration enforcement is inherently a
verification-time concern), but it means "expiration" is currently a
stored deadline with no enforcement behind it. **Recommendation for
Sprint 2.4:** enforce lazily, not via a scheduled sweep — when
`POST /api/payments/verify` (or the future webhook handler) looks up a
`purchase_sessions` row by reference, check `status = 'pending' AND
now() > expires_at` first and treat it as `expired` before proceeding,
rather than running a periodic Cron Trigger job. This needs no new
infrastructure (the project has none today — see
`docs/monitoring-and-alerting.md`) and is the only point that actually
needs to make an expiration decision. A periodic sweep remains a
reasonable *optional* addition later, purely for admin-dashboard
reporting accuracy (an honest "how many sessions expired" count
without waiting for a verify attempt that may never come) — not
required for correctness.

**Finding, retry behavior:** a failed `createCheckoutSession()` call
leaves that session permanently `failed`; clicking Buy again creates
an entirely new row with a new reference, never retries or reuses the
failed one. This is intentional and correct — each attempt is its own
auditable record — but worth stating explicitly: there is no
"resume/retry the same session" path anywhere in this design, only
"start a new one."

### Idempotency — duplicate checkout requests

**No server-side idempotency mechanism exists today.** What actually
bounds duplicates:

- **Client-side double-click guard** (`buy-button.js`'s
  `.btn--disabled` check) — prevents the most common case, an
  impatient repeated click on the same rendered button.
- **Per-IP rate limiting** (10 requests/minute) — bounds volume, but
  10 real Paystack `initialize` calls in a minute from one IP are all
  still allowed and all still create distinct sessions.
- **Nothing else.** Two browser tabs, a page reload followed by a
  second click, or two legitimate retries after a transient error each
  create a brand-new `purchase_sessions` row, a brand-new reference,
  and a brand-new real call to Paystack's `initialize` endpoint. The
  `purchase_reference` `UNIQUE` constraint protects against a coding
  bug producing two identical references — it does nothing to prevent
  two *different*, both-valid references representing the same
  purchase intent.

**Why this is lower-risk than it sounds, today:** this project
collects no visitor identity (no cookies, no accounts, no session) —
true idempotency ("has this exact visitor already started buying this
product?") isn't achievable without adding some form of client-side
tracking, which this project has consistently avoided elsewhere
(`docs/authentication-strategy.md`'s customer-facing scope is
explicitly "none"). The realistic worst case is a confused visitor
completing two payments for one product in two tabs — a business/UX
problem needing a manual refund, not a security hole; the refund path
is already a planned extension point ("Future refunds" above).

**Recommendation:** if duplicate-charge reports become a real,
observed problem (not hypothetical), the cleanest fix compatible with
this architecture is a client-generated idempotency key: the frontend
generates and persists a token (e.g. in `sessionStorage`, scoped per
product) the first time Buy is clicked, and resends the same token on
any retry; the Worker looks up an existing non-expired `pending`
session by that token before creating a new one. This is additive (a
new optional request field, not a redesign) but is a wire-contract
change — deliberately not built now, and not urgent given the current
single-product catalog and low traffic.

### Purchase session expiration

30 minutes (`PURCHASE_SESSION_TTL_MINUTES` in `commerceService.ts`).
Confirmed reasonable as a *starting* value — long enough for a
genuinely distracted checkout, short enough that a resumed stale
session doesn't sit around confusingly for hours — but, as noted
above, not derived from any specific Paystack session-lifetime
behavior (no such constraint is documented in
`docs/paystack-integration.md`, and this project has no live Paystack
account to observe real behavior against). **Recommendation:** keep 30
minutes; revisit only once real checkout sessions can be observed.
Enforcement recommendation is covered above (lazy check at
verification time).

### Paystack metadata

**Confirmed what's sent today** (`paystackProvider.ts`'s
`createCheckoutSession()`):

```json
{
  "purchaseReference": "RWL-2026-000001",
  "custom_fields": [
    { "display_name": "Product", "variable_name": "product", "value": "Starting to Invest with GH₵100" }
  ]
}
```

Plus, at the top level of the `/transaction/initialize` request
(not inside `metadata`, but worth restating since it's what Sprint 2.4
actually verifies against): `amount`, `currency`, and `reference` —
these are Paystack's own authoritative fields, checked directly by a
future verify call per `docs/paystack-integration.md`, not read back
out of `metadata`.

**Finding — one gap versus the original plan:** `docs/paystack-integration.md`'s
original metadata shape (written before this sprint) included
`productSlug` and `sku` at the top level of `metadata`; the
implemented version only includes `purchaseReference` and the
`custom_fields` display entry. **Recommendation:** add `productSlug`
to the top-level `metadata` object. It costs nothing, makes Paystack's
own dashboard searchable/filterable by product without cross-
referencing this project's database, and gives Sprint 2.4 an optional
tamper-evidence cross-check (comparing `metadata.productSlug` echoed
back on verify against `purchase_sessions.product_slug` for the same
reference — not the primary defense, which remains the D1 lookup by
`purchaseReference` itself, but a free additional signal). `sku` is a
lower-priority nice-to-have — `productCatalogService.ts`'s
`CatalogProduct` doesn't currently parse a `sku` field at all, so
adding it would need that type extended first; worth doing only if the
`productSlug` addition alone proves insufficient for support/dashboard
needs. **Not implemented in this review pass** — a one-line,
low-risk follow-up, not a blocker.

### Customer email strategy — re-evaluated

The current design (a synthetic `checkout+{purchaseReference}@robayerwealthlab.com`
placeholder sent to Paystack's `initialize` call, real email deferred
to Sprint 2.4's provider-confirmed verify response) is **directionally
correct and should stay the security baseline**: never grant or record
a purchase's identity from anything the client supplied before
payment. That principle doesn't change.

What's worth re-evaluating is the *UX* cost, which depends on
Paystack behavior this project has never observed (no live account
exists — see "Known limitations"): if Paystack's hosted checkout page
locks a pre-filled email rather than letting the buyer edit it, the
buyer never receives Paystack's own automated receipt at a real
address (this project's own logic is unaffected either way, since it
never reads that inbox — only Sprint 2.4's verify response). Genuinely
unverified which behavior Paystack exhibits; flagged, not assumed.

**Recommended production design, for Sprint 2.4 or a dedicated
follow-up (not this review):**

1. Extend the checkout-session request with one *optional* field:
   `{ productId, email? }`. This does not violate the "never send
   price/currency/title" rule — an email is contact information, the
   same category of input `newsletter`/`contact`/`consultation` already
   collect, not a pricing input.
2. If provided, pass the real email to Paystack's `initialize` call
   instead of the placeholder, and store it on the existing (currently
   unused) `purchase_sessions.customer_email` column — but label it
   **provisional/unverified** in the schema comment, since it hasn't
   been confirmed by anyone but the buyer's own browser yet.
3. If omitted, fall back to today's placeholder exactly as now — never
   block or add friction to checkout for skipping it.
4. Regardless of what was collected pre-payment, Sprint 2.4's
   verification step **always overwrites** `customer_email` with
   Paystack's own confirmed `customer.email` from the verify response.
   The pre-payment value is a UX nicety only, never treated as the
   final record of who paid.

This is additive and compatible with the current schema
(`purchase_sessions.customer_email` already exists for exactly this)
— no redesign required, and it preserves the one property that
actually matters: this project never attributes a purchase to an email
address that wasn't confirmed by the payment provider itself.

### Security — trust boundary confirmation

Traced the full request path end to end for this review:
`routes/checkout.ts` → `commerceService.ts` → `productCatalogService.ts`
→ `paystackProvider.ts`.

- **Confirmed:** the request body is only ever destructured for
  `productId` (`checkout.ts`); no other field is read, parsed, or
  forwarded from client input at any point in the call chain.
- **Confirmed:** price, currency, product title, and purchasability
  are exclusively sourced from `fetchCatalogProduct()`'s server-side
  fetch of `content/products/{slug}.json` — there is no code path,
  intentional or accidental, where a client-supplied value reaches
  `amountPesewas`, `currency`, or the `isPurchasable()` check. This is
  structural (no field exists to carry a client price), not merely
  validated after the fact.
- **Confirmed:** `productId` is regex-validated
  (`isPlausibleSlug` — `^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$`) before
  it reaches a `fetch()` call at all — no path-traversal or SSRF
  surface (can't contain `/`, `..`, `:`, or a host component), and the
  fetch target is always `${SITE_BASE_URL}/content/products/{slug}.json`,
  a server-controlled base with only the validated slug appended.
- **Confirmed:** `callback_url` sent to Paystack is built entirely
  from `env.SITE_BASE_URL` (server config) and the server-generated
  `purchaseReference` — no client input flows into it, so there's no
  open-redirect surface via this field.
- **Confirmed (live-tested this session, not just reasoned about):**
  CORS is enforced uniformly — a request from an origin outside
  `ALLOWED_ORIGIN` fails at the browser level before any response body
  is even readable, verified empirically when `buy-button.js`'s
  request from the local preview origin was correctly blocked.
- **Noted, accepted, not mitigated:** a request for an unknown slug
  and a request for a real-but-inactive slug take a very slightly
  different code path (`fetchCatalogProduct` returns `null` sooner for
  a 404 than a full fetch+parse for a real file), a theoretical timing
  side-channel for slug enumeration. Severity is negligible at this
  project's threat model (product slugs are not secret — they're
  public URLs on `/books/{slug}/`) and is not worth mitigating.

**No finding here changes the freeze recommendation** — the
security-critical property (frontend cannot influence price, currency,
or product status) holds structurally, confirmed by tracing the code,
not merely asserted.

## Validation performed

- **Typecheck:** `cd backend && npm run typecheck` (`tsc --noEmit`)
  passes cleanly against every new and modified file — `env.ts`,
  `services/payments/*.ts`, `services/productCatalogService.ts`,
  `services/commerceService.ts`, `routes/checkout.ts`,
  `worker/index.ts`, `utils/purchaseReference.ts`,
  `types/entities.ts`. Re-run after the freeze audit above (which
  changed only this document) — still clean, confirming the review
  introduced no code drift.
- **Worker routes compile:** the new route is registered in
  `worker/index.ts`'s `ROUTES` array alongside the three existing
  endpoints, using the same `URLPattern` dispatch — no new dependency,
  no router change.
- **Homepage, Books page, product page, Newsletter, Lead Magnet:**
  live-browser-verified with zero console errors and zero unrelated
  network failures — this sprint touched only the one detail page's
  Buy CTA and script tags; every other page is unmodified since
  Sprint 2.2's own validation pass.
- **Buy button, end to end:** live-verified on
  `books/starting-to-invest-with-gh100/index.html`. Clicking Buy
  correctly disables the button, shows "Processing…", and sends
  `POST https://robayer-wealthlab-api.robayerwealthlab.workers.dev/api/checkout/sessions`
  with body `{"productId":"starting-to-invest-with-gh100"}`. Since
  this sprint's Worker code is explicitly **not deployed** (per the
  brief) and the currently-*deployed* Worker predates this route, the
  request correctly fails at the network/CORS level (the local preview
  origin also isn't in the deployed Worker's `ALLOWED_ORIGIN`) — and
  `buy-button.js` handles this exactly as designed: shows "Could not
  reach the server. Please check your connection and try again.",
  re-enables the button, and leaves the page otherwise unaffected. No
  real request reached Paystack; no `purchase_sessions` row was
  created (the checkout logic itself never ran, since the deployed
  Worker 404s/CORS-blocks before reaching it). This is the correct,
  honest state for an undeployed sprint.
- **Broken links:** no new page routes were added (the "thank you"
  page Sprint 2.4 will build at `/checkout/callback/` does not exist
  yet and nothing currently links to it except the `callback_url`
  passed to Paystack, which is never dereferenced this sprint since no
  checkout can actually complete without real credentials).

## Extension points

| Future need | Where it plugs in |
|---|---|
| A second payment provider | New file in `backend/services/payments/`, one new `case` in that folder's `index.ts` selector |
| Payment verification | `paystackProvider.verifyPayment()` gets a real implementation; a new `routes/payments.ts` calls it |
| Webhooks | A new route (e.g. `POST /api/webhooks/paystack`), signature-verified per `docs/backend-security.md`, calling the same verification logic idempotently |
| Refunds | `paystackProvider.refundPayment()` gets a real implementation; admin-triggered per `docs/admin-module.md` |
| Order/customer records | Sprint 2.4 decides how `purchase_sessions` relates to the pre-existing `orders`/`customers` design — see "Purchase session" above |
| Secure delivery | Sprint 2.5 builds on a `'paid'` `purchase_sessions` row, per `docs/download-security.md` |

## Deferred work (Sprint 2.4+)

- Payment verification, webhooks, receipts, customer dashboard,
  downloads, refunds — all explicitly out of this sprint's scope per
  the brief.
- Deployment of this sprint's Worker changes — explicitly not done
  per the brief, and additionally gated (see "Deployment gate" above)
  on Sprint 2.4/2.5 existing first.
- Resolving `purchase_sessions` vs. the pre-existing `orders`/
  `customers`/`products` D1 tables — flagged, not resolved (see
  "Purchase session").
- A real `/checkout/callback/` page for Paystack to redirect back to
  after payment — Sprint 2.4's job, since that page's entire purpose
  is showing the *result* of verification, which doesn't exist yet.

## Known limitations

- `PAYSTACK_SECRET_KEY`/`PAYSTACK_PUBLIC_KEY` have no real values —
  no Paystack account has been created for this project (consistent
  with every prior sprint touching Paystack). `createCheckoutSession()`
  is architecturally complete but has never been exercised against a
  real Paystack API response; its request/response shapes are built
  from Paystack's public API documentation, not from a live test.
- The synthetic placeholder email
  (`checkout+{purchaseReference}@robayerwealthlab.com`) sent to
  Paystack's initialize call is untested against Paystack's actual
  checkout-page behavior — it's unconfirmed whether Paystack's hosted
  page lets a buyer overwrite a pre-filled placeholder address or
  locks it. If the latter, Sprint 2.4 (or an earlier follow-up) needs
  a real email-collection step before redirect; documented here as an
  open question, not a settled design.
- `purchase_sessions.expires_at` (30 minutes) is a reasonable starting
  value, not derived from any Paystack-specific session-expiry
  behavior — worth revisiting once real checkout sessions can be
  observed.
- No server-side idempotency mechanism — duplicate purchase intent
  (multi-tab, retry-after-error) produces multiple valid sessions/
  references rather than being deduplicated. See the freeze audit's
  "Idempotency" section above for the full risk assessment and a
  recommended client-idempotency-key design, not implemented.
- Paystack `metadata` omits `productSlug` (present in the original
  plan, absent from the implementation) — see the freeze audit's
  "Paystack metadata" section above; a low-risk, one-line follow-up.
- `expires_at` is stored but not yet enforced anywhere (no code reads
  it) — see the freeze audit's "Purchase session lifecycle" section
  above for the recommended lazy-enforcement-at-verification design.
