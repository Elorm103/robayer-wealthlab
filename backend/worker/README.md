# worker/

## Purpose

The single Cloudflare Worker entry point — the equivalent of an
`index.js`/`main.ts` for the entire backend. One Worker handles every
route in `routes/`, rather than one Worker per endpoint, because:

- Cloudflare Workers share environment bindings (D1/R2/KV) most simply
  when defined once, at the Worker level, and passed down.
- Cross-cutting concerns (`middleware/`) only need to run once, at the
  entry point, not duplicated per Worker.
- This project has one small, cohesive set of features (orders,
  downloads, forms, admin) — not independent products that would
  benefit from separate deployments.

## What will live here (future)

- The Worker's `fetch` handler — receives every incoming request,
  applies `middleware/` in order, then dispatches to the matching
  module in `routes/` based on path and method.
- Environment binding declarations (typed references to the D1
  database, R2 buckets, and KV namespaces configured in
  `../wrangler.jsonc`).
- Top-level error handling — ensures an unhandled error in any route
  still returns the standardized failure shape from `types/api-contracts.ts`,
  never a raw stack trace to a client.

## Today

*(Updated in Version 1.2 Sprint 3.)* `index.ts` routes
`POST /api/newsletter`, `POST /api/contact`, and
`POST /api/consultation` using the Workers-native `URLPattern` API (no
router dependency, per the "no unnecessary dependencies" posture
below), applies CORS (`middleware/cors.ts`) and top-level error
handling (`middleware/errorHandler.ts`), and generates one requestId
per request threaded through every log line
(`docs/monitoring-and-alerting.md`). Any other path/method gets a
standard `NOT_FOUND` envelope. `env.ts` declares the `Env` bindings
configured in `../wrangler.jsonc` (migrated from `wrangler.toml` during
Sprint 3's Worker-initialization pass — see `../config/README.md`).
**Nothing here is deployed** — this is still local, unpushed code; see
the Sprint 3 implementation report for the manual test plan and
deployment steps.

**Verified locally (Phase 2, not just reviewed):** `wrangler d1 execute
--local` applied `database/schema.sql` to a local D1 instance, then
`wrangler dev` served all three endpoints against it. Every documented
success case, validation-error case, the rate limiter (5th request
succeeds, 6th returns `RATE_LIMITED`), CORS preflight, and the unknown-
route `NOT_FOUND` fallback all behaved exactly as designed. With no
real `RESEND_API_KEY` configured, Resend's real API correctly rejected
each send attempt with `401`; each attempt was logged to `email_log` as
`permanently_failed` with the real error body, and — the property that
matters most — every triggering request (subscribe/contact/consultation)
still returned `success: true`, confirming a failed email genuinely
never blocks the underlying action.

*(Updated — Version 1.2 Sprint 2.3, Commerce Foundation.)* `index.ts`
now also routes `POST /api/checkout/sessions` (`routes/checkout.ts`),
using the same `URLPattern` dispatch and error-handling as the other
three routes — no change to the entry point's own structure. `env.ts`
gained five new bindings (`SITE_BASE_URL`, `PAYMENT_PROVIDER`,
`PAYSTACK_BASE_URL`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`) —
see `docs/commerce-foundation.md`. `npm run typecheck` (`tsc --noEmit`)
passes cleanly against every file this sprint touched or added.
**Still not deployed** — see `docs/commerce-foundation.md`'s
"Deployment gate" for why this Worker must not be deployed with a
real, live-mode Paystack key until Sprint 2.4/2.5 exist.

*(Updated — Version 1.2 Sprint 2.4, Payment Verification.)* `index.ts`
now also routes `POST /api/webhooks/paystack` (`routes/webhooks.ts`),
deliberately *not* wrapped in the per-IP rate-limit middleware the
other routes use (see `docs/payment-verification.md`'s "Webhook
security"). No new `Env` bindings — Paystack signs webhooks with the
same `PAYSTACK_SECRET_KEY` already added in Sprint 2.3, not a separate
webhook secret (see `docs/payment-verification.md`'s "Known
limitations" for the confidence caveat). `npm run typecheck` passes
cleanly. **Still not deployed** — the deployment gate above is
unchanged and still in force (Sprint 2.5/delivery still doesn't
exist).

*(Updated — Version 1.2 Sprint 2.5, Digital Fulfilment Platform.)*
`index.ts`'s dispatch logic changed from `URLPattern.test()` to
`.exec()`, so routes with dynamic path segments
(`/api/purchases/:reference`, `/api/download/:token`) can extract
them — `RouteHandler` gained a fourth `params` argument, but every
pre-existing route handler still satisfies the type unchanged (see
`index.ts`'s own header comment on why). Three new routes added:
`GET /api/purchases/:reference`, `POST /api/purchases/:reference/downloads`,
`GET /api/download/:token` — see `docs/digital-fulfilment.md`. No new
`Env` bindings — the `STORAGE` R2 binding has existed since Sprint 3.
`npm run typecheck` passes cleanly. **Still not deployed** — the
deployment gate is now satisfied in the sense that Sprint 2.5 exists,
but a *new* gate applies: no real R2 bucket has real objects in it
yet, so downloads would correctly fail with `ASSET_UNAVAILABLE` rather
than serve anything even if this Worker were deployed.

**Known follow-up (not done in this pass):** `wrangler types` now
generates a project-wide `Env` interface directly from
`wrangler.jsonc` into `../worker-configuration.d.ts` (gitignored,
regenerate with `npx wrangler types`), which current Wrangler/Workers
guidance recommends using instead of a hand-written `Env`. `env.ts`'s
hand-written interface was kept as-is this pass to avoid touching
already-implemented `routes/`/`services/` files; migrating every
`import type { Env } from '../worker/env'` to the generated type is a
reasonable near-term cleanup, not done here since it touches
implementation files.
