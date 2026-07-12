# Version 2.0 — Same-Origin Migration: Phase 1 Architecture Audit

Every file below was read fresh for this pass — nothing here is carried over from prior conversation summaries. Where reality differed from what earlier docs assumed, that's called out explicitly.

## Reconstructed request flow

**Login** — `POST /api/admin/auth/login` (`backend/routes/admin/auth.ts:handleAdminLogin`)
1. Rate limit check (`middleware/rateLimit.ts`, 5/15min/IP).
2. Parse JSON body (malformed → generic `INVALID_CREDENTIALS`, never a 500).
3. `authService.login()`: length-bound email/password → D1 lookup (`admin_users WHERE email=? AND is_active=1 AND deleted_at IS NULL`) → `passwordHash.verifyPassword()` against the real hash, or a fixed `DUMMY_PASSWORD_HASH` on a miss (timing-attack resistance) → on success, `sessionService.createSession()` writes a new `admin_sessions` row (random 256-bit token + csrf_secret, 12h absolute `expires_at`) → `auditService.record('admin.login')`.
4. Route sets two cookies (`serializeCookie`) and returns the session + **`csrfToken: result.csrfSecret` in the JSON body** — the cross-origin workaround, see below.
5. `withNoStore()` on every response from this file (no caching of session-adjacent data).

**Session check** — `GET /api/admin/auth/session` (`handleAdminSession`)
1. `requireAuth()` (`middleware/requireAuth.ts`): parses the `admin_session` cookie, calls `sessionService.validateSession()` — one SELECT joining `admin_sessions`+`admin_users`, checking not-revoked, not-expired, owning admin still active. A miss records `admin.unauthorized_access` and returns generic `401 NOT_AUTHENTICATED`.
2. On success, returns the admin's identity **plus `csrfToken: auth.auth.csrfSecret`** — same workaround, needed here too since a page reload loses any in-memory JS state.

