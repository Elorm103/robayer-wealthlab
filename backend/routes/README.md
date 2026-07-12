# routes/

## Purpose

One module per resource — the HTTP-facing layer that parses a request,
calls into `services/` for the actual business logic, and formats the
response using the shared shapes in `types/api-contracts.ts`. Routes
themselves should stay thin: request parsing and response formatting
only, never database queries or Paystack calls directly (that's what
`services/` is for — see that folder's README).

## Planned modules (no code yet — full detail in `docs/worker-api-design.md`)

| File | Endpoints it owns |
|---|---|
| `checkout.ts` ✅ | `POST /api/checkout/sessions` — added in Sprint 2.3, see `docs/commerce-foundation.md`. Supersedes the originally-planned `orders.ts`/`POST /api/orders` shape, see `docs/worker-api-design.md` |
| `webhooks.ts` ✅ | `POST /api/webhooks/paystack` — added in Sprint 2.4, see `docs/payment-verification.md`. Supersedes the originally-planned `payments.ts`/`POST /api/payments/verify` shape (that design assumed a client-triggered call; the real flow is webhook-triggered) |
| `newsletter.ts` ✅ | `POST /api/newsletter` |
| `consultation.ts` ✅ | `POST /api/consultation` |
| `contact.ts` ✅ | `POST /api/contact` — added in Sprint 3, not in this table originally; see `docs/email-architecture.md`'s note on why |
| `downloads.ts` ✅ | `GET /api/download/:token` — added in Sprint 2.5, see `docs/digital-fulfilment.md` |
| `purchases.ts` ✅ | `GET /api/purchases/:reference`, `POST /api/purchases/:reference/downloads` — added in Sprint 2.5, not in this table originally (the fulfilment page's own two endpoints, no prior design doc anticipated the exact shape) |
| `products.ts` | `GET /api/products` |
| `admin/auth.ts` ✅ | `POST /api/admin/auth/login`, `POST /api/admin/auth/logout`, `GET /api/admin/auth/session` — added Version 2.0 Phase 0.1 (Authentication Foundation), see `docs/v2-authentication-design.md`. Supersedes this table's originally-planned flat `admin.ts`/`POST /api/admin/login` shape — see `docs/v2-architecture.md`'s approved `routes/admin/` folder structure |

✅ = implemented. `products.ts` remains unimplemented. Every other
`routes/admin/*` module (dashboard, products, blog, resources,
newsletter, consultations, contacts, orders, media, analytics,
settings, users — per `docs/v2-architecture.md`) remains out of scope
until its own phase.

Each endpoint's purpose, request/response shape, authentication
requirement, validation rules, and possible errors are documented in
full in `docs/worker-api-design.md` — this README only maps endpoints
to their future file, so the folder structure itself is self-explaining
without duplicating that detail in two places.

## Today

*(Updated in Version 1.2 Sprint 3.)* `newsletter.ts`, `contact.ts`,
and `consultation.ts` are implemented — each parses/validates its
request via `middleware/validate.ts` and `utils/validation.ts`, calls
its matching `services/` function, and formats the response via
`utils/responses.ts`. `worker/index.ts` dispatches to these three;
every other route file remains an empty placeholder.

*(Updated again — Version 1.2 Sprint 2.3, Commerce Foundation.)*
`checkout.ts` is implemented, following the same thin-route pattern —
validates `productId`, rate-limits, calls `services/commerceService.ts`,
maps its `CommerceError` onto the standard error envelope. Registered
in `worker/index.ts` alongside the other three.

*(Updated again — Version 1.2 Sprint 2.4, Payment Verification.)*
`webhooks.ts` is implemented — verifies the Paystack signature, shape-
checks the payload, calls `services/commerceService.ts`'s
`handlePaymentWebhook()` for all business logic. Deliberately not
rate-limited (see `docs/payment-verification.md`'s "Webhook security")
and deliberately always responds `200` once the request is authentic
and well-formed, unlike every other route's error-code-driven status —
see that file's own header comment for why.

*(Updated again — Version 1.2 Sprint 2.5, Digital Fulfilment Platform.)*
`purchases.ts` and `downloads.ts` are implemented — the fulfilment
page's status/download-request endpoints, and the actual file-serving
redemption endpoint, respectively. `downloads.ts` is the one route in
this Worker whose successful response isn't the standard JSON
envelope (the file itself) — see that file's own header comment, and
`docs/digital-fulfilment.md`. Both new routes have dynamic path
segments (`:reference`, `:token`) — see `worker/index.ts`'s own
updated dispatch logic for how those are extracted.
