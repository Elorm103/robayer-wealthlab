# services/

## Purpose

The business-logic layer, independent of HTTP — the layer `routes/`
calls into, and the only layer that talks to D1, R2, KV, or the
Paystack API directly. This separation means the actual logic (e.g.,
"verify this transaction and issue a download token") can eventually
be unit-tested without spinning up a Worker or a real HTTP request, and
means `routes/` files stay thin and easy to read.

## Planned services (no code yet)

| Service (future) | Responsibility |
|---|---|
| `emailService.ts` ✅ | Sends transactional email (download links, consultation acknowledgements) — likely a thin wrapper around a third-party email API, not a custom mail server (matching `docs/admin-module.md`'s "reuse, don't rebuild" recommendation for the newsletter/consultation form gap) |
| `newsletterService.ts` ✅ | Records/forwards newsletter sign-ups |
| `consultationService.ts` ✅ | Records consultation requests |
| `contactService.ts` ✅ | Records general enquiries into `contact_messages` — added in Sprint 3 alongside that table (`docs/database-design.md`), not in this list originally |
| `commerceService.ts` ✅ | Validates a product, creates a purchase session + internal reference, asks a `payments/` provider to prepare checkout (Sprint 2.3); verifies a webhook-triggered payment end to end and triggers fulfilment (Sprint 2.4/2.5) — see `docs/commerce-foundation.md`, `docs/payment-verification.md`, `docs/digital-fulfilment.md` |
| `productCatalogService.ts` ✅ | Reads/validates a product from `content/products/{slug}.json` (the live Product Platform, not a D1 table) — added in Sprint 2.3, extended Sprint 2.4 with `id`/`version` fields, extended Sprint 2.5 with `digitalAssets`/`downloadPolicy` |
| `payments/` ✅ | Payment provider abstraction (`PaymentProvider` interface + `paystackProvider.ts`). `createCheckoutSession()` (Sprint 2.3) and `verifyPayment()` (Sprint 2.4) implemented; `refundPayment()` remains a documented stub — see `docs/payment-verification.md`'s "Payment provider" |
| `entitlementService.ts` ✅ | Added Sprint 2.5 — "does this purchase grant access to this asset?", mints/redeems download tokens. See `docs/digital-fulfilment.md`'s "Entitlement model" |
| `fulfilmentService.ts` ✅ | Added Sprint 2.5 — grants entitlements (`deliveries` rows) and sends fulfilment emails once a payment verifies. See `docs/digital-fulfilment.md`'s "Fulfilment flow" |
| `adminAuthService.ts` | Session creation/verification for admin login — see `docs/authentication-strategy.md` |
| `auditService.ts` | Writes to the `audit_logs` D1 table whenever another service performs a sensitive action (login, refund, product edit) |

✅ = implemented. `adminAuthService.ts` and `auditService.ts` remain
unimplemented — the admin dashboard, out of scope until that sprint.
`downloadService.ts` (planned as of Sprint 2.3/2.4) never materialized
as its own file — its responsibility split across
`entitlementService.ts` (access decisions, token issuance/redemption)
and `fulfilmentService.ts` (entitlement grants, email), a cleaner split
than one large file once the actual shape of the work was known.
`orderService.ts` (planned as of Sprint 2.3) never materialized as a
separate file — Sprint 2.4 resolved that `purchase_sessions` itself is
the order-equivalent record, so there is no separate reconciliation
step to write a service for. `paystackService.ts` (originally planned
here) also never materialized as its own file — its responsibility
split into `payments/paystackProvider.ts` (provider-specific calls)
behind the `PaymentProvider` abstraction, so a future second provider
doesn't require a second differently-shaped service file.

## Why this layer exists separately from `routes/`

A route answers "what HTTP request is this and how do I respond?" A
service answers "what actually needs to happen?" Keeping them separate
means, for example, `orderService.createOrder()` could eventually be
called from a route, from a scheduled Worker (e.g., a future cron
cleanup job), or from a test — without duplicating the logic in each
context.

## Today

*(Updated in Version 1.2 Sprint 3.)* Four services are implemented —
`emailService.ts`, `newsletterService.ts`, `consultationService.ts`,
`contactService.ts` — backing the three endpoints this sprint adds.
Each is the only code that writes to its respective D1 table
(`newsletter_subscribers`, `consultation_requests`, `contact_messages`,
`email_log`), matching this folder's own stated rule above.

*(Updated again — Version 1.2 Sprint 2.3, Commerce Foundation.)*
`commerceService.ts`, `productCatalogService.ts`, and the `payments/`
folder are implemented, backing `POST /api/checkout/sessions`.
`commerceService.ts` is the only code that writes to the
`purchase_sessions` D1 table. Unlike every other service above,
`productCatalogService.ts` deliberately does **not** read from D1 at
all — see `docs/commerce-foundation.md`'s "Purchase session" for why
product data comes from `content/products/{slug}.json` instead.

*(Updated again — Version 1.2 Sprint 2.4, Payment Verification.)*
`commerceService.ts` gained `handlePaymentWebhook()` (backing
`POST /api/webhooks/paystack`) and `getPurchaseVerificationStatus()`
(the read-only "is this purchase verified?" answer Sprint 2.5 will
call). It is now also the only code that writes to the
`payment_transactions` D1 table. See `docs/payment-verification.md`.

*(Updated again — Version 1.2 Sprint 2.5, Digital Fulfilment Platform.)*
`entitlementService.ts` and `fulfilmentService.ts` are implemented,
backing `POST /api/purchases/:reference/downloads` and
`GET /api/download/:token`. `fulfilmentService.ts` is the only code
that writes to the `deliveries` D1 table; `commerceService.ts`'s
`handlePaymentWebhook()` now calls `fulfilmentService.fulfilPurchase()`
directly, synchronously, immediately after a payment verifies — see
`docs/digital-fulfilment.md`'s "Fulfilment flow" for why this ended up
tighter than the "Sprint 2.5 will call `getPurchaseVerificationStatus()`"
note above originally anticipated (that function still exists and is
still exported, for any future read-only use outside the webhook flow
itself).
