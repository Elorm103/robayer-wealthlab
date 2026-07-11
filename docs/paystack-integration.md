# Paystack Integration Planning (Phase 7)

**Status: research and planning only. No Paystack SDK, keys, or
payment code exist anywhere in this repository.** This document
records how Paystack's own recommended architecture maps onto this
project's static-site constraints, so that Sprint 2 (or whichever
sprint actually implements payments) starts from a reasoned plan.

**Updated — Version 1.2 Sprint 2.3 (Commerce Foundation):**
checkout session creation is now implemented — see
`docs/commerce-foundation.md`. That sprint's required architecture
("Worker → Commerce Service → Payment Provider → return checkout URL
→ redirect visitor") is Paystack's **Standard/Redirect** flow, which
**supersedes this document's "Recommendation: Inline/Popup"** below —
see `docs/commerce-foundation.md`'s "Reconciling with
docs/paystack-integration.md" section for the full reasoning. Every
other section here (verification, webhooks, reference generation as
background, currency/subunits) still reflects the current plan for
Sprint 2.4; only the checkout-initiation method changed.

## The one unavoidable constraint

GitHub Pages cannot run server-side code. Paystack's transaction
**verification** step requires a secret key, which must never be
exposed to a browser (anyone viewing page source could steal it and
forge "successful" payments). This means **some piece of this
integration cannot live inside this static site**, no matter which
Paystack checkout method is used. That piece is scoped as small as
possible below, and its hosting choice is deliberately left as a
Sprint 2+ decision (see "What this document does not decide").

## Two ways to start a Paystack transaction — and which fits this project

Paystack supports two integration styles:

1. **Inline/Popup (client-side initiation).** A page loads Paystack's
   `inline.js`, and JavaScript opens a payment popup directly using
   the *public* key, the amount, the buyer's email, and `metadata` —
   no server call needed to *start* the transaction. Paystack returns
   a reference and an `onSuccess` callback in the browser once the
   popup completes.
2. **Standard/Redirect (server-side initiation).** A server calls
   Paystack's `POST /transaction/initialize` endpoint first (this
   requires the *secret* key), gets back an authorization URL, and
   redirects the buyer there; Paystack later redirects back to a
   callback URL.

**Recommendation: Inline/Popup.** It avoids needing a server-side call
just to *start* a purchase — the only server-side (serverless) piece
this project needs is the **verification** step, which is unavoidable
either way. This keeps the non-static surface area as small as
possible: one function, not two.

## Why the client-side "success" callback is never enough on its own

Inline.js's `onSuccess` callback fires in the buyer's own browser —
which means, in principle, a malicious visitor could fabricate that
callback without ever paying (e.g., by manipulating client-side JS).
**The download must never be granted directly from that callback.**
The callback's only job is to tell the page "show a
'verifying your payment…' state and pass this reference to the
verification step" — matching the same principle already established
in `docs/download-security.md`.

## Reference generation

**Updated — Sprint 2.3: implemented with a different shape than
originally proposed below.** See `docs/commerce-foundation.md`'s
"Internal purchase reference" — the actual format is
`RWL-{year}-{6-digit sequence}` (e.g. `RWL-2026-000001`), generated in
`backend/utils/purchaseReference.ts` from the `purchase_sessions`
row's own database id, not the shape below. The *principle* this
section originally argued for — generate our own reference before
ever contacting Paystack, never depend on Paystack's own reference as
the primary identifier — is exactly what was built; only the specific
string format changed.

Paystack can auto-generate a transaction reference, but this project
should generate its own **before** initiating the transaction, then
pass it in explicitly. The shape originally proposed here (kept for
history):

```
RWL-{productSlug}-{unixTimestamp}-{shortRandom}
```

e.g. `RWL-starting-to-invest-with-gh100-1751760000-x7f2`. Generating
the reference ourselves means:

- It can be recorded (e.g., "pending" order state) *before* the popup
  even opens, so a buyer who closes the popup without paying still
  leaves a traceable, matchable record.
- It's human-legible in the Paystack dashboard when investigating a
  support question, unlike an opaque auto-generated ID.

## Metadata — what this project passes to Paystack

