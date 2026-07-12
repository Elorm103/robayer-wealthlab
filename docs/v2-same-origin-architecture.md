# Version 2.0 — Same-Origin Architecture (Permanent Reference)

This is the current, permanent architecture for how the frontend and backend communicate. It supersedes the cross-origin design documented in `docs/v2-admin-shell-architecture.md`'s "Critical finding" (kept there only as historical record) and the interim CSRF workaround from the Phase 0.2 independent audit. Built and verified in three stages: an architecture review (`docs/v2-security-review.md`), a live proof of concept (`docs/v2-same-origin-routing-poc.md`), then this full migration (`docs/v2-same-origin-migration-audit.md` has the file-by-file dependency graph this migration worked from).

## Routing model

The frontend (`robayerwealthlab.com`, GitHub Pages behind Cloudflare) and the Worker API are **same-origin**. A Cloudflare Workers Route matches `robayerwealthlab.com/api/*` and sends those requests to the Worker at the edge, before they ever reach GitHub Pages — every other path on that hostname continues to be served by GitHub Pages exactly as before; a Route only intercepts what it matches.

```jsonc
// backend/wrangler.jsonc
"routes": [
  { "pattern": "robayerwealthlab.com/api/*", "zone_name": "robayerwealthlab.com" }
],
"workers_dev": true  // kept on purpose — see "workers.dev" below
```

The Worker's own `workers_dev` subdomain (`robayer-wealthlab-api.robayerwealthlab.workers.dev`) also stays live, deliberately. It's not a leftover — it's a zero-cost operational escape hatch (direct debugging/curl access to the exact deployed code, independent of the zone's routing) with no meaningful security downside: every protection (auth, CSRF, rate limiting) is enforced identically regardless of which hostname a request arrives on. It grants no different access than the same-origin route does.

Every frontend call site uses a **relative path** (`/api/...`), resolved by the browser against whatever origin the page itself is served from — never a hardcoded absolute URL. `js/components/admin/admin-auth.js`'s `API_BASE` is `''`; the same is true of `newsletter-form.js`, `contact-form.js`, `consultation-form.js`, `buy-button.js`, `fulfilment-status.js`, and `unsubscribe-status.js`.

**The one caller that will never be same-origin:** Paystack's webhook (`POST /api/webhooks/paystack`) is a server-to-server request, not a browser request — CORS was never protecting it, and same-origin routing is irrelevant to it. Its access control has always been signature verification (`backend/utils/webhookSignature.ts`), unchanged.

## Authentication flow

1. **Login** (`POST /api/admin/auth/login`) — rate-limited (5/15min/IP), credential-verified with constant-time-equivalent timing (a dummy hash comparison runs even on a lookup miss), a new `admin_sessions` row is created (random 256-bit token + CSRF secret, 12h absolute expiry), and two cookies are set.
2. **Every subsequent request** carries the session cookie automatically (same-origin, no special handling needed). `requireAuth()` (`backend/middleware/requireAuth.ts`) validates it against D1 on every single request — no client-side trust, no session caching that could go stale.
3. **Logout** (`POST /api/admin/auth/logout`) — requires a valid session AND a valid CSRF header, atomically revokes the session row, clears both cookies.
4. **Session check** (`GET /api/admin/auth/session`) — what every protected page calls on load; a 401 redirects to `/admin/login/?next=<path>` before any admin content renders.

None of `requireAuth.ts`, `requireRole.ts`, `sessionService.ts`, `authService.ts`, or `auditService.ts` changed in the same-origin migration — this flow was always origin-agnostic; only how the *browser* delivers the cookie changed.

## Cookie model

| Cookie | HttpOnly | SameSite | Purpose |
|---|---|---|---|
| `admin_session` | Yes | `Lax` | The session identifier. Never readable by JS — the browser attaches it automatically. |
| `admin_csrf` | No | `Lax` | The CSRF secret, deliberately JS-readable — see below. |

Both are `Secure`, 12-hour `Max-Age`, host-scoped (no `Domain` attribute — neither needs one, since same-origin means the default host-only scope already works correctly).

