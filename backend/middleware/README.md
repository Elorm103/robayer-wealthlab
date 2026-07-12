# middleware/

## Purpose

Cross-cutting logic that runs *before* a route's own handler, shared
across multiple endpoints instead of repeated in each one. Planned
middleware (full reasoning in `docs/authentication-strategy.md` and
`docs/backend-security.md`):

| Middleware (future) | Applies to | What it will do |
|---|---|---|
| `auth.ts` | Every `/api/admin/*` route except `login` | Verifies the admin session (see `docs/authentication-strategy.md`) before allowing the request through |
| `rateLimit.ts` | `POST /api/newsletter`, `POST /api/consultation`, `POST /api/payments/verify`, `POST /api/admin/login` | Rejects excessive requests from the same source — see `docs/backend-security.md` |
| `cors.ts` | Every route | Restricts which origins may call the API (only `robayerwealthlab.com` and its previews) |
| `validate.ts` | Every `POST`/`PUT` route | Applies a per-route input schema before the route handler runs, so routes never handle malformed input themselves |
| `csrf.ts` | Every `/api/admin/*` state-changing route | Verifies a CSRF token for cookie-authenticated admin requests — see `docs/authentication-strategy.md` |

## Why middleware, not per-route checks

Repeating "check the admin session" or "check the rate limit" inside
every route function is exactly the kind of duplication this project
avoided elsewhere (e.g., extracting `calculator-utils.js` once three
calculators needed the same math). Middleware is the backend
equivalent — written once, applied declaratively per route in
`worker/`'s routing table.

## Today

*(Updated in Version 1.2 Sprint 3.)* `cors.ts`, `rateLimit.ts`, and
`validate.ts` are implemented, scoped to what
`POST /api/newsletter`/`contact`/`consultation` need. `auth.ts` and
`csrf.ts` remain unimplemented — both apply only to `/api/admin/*`
routes, and the admin dashboard is explicitly out of scope for this
sprint.

*(Updated — Version 2.0 Phase 0.1, Authentication Foundation.)*
`requireAuth.ts` and `requireRole.ts` are implemented (the planned
`auth.ts` entry, split into two files to match `docs/v2-architecture.md`'s
approved folder structure — session validation and role-gating are
distinct, separately-callable checks). `csrf.ts` is also implemented,
per its own row above. All three apply so far only to the three
`/api/admin/auth/*` routes built in this phase — every other
`/api/admin/*` route remains out of scope until its own phase. See
`docs/v2-authentication-design.md`.

*(Updated — Version 2.0 Phase 0.2, Admin Shell.)* `cors.ts` gained
`Access-Control-Allow-Credentials: true` and `X-CSRF-Token` in
`Access-Control-Allow-Headers` — required once a real browser (the
admin frontend, on `robayerwealthlab.com`) started calling this Worker
(a different origin) with cookies. Additive only: every existing
public, cookie-less endpoint is unaffected. Also required a correction
to the admin session cookies themselves (`SameSite=Strict` → `None`,
in `routes/admin/auth.ts`) since a `Strict` cookie is never sent
cross-site regardless of this header — see
`docs/v2-admin-shell-architecture.md`'s "Critical finding" for the
full reasoning.

One additional file exists beyond this table: `errorHandler.ts` —
top-level error handling wrapping route dispatch in `worker/index.ts`,
implementing the promise already made in `worker/README.md` ("an
unhandled error in any route still returns the standardized failure
shape"). It wasn't in this table because that promise predates this
being split into its own file; documented here now rather than left
as an undocumented addition.

*(Added — Version 1.0 Launch Readiness pass.)* `securityHeaders.ts` —
applies baseline HTTP security headers (CSP, X-Frame-Options,
X-Content-Type-Options, Referrer-Policy, Permissions-Policy,
Strict-Transport-Security) to every response, success or error,
including the CORS preflight short-circuit. Deliberately a separate
file from `cors.ts` rather than folded into it, so this pass's
addition never touches already-completed, working CORS logic. See
`docs/launch-readiness.md` for the full per-header reasoning — this
resolves the "Security headers" gap flagged in
`docs/platform-review-v1.md`.