Paystack's `metadata` field accepts arbitrary JSON, echoed back on
both the verify response and the webhook payload. Recommended shape,
directly matching `content/products/{slug}.json`'s existing `paystack.metadata`
field (see `content/SCHEMA.md`'s `Product` entry):

```json
{
  "productSlug": "starting-to-invest-with-gh100",
  "category": "ebook",
  "sku": "RWL-EBOOK-001",
  "custom_fields": [
    { "display_name": "Product", "variable_name": "product", "value": "Starting to Invest with GH₵100" }
  ]
}
```

`custom_fields` is a Paystack-specific convention that makes the
purchased item readable directly in the Paystack dashboard's
transaction list, without needing to cross-reference this site's own
records.

## Currency: subunits, not display prices

Paystack amounts are always integers in the smallest currency unit —
**pesewas** for GHS, not whole Cedis. `content/products/{slug}.json`
deliberately stores `price` as a plain display number (e.g. `39` for
GH₵39 — see `content/products/README.md`'s rationale for `price`).
**The multiplication by 100 happens only at the moment of calling
Paystack**, never in content. Getting this conversion backwards is a
well-known, easy mistake (charging GH₵0.39 instead of GH₵39, or
GH₵3,900 instead of GH₵39) — flagged explicitly here so Sprint 2
tests this conversion deliberately rather than assuming it.

## Transaction verification — the authoritative step

**Implemented — Version 1.2 Sprint 2.4.** See
`docs/payment-verification.md` for the full architecture.
`paystackProvider.verifyPayment()` calls:

```
GET {PAYSTACK_BASE_URL}/transaction/verify/:reference
Authorization: Bearer {secret_key}
```

and `commerceService.handlePaymentWebhook()` only proceeds to
`'verified'` if the response confirms exactly what this section
originally specified:

- `status: "success"`
- `amount` matches the expected amount **in pesewas** — checked
  against the value LOCKED on the `purchase_sessions` row at checkout
  time, not re-derived (protects against a tampered client-side amount
  while tolerating a legitimate price change mid-checkout — see
  `docs/payment-verification.md`'s "Verification rules")
- `currency` matches the locked value
- The `reference` matches what this project generated for this
  purchase session

Issuing a signed download URL (`docs/download-security.md`) remains
Sprint 2.5's job — this sprint stops at recording `'verified'`.

## Webhooks — the reliable trigger, not just a backup

**Implemented — Version 1.2 Sprint 2.4.** See
`docs/payment-verification.md`'s "Webhook flow" for the live
implementation. Relying solely on the buyer's browser completing the
checkout flow is fragile: a closed tab, a crashed browser, or a
network drop after payment but before any client-side callback fires
would otherwise mean a buyer paid but never got their download.
Paystack's webhook (`charge.success`, sent as a `POST` to
`/api/webhooks/paystack`, independent of the buyer's browser state) is
the **authoritative** fulfillment trigger — there is no client-side
callback path in this project at all (Standard/Redirect, per
`docs/commerce-foundation.md`, has none to begin with). The two
requirements this section originally called for are both implemented:

1. **The webhook's signature is verified** (`x-paystack-signature`
   header, HMAC-SHA512 of the raw request body,
   `backend/utils/webhookSignature.ts`) before the payload is even
   parsed. One correction from this section's original wording: the
   signature is computed using the account's own **secret key**
   (`PAYSTACK_SECRET_KEY`), not a separate webhook secret — see
   `docs/payment-verification.md`'s "Known limitations" for the
   confidence caveat on this Paystack-specific detail.
2. **Webhook delivery is handled idempotently** — a two-layer design
   (a `payment_transactions.paystack_reference UNIQUE` ledger, plus a
   status-gated conditional update on `purchase_sessions` itself); see
   `docs/payment-verification.md`'s "Idempotency" for the full
   reasoning, which goes further than this section's original
   one-paragraph sketch.

## Callback URL

A callback URL (configured either per-transaction in Inline.js or
globally in the Paystack dashboard) redirects the buyer back to a
"thank you" / order-status page on this site after the popup closes.
Its only job is UX — showing a friendly confirmation state while the
webhook/verification step (which may complete slightly before or after
the redirect) does the actual, authoritative work. It carries no
authority of its own, per the callback-vs-verification distinction
above.

## How this maps onto the existing Product schema

| Paystack concept | Project field |
|---|---|
| Amount (pesewas) | `content/products/{slug}.json`'s `price` × 100, converted at checkout time only |
| Currency | `currency` (`"GHS"`) |
| `metadata` | `paystack.metadata` (already present in the schema — see `content/SCHEMA.md`) |
| Reference | Generated fresh per transaction (see "Reference generation" above), not stored in product content — it's an order-level fact, not a product-level one |
| Fulfillment policy | `downloads.maxPerPurchase` / `downloads.expiresAfterDays` (see `docs/download-security.md`) |

## What this document does not decide

- ~~Where the serverless verification/webhook function actually
  runs~~ — **resolved in Version 1.2 Sprint 2:** a Cloudflare Worker.
  See `docs/cloudflare-architecture.md` and `docs/worker-api-design.md`
  (`POST /api/payments/verify`) for the full design.
- ~~Order/customer record storage~~ — **resolved, revised across
  Sprints 2.3–2.4:** Cloudflare D1, but not the `orders`/`customers`
  tables originally planned here — `purchase_sessions` (Sprint 2.3) is
  this project's real order-equivalent record, and `payment_transactions`
  (Sprint 2.4) now references it directly. `orders`/`customers` are
  deprecated in `backend/database/schema.sql`. See
  `docs/payment-verification.md`'s "Database."
- **Live vs. test API keys, dashboard configuration, or account
  setup** — still an operational step for whoever implements the
  Paystack step of `docs/migration-roadmap.md`, not an architecture
  question.
