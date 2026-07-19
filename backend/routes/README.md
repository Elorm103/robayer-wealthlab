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
| `admin/dashboard.ts` ✅ | `GET /api/admin/dashboard/summary` — added Version 2.0 Phase 0.2 (Admin Shell), see `docs/v2-admin-shell-architecture.md`. Open to every authenticated role (no `requireRole` gate) per the approved permissions table |
| `admin/media.ts` ✅ | `POST/GET /api/admin/media`, `GET/PATCH/DELETE /api/admin/media/:id`, `POST /api/admin/media/:id/replace`, `POST /api/admin/media/:id/restore` — added Version 2.0 Phase 1 (Media Library), see `docs/v2-media-library-spec.md`. Viewing open to every role; every mutation gated `editor`/`super_admin` via `requireRole()` |
| `media.ts` ✅ | `GET /api/media/file/:key` — the public, unauthenticated counterpart to `admin/media.ts`, added the same phase. Deliberately outside `admin/` (no auth), matching `downloads.ts`'s top-level placement for its own public-but-token-gated route |

✅ = implemented as of the phase noted. **Current status, corrected during the Version 2.1 Phase 7 Final Acceptance Audit: every module named as "out of scope" below has since shipped.** The table and "Today" log below stop narrating at Version 2.0 Phase 1 and are preserved as historical record, not edited retroactively — for what's real today, this list is authoritative: `products.ts` (public catalog), `books.ts`/`resources.ts`/`blog.ts` (server-rendered public pages), `unsubscribe.ts`, and every `routes/admin/*` module — `auth.ts`, `dashboard.ts`, `media.ts`, `products.ts`, `orders.ts`, `consultations.ts`, `contacts.ts`, `analytics.ts`, `resources.ts`, `blog.ts`, `settings.ts`, `users.ts`, `newsletterCampaigns.ts` — are all implemented and live in production. See each `docs/v2.1-phaseN-implementation.md` / `docs/v2-*.md` for when each shipped, and `docs/v2.1-release-checkpoint.md` for the full current-state audit.

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

*(Updated again — Version 2.0 Phase 1, Media Library.)* `admin/media.ts`
and top-level `media.ts` are implemented. `admin/media.ts` is a thin
HTTP layer only — every real check (auth, role, CSRF, rate limit) is
called explicitly in each handler, then delegates to
`services/mediaService.ts`. `media.ts`'s `GET /api/media/file/:key`
is now the second route in this Worker (after `downloads.ts`) whose
successful response isn't the standard JSON envelope — it streams the
real R2 object body with a `Cache-Control: immutable` header, safe
because every real key is a fresh UUID that never gets reused for
different content. Registered in `worker/index.ts` with the
`:key(.*)` regex-group pattern, since a real storage key is itself a
multi-segment path (`media/images/books/<uuid>.jpg`), not a single
path segment like every other dynamic route here.
