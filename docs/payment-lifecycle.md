# Payment Lifecycle — Architecture Diagram

A single-page map of how a purchase moves through Robayer WealthLab,
end to end, across every commerce sprint. Written for a new developer
who needs the whole picture before diving into any one sprint's own
detailed doc.

## The full lifecycle

```
Visitor
  │
  ▼
Buy Button                              js/components/buy-button.js
  │  POST { productId } — nothing else               (Sprint 2.3)
  ▼
Checkout Session                        POST /api/checkout/sessions
  │  Worker validates product, locks               (Sprint 2.3)
  │  price/currency/id/version, creates
  │  a purchase_sessions row (status: pending)
  │  and an internal reference (RWL-2026-000001)
  ▼
Hosted Payment                          Paystack's own checkout page
  │  Visitor pays. Robayer WealthLab's                (external)
  │  Worker is not involved in this step at all.
  ▼
Paystack
  │  Sends a signed webhook to this project's
  │  Worker — this is the ONLY step that
  │  triggers anything on Robayer WealthLab's side.
  ▼
Webhook                                 POST /api/webhooks/paystack
  │  Signature verified. Payload shape-checked.        (Sprint 2.4)
  ▼
Verification                            commerceService.ts
  │  Idempotency check (has this webhook             (Sprint 2.4)
  │  already been processed?)
  │  → session lookup, expiry check
  │  → provider.verifyPayment() — the ONLY
  │    trusted confirmation, a fresh authenticated
  │    call to Paystack, never the webhook body itself
  │  → amount / currency / metadata / product-validity
  │    all cross-checked against LOCKED checkout-time values
  ▼
Verified Purchase                       purchase_sessions.status = 'verified'
  │  The one fact Sprint 2.5 is allowed to act on.    (Sprint 2.4)
  ▼
Delivery                                Sprint 2.5 — not built yet
  │  Signed, single-use download token
  │  (docs/download-security.md's already-designed flow)
  ▼
Receipt                                 Not built yet
  │  Purchase-confirmation email
  ▼
Customer Dashboard                      Not built yet
     "check my order status" without an account —
     docs/worker-api-design.md's GET /api/orders/:id shape
```

## What exists today, sprint by sprint

| Stage | Built in | Status |
|---|---|---|
| Buy Button | Sprint 2.3 | ✅ Live on the one real product page |
| Checkout Session | Sprint 2.3 | ✅ `POST /api/checkout/sessions` |
| Hosted Payment | (Paystack, external) | Not testable — no live Paystack account |
| Webhook | Sprint 2.4 | ✅ `POST /api/webhooks/paystack` |
| Verification | Sprint 2.4 | ✅ `commerceService.handlePaymentWebhook()` |
| Verified Purchase | Sprint 2.4 | ✅ `purchase_sessions.status = 'verified'` |
| Delivery | Sprint 2.5 | ⬜ Not started |
| Receipt | Sprint 2.5 or later | ⬜ Not started |
| Customer Dashboard | A later sprint | ⬜ Not started |

## The trust boundary, drawn explicitly

Everything to the left of this line is untrusted input. Everything to
the right is either server-computed or provider-confirmed.

```
 UNTRUSTED                          │  TRUSTED
 ─────────────────────────────────  │  ──────────────────────────────
 Browser redirect back to the site  │  A signed webhook body
 A query parameter on that redirect │  (proves origin, not business truth)
 localStorage / JavaScript state    │
 The webhook payload's own          │  provider.verifyPayment()'s response
   data.status / data.amount /      │  (a fresh, separately-authenticated
   data.currency / data.metadata    │  call — THE actual source of truth)
 Anything the frontend ever sends   │  content/products/{slug}.json
   beyond a bare productId          │  (server-fetched, never client-supplied)
```

**One sentence version:** the browser can tell the Worker *that
something happened*; only Paystack's own verify endpoint can tell the
Worker *what actually happened*.

## Where each sprint's documentation lives

| Topic | Document |
|---|---|
| Checkout session creation, payment provider abstraction, internal purchase references, why `purchase_sessions` exists | `docs/commerce-foundation.md` |
| Webhook verification, idempotency, replay protection, the full purchase state machine, metadata verification | `docs/payment-verification.md` |
| Paystack API research (verification call shape, currency subunits, webhook signing) | `docs/paystack-integration.md` |
| Download security design (Sprint 2.5's future flow) | `docs/download-security.md` |
| D1 schema, table by table | `docs/database-design.md` |

## One question, answered once

Every future sprint that needs to know "was this purchase real?" asks
exactly one function, built in Sprint 2.4, never re-implemented:

```ts
const status = await getPurchaseVerificationStatus(env, purchaseReference);
if (status?.verified) {
  // Sprint 2.5: proceed.
} else {
  // Absolutely nothing is delivered.
}
```

No future sprint should ever read `purchase_sessions.status` directly
and re-derive what "verified" means — that logic lives in exactly one
place, `commerceService.ts`, so it can only ever be gotten right or
wrong once.