**Logout** — `POST /api/admin/auth/logout` (`handleAdminLogout`)
1. `requireAuth()` — must already be authenticated.
2. `requireCsrf()` (`middleware/csrf.ts`): reads the `X-CSRF-Token` header, constant-time-compares it against `auth.csrfSecret` (the session's own stored secret, not the cookie value itself). Miss → `admin.csrf_rejected` audit + `403 FORBIDDEN`.
3. `authService.logout()` → `sessionService.revokeSession()` (atomic `UPDATE ... WHERE revoked_at IS NULL`, idempotent) → `admin.logout` audit.
4. Both cookies cleared via `Max-Age=0`.

**CSRF generation/validation**
- Generated once, at login, in `utils/adminSessionToken.ts:generateCsrfSecret()` (256-bit random hex) — stored in `admin_sessions.csrf_secret`, never regenerated for the life of the session.
- Validated in `middleware/csrf.ts:requireCsrf()` — header vs. the session's own DB-stored secret, constant-time. This function itself does **not** change in this migration; only how the frontend *learns* the secret changes.

**Cookie creation/destruction** — both in `routes/admin/auth.ts`, via `utils/cookies.ts:serializeCookie()`. `admin_session`: HttpOnly, Secure, currently `SameSite=None`, 12h Max-Age. `admin_csrf`: not HttpOnly (must be JS-readable), Secure, currently `SameSite=None`, same Max-Age. Destruction: same two cookies re-issued with `Max-Age=0`.

**Frontend auth helpers** (`js/components/admin/admin-auth.js`)
- `API_BASE` — hardcoded absolute `https://robayer-wealthlab-api.robayerwealthlab.workers.dev`.
- `cachedCsrfToken` (module-level `let`) + `getCsrfToken()` reading it — **the in-memory workaround**, built because `document.cookie` couldn't see the cross-site `admin_csrf` cookie.
- `adminFetch()` — the one function every other admin script goes through; auto-attaches `X-CSRF-Token` for mutating methods, unwraps the `{success,data}`/`{success:false,error}` envelope, and — the other half of the workaround — captures `body.data.csrfToken` into `cachedCsrfToken` whenever a response carries one.
- `sanitizeNextPath()` — open-redirect guard (Phase 0.2 audit fix), unrelated to cross-origin, **stays**.
- `requireSession()`, `redirectIfAuthenticated()`, `login()`, `logout()` — all route through `adminFetch()`.

**Frontend API helper functions elsewhere** — no shared "API helper" module exists outside admin; each public form (`newsletter-form.js`, `contact-form.js`, `consultation-form.js`, `buy-button.js`, `fulfilment-status.js`, `unsubscribe-status.js`) hardcodes its own absolute endpoint constant and calls `fetch()`/`fetchJson()` directly. **None of these six pass `credentials: 'include'`** — confirmed by reading each file fresh. They are, and always were, cookie-less. This matters: it means CORS's `Access-Control-Allow-Credentials` requirement exists *only* because of the admin cookie flow — nothing else on this API has ever needed it.

**Routing** (`backend/worker/index.ts`) — a flat `URLPattern` table, first-match-wins by method+path, dispatched inside a single `fetch()` handler. CORS (`handlePreflight`/`withCors`) and security headers are applied **globally**, wrapped around every response regardless of route — not scoped to `/api/admin/*`. This means the CORS middleware currently runs on every public endpoint too, even though only the admin routes ever needed it.

**CORS** (`backend/middleware/cors.ts`) — `Access-Control-Allow-Origin: env.ALLOWED_ORIGIN` (exact, never `*`), `Allow-Methods: GET, POST, OPTIONS`, `Allow-Headers: Content-Type, X-CSRF-Token`, `Allow-Credentials: true`, preflight short-circuit for `OPTIONS`. Its own file comment already correctly identifies this exists *because of* the admin session cookie's cross-site nature.

**Worker configuration** (`backend/wrangler.jsonc`) — `ALLOWED_ORIGIN` in `vars` (consumed only by `cors.ts`). `routes: [{ pattern: "robayerwealthlab.com/api/*", zone_name: "robayerwealthlab.com" }]` and `workers_dev: true` (added for the PoC) — both currently live in production, verified via the Cloudflare API.

## What's genuinely cross-origin vs. what only looked that way

- **The admin frontend ↔ this Worker**: was cross-site, is the entire reason every workaround below exists. Fixed by same-origin routing.
- **The six public forms ↔ this Worker**: technically also cross-origin today (frontend on `robayerwealthlab.com`, API on `workers.dev`), but never used credentials, so CORS's `Allow-Credentials`/cookie complexity never applied to them — only the plain origin-allowlist half did.
- **Paystack's webhook caller** (`POST /api/webhooks/paystack`): server-to-server, never a browser request, **never subject to CORS at all** (CORS is a browser-enforced mechanism; Cloudflare's edge or Paystack's own HTTP client never evaluates `Access-Control-*` response headers). This is the one caller of this API that will **never** become same-origin, and it's also the one caller CORS was never protecting in the first place. Its own access control is signature verification (`utils/webhookSignature.ts`), unrelated to CORS.
- **`commerceService`'s fetch of `content/products/*.json`** (`SITE_BASE_URL`): Worker-to-static-site, server-side, also never CORS-relevant — a completely different relationship (outbound fetch *by* the Worker, not an inbound browser request *to* it).

**Conclusion carried into Phase 5**: once every frontend call site uses a relative path, there is no remaining legitimate CORS consumer anywhere in this system. The webhook and the product-JSON fetch were never CORS consumers to begin with.

## Dependency graph — every place this migration touches

```
backend/wrangler.jsonc
  ├─ vars.ALLOWED_ORIGIN ──────────────► backend/middleware/cors.ts (only consumer)
  └─ routes / workers_dev ─────────────► backend/worker/index.ts (already live, PoC)

backend/worker/env.ts
  └─ Env.ALLOWED_ORIGIN ────────────────► backend/middleware/cors.ts

backend/middleware/cors.ts ─────────────► backend/worker/index.ts (imported: handlePreflight, withCors)
                                           (both call sites — DELETE FILE)

backend/routes/admin/auth.ts
  ├─ handleAdminLogin
  │   ├─ sets admin_session cookie (SameSite: None → Lax)
  │   ├─ sets admin_csrf cookie (SameSite: None → Lax)
  │   └─ csrfToken in JSON body ─────────► REMOVE (workaround)
  ├─ handleAdminLogout
  │   └─ requireCsrf() ──────────────────► backend/middleware/csrf.ts (UNCHANGED)
  └─ handleAdminSession
      └─ csrfToken in JSON body ─────────► REMOVE (workaround)

js/components/admin/admin-auth.js
  ├─ API_BASE (absolute) ────────────────► relative ('')
  ├─ cachedCsrfToken + getCsrfToken() ────► REMOVE; read document.cookie directly
  ├─ adminFetch()'s csrfToken-capture ────► REMOVE
  └─ consumed by: admin-login.js, admin-shell.js, admin-dashboard.js
      (none of these three need their own changes — they only call
      window.AdminAuth's public functions, whose signatures don't change)

js/components/newsletter-form.js    NEWSLETTER_API_URL    (absolute) ──► relative
js/components/contact-form.js       CONTACT_API_URL       (absolute) ──► relative
js/components/consultation-form.js  CONSULTATION_API_URL  (absolute) ──► relative
js/components/buy-button.js         CHECKOUT_API_URL      (absolute) ──► relative
js/components/fulfilment-status.js  FULFILMENT_API_BASE   (absolute) ──► relative
js/components/unsubscribe-status.js UNSUBSCRIBE_API_BASE  (absolute) ──► relative

backend/middleware/requireAuth.ts   ─── UNCHANGED (origin-agnostic)
backend/middleware/requireRole.ts   ─── UNCHANGED (origin-agnostic)
backend/middleware/csrf.ts          ─── UNCHANGED (the *check* never depended on transport)
backend/services/admin/sessionService.ts ─── UNCHANGED
backend/services/admin/authService.ts    ─── UNCHANGED
backend/services/admin/auditService.ts   ─── UNCHANGED
backend/utils/adminSessionToken.ts       ─── UNCHANGED
backend/utils/cookies.ts                 ─── UNCHANGED (serializeCookie itself is origin-agnostic)
backend/middleware/securityHeaders.ts    ─── UNCHANGED (unrelated concern)
backend/routes/health.ts                 ─── UNCHANGED (PoC artifact, stays)
```

## What does *not* change (confirmed by reading each file fresh)

`requireAuth.ts`, `requireRole.ts`, `csrf.ts`'s actual comparison logic, `sessionService.ts`, `authService.ts`, `auditService.ts`, `adminSessionToken.ts`, `cookies.ts`'s `serializeCookie`/`parseCookies` themselves, `securityHeaders.ts`, D1 schema. None of this code has any origin-awareness baked in — it operates purely on cookies/headers already parsed off the request, regardless of where the request came from.