**Why `Lax`, not `Strict` or `None`:**
- `None` was the Phase 0.2 fix for a cross-site relationship that no longer exists. A `SameSite=None` cookie is, by definition, a third-party cookie from the browser's perspective — increasingly restricted, partitioned, or evicted by Safari ITP, Firefox Total Cookie Protection, and Chrome's Privacy Sandbox trajectory. Same-origin routing removes any reason to accept that exposure.
- `Strict` would cause a real, if minor, UX bug: an admin clicking a link from an external site (e.g. an email) straight into `/admin/...` wouldn't have the cookie attached on that first top-level navigation, appearing logged-out for one page load. `Lax` avoids this while still blocking the cross-site `POST`s both `Strict` and `Lax` exist to stop.

## CSRF model

The **standard double-submit-cookie pattern**, exactly as originally specified in `docs/v2-authentication-design.md`, with no workaround layered on top:

1. At login, the server generates a random CSRF secret, stores it on the session row, and returns it as the `admin_csrf` cookie (not `HttpOnly`).
2. The frontend reads it straight from `document.cookie` (`js/components/admin/admin-auth.js:getCsrfToken()`) and attaches it as the `X-CSRF-Token` header on every mutating request.
3. `backend/middleware/csrf.ts:requireCsrf()` compares that header against the session's own stored secret (constant-time), never against the cookie value itself — an attacker who can trigger a cross-site request carries the victim's session cookie automatically but cannot read the CSRF cookie's value (a different origin's `document.cookie` can't see it) to forge a matching header.

**What used to be different, and why it's gone:** between Phase 0.2 and this migration, `admin_csrf` was set on a genuinely cross-*site* origin (`workers.dev`), so `document.cookie` on the frontend page could never read it — a browser cookie-storage rule, unrelated to `SameSite`. The workaround delivered the token via the JSON response body instead, cached in an in-memory JS variable (`cachedCsrfToken`), re-supplied on every login/session-check. That variable, its capture logic in `adminFetch()`, and the `csrfToken` field in the login/session response bodies have all been removed — same-origin means the cookie is natively readable, so the extra transport channel serves no purpose.

`requireCsrf()`'s actual comparison logic never changed throughout any of this — only how the frontend learns the secret changed.

## CORS

There is none. `backend/middleware/cors.ts` was deleted; `worker/index.ts` no longer imports or calls anything CORS-related; `env.ALLOWED_ORIGIN` was removed from `Env`, `wrangler.jsonc`, and both `.dev.vars` files. A genuinely same-origin `fetch()` never triggers CORS in the browser — confirmed live (zero preflight `OPTIONS` requests observed against production). Removing the preflight short-circuit doesn't open an auth-bypass path: an `OPTIONS` request now falls through to the normal route table, matches nothing (no route is registered for that method), and correctly returns `404 NOT_FOUND`.

## Deployment model

- `wrangler deploy` publishes the Worker to **both** `workers.dev` and the `robayerwealthlab.com/api/*` Route simultaneously — one script, two reachable addresses, identical behavior on both.
- The frontend deploys independently via GitHub Pages (a `git push` to the branch GitHub Pages serves from) — completely decoupled from the Worker's deployment, same as before this migration.
- No DNS changes were needed for this migration; the zone was already proxied through Cloudflare for GitHub Pages, and Workers Routes operate on that existing proxied traffic rather than requiring their own DNS record.

## What changed, file by file

See `docs/v2-same-origin-migration-audit.md` for the full dependency graph. Summary: `backend/middleware/cors.ts` deleted; `backend/routes/admin/auth.ts` (cookie `SameSite`, removed `csrfToken` from response bodies); `backend/worker/index.ts` (CORS wiring removed); `backend/worker/env.ts` and `backend/wrangler.jsonc` (`ALLOWED_ORIGIN` removed); `js/components/admin/admin-auth.js` (cookie-read CSRF, `API_BASE` relative); six other frontend files (`API_BASE`-equivalent constants made relative). `requireAuth.ts`, `requireRole.ts`, `csrf.ts`'s comparison logic, `sessionService.ts`, `authService.ts`, `auditService.ts`, `securityHeaders.ts`, and the D1 schema are all unchanged.
