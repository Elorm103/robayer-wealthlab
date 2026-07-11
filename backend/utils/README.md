# utils/

## Purpose

Small, pure, reusable helper functions with no dependency on HTTP,
D1, R2, or Paystack — the backend equivalent of this project's own
`js/components/calculator-utils.js` (shared, pure, framework-free
functions, extracted only because multiple real consumers need the
exact same logic).

## Planned utilities (future)

| Utility (future) | Purpose |
|---|---|
| `validateEmail()` / `validateRequestShape()` | Shared input-validation helpers used by `middleware/validate.ts` across multiple routes |

`generateReference()`, `toSubunits()`, and `generateDownloadToken()` —
all originally planned here — are now implemented (see "Today" below).

## Why these are utilities, not services

Everything here is a pure function: given the same input, it always
returns the same output, with no side effects (no database write, no
network call). `toSubunits(39, "GHS")` always returns `3900` — that's
a utility. Verifying a transaction with Paystack's API is not (it
makes a network call and can fail) — that belongs in `services/`.

## Today

*(Updated in Version 1.2 Sprint 3.)* Four utilities are implemented,
scoped to what `POST /api/newsletter`, `POST /api/contact`, and
`POST /api/consultation` actually need:

| File | Exports |
|---|---|
| `requestId.ts` | `generateRequestId()` — one UUID per incoming request |
| `logger.ts` | `createLogger(requestId, route)` — structured JSON logging per `docs/monitoring-and-alerting.md` |
| `responses.ts` | `jsonSuccess()`, `jsonError()`, `ERROR_STATUS` — the standardized response envelope from `types/api-contracts.ts`, never built ad hoc in a route |
| `validation.ts` | `isValidEmail()`, `isNonEmptyString()`, `isOneOf()` |

*(Updated — Version 1.2 Sprint 2.3, Commerce Foundation.)*
`purchaseReference.ts`'s `formatPurchaseReference()` implements what
this table originally called `generateReference()`, but in the
`RWL-{year}-{6-digit sequence}` shape (not `RWL-{slug}-{timestamp}-{random}`)
— see `docs/commerce-foundation.md`'s "Internal purchase reference"
for why the format changed. `toSubunits()` was not built as a separate
utility — the one price→pesewas conversion this project needs lives
directly in `services/commerceService.ts`, at the single call site
that needs it, rather than as a generically-named utility with only
one caller.

*(Updated — Version 1.2 Sprint 2.4, Payment Verification.)*
`webhookSignature.ts`'s `verifyPaystackSignature()` (HMAC-SHA512 over
the raw webhook body via Web Crypto, constant-time comparison) is now
implemented — a pure computation with no D1/network dependency
(async only because `crypto.subtle` itself is promise-based), fitting
this folder's own stated rule above. See
`docs/payment-verification.md`'s "Webhook security."

*(Updated — Version 1.2 Sprint 2.5, Digital Fulfilment Platform.)*
`downloadToken.ts`'s `generateDownloadToken()` — 256 bits of entropy
via `crypto.getRandomValues`, the same Web-Crypto-only, zero-dependency
approach as `webhookSignature.ts` — finally closes this table's
longest-standing planned entry. See `docs/digital-fulfilment.md`'s
"Security."
