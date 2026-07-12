# Same-Origin Routing Proof of Concept — Results and Migration Plan

Version 2.0. Follows `docs/v2-security-review.md`'s CSRF architecture review (Option A vs B vs C) and its feasibility study against the real deployment. This document records what was actually built and verified, and lays out the plan for migrating every `/api/*` endpoint — **plan only; no endpoint migration has been executed yet.**

## What was built

- A Cloudflare Workers Route, `robayerwealthlab.com/api/*`, added to the existing zone (`backend/wrangler.jsonc`'s `routes`), pointing at the same Worker script (`robayer-wealthlab-api`) that already serves `robayer-wealthlab-api.robayerwealthlab.workers.dev`. `workers_dev` was left explicitly `true` so both endpoints are live simultaneously — this was additive, not a cutover.
- One new endpoint, `GET /api/health` (`backend/routes/health.ts`), with no auth, no state, no side effects — the first thing verified through the new route before anything that touches real data.
- The Worker was redeployed to production with both changes. This also shipped, for the first time, the Phase 0.2 Admin Shell backend (dashboard endpoint) and the Phase 0.2 audit's fixes (CSRF-token-in-body delivery, open-redirect sanitization) — none of that had been deployed before, and the verification checklist below (login/logout/CSRF) needed it live to be testable at all. The Phase 0.2 admin **frontend** (HTML/JS pages) was not touched or deployed — it doesn't exist in production yet.

## Verification results — all 8 passed

| # | Check | Result |
|---|---|---|
| 1 | `/api/*` intercepted by the Worker | `GET https://robayerwealthlab.com/api/health` → `200`, correct JSON body. Confirmed independently against the Cloudflare API (`GET /zones/{id}/workers/routes` lists the route). |
| 2 | GitHub Pages continues serving static pages | `/`, `/about/`, `/blog/`, `/free-guide/` all still `200`, still carrying GitHub's own `X-Github-Request-Id` header — origin untouched. |
| 3 | No routing conflicts | An unmatched `/api/*` path returns the **Worker's own** `NOT_FOUND` JSON (confirms the whole prefix is claimed) — while `/apitest/` (similar-looking, not matching the glob) still falls through to GitHub Pages' own 404 page. Pattern matching is precise, not over-broad. |
| 4 | Cookies behave as expected on the same origin | Logging in via a `fetch()` issued from the real, live `https://robayerwealthlab.com/` page showed the CSRF cookie (`admin_csrf`) **directly readable via `document.cookie`** — no `Domain`-widening trick needed, unlike what Option B would have required. This is a stronger result than either option promised on paper. |
| 5 | CORS can be removed | The same login request produced **zero preflight `OPTIONS` request** — confirmed via the network log, which shows exactly one `POST` and nothing else. A genuinely same-origin request never enters CORS machinery at all. |
| 6 | Admin login/logout still work | Full real cycle: login (`200`, session cookie set) → logout with the correct CSRF token (`200`, `loggedOut: true`) → session-check afterward correctly returns `401 NOT_AUTHENTICATED` → confirmed server-side in production D1 (`admin_sessions.revoked_at` set). |
| 7 | CSRF protection still works | Logout attempted *without* the `X-CSRF-Token` header was correctly rejected (`403 FORBIDDEN`), and — critically — the session was **not** revoked by the failed attempt (checked via a follow-up session-check that still succeeded). Protection remains intact on the new route. |
| 8 | Existing public pages unaffected | Zero console errors on the live homepage; visually unchanged; existing `workers.dev` endpoints (e.g. `/api/newsletter`) still respond exactly as before. |

**Test data hygiene:** a temporary `super_admin` test account was created directly in production D1 to run checks 4/6/7 — this required explicit confirmation mid-task (the harness's own permission layer correctly flagged it as a named action I hadn't surfaced up front). It was deleted immediately after use; `admin_users`/`admin_sessions` in production now show zero trace of it.

## What this proves, concretely

- The entire CORS layer (`backend/middleware/cors.ts`, the `Access-Control-*` headers, the preflight short-circuit in `worker/index.ts`) is provably unnecessary for any endpoint reached via the same-origin route.
- The CSRF-token-in-JSON-body workaround built during the Phase 0.2 audit is no longer needed for endpoints on the same-origin route — the original, simpler double-submit-cookie design (read `admin_csrf` straight from `document.cookie`) works natively, with zero special-casing.
- The session cookie no longer needs `SameSite=None` for endpoints reached this way — `SameSite=Lax` is sufficient and immune to the third-party-cookie restrictions that made Option A fragile long-term.

## Migration plan (not yet executed)

**Scope:** move every `/api/*` endpoint currently reachable via `robayer-wealthlab-api.robayerwealthlab.workers.dev` to be called via the same-origin `robayerwealthlab.com/api/*` route instead, then simplify the code that only existed to work around the old cross-site architecture.

### Step 1 — Frontend: switch API_BASE to a relative path
- `js/components/admin/admin-auth.js`: change `API_BASE` from the absolute `workers.dev` URL to `''` (empty string / relative), so `adminFetch()`'s `fetch(API_BASE + path, ...)` resolves against the current page's own origin.
- Every other frontend file that currently hardcodes the `workers.dev` URL (`newsletter-form.js`, `buy-button.js`, etc. — the pattern flagged in earlier audits as "update this after deploying the Worker") gets the same treatment.
- No backend change required for this step alone — the new route already serves identical responses to the old one.

### Step 2 — Cookies: drop `SameSite=None`, drop the CSRF-cookie `Domain` question entirely
- `backend/routes/admin/auth.ts`: change both cookies' `sameSite` from `'None'` to `'Lax'`. `Secure` stays `true`.
- No `Domain` attribute needs to be added to either cookie — same-origin means the default (host-only) scope already makes `admin_csrf` readable by the frontend's own JS, as verified above. This is simpler than Option B would have been, not just simpler than Option A.

### Step 3 — CSRF: revert to reading the cookie, retire the JSON-body token
- `js/components/admin/admin-auth.js`: restore `getCsrfToken()` to read `document.cookie` directly; remove the `cachedCsrfToken` in-memory variable and the `adminFetch()` logic that captures `csrfToken` from response bodies.
- `backend/routes/admin/auth.ts`: remove the `csrfToken` field from the `handleAdminLogin`/`handleAdminSession` JSON responses (the cookie alone carries it now, exactly as the original design intended).
- `backend/middleware/csrf.ts`'s actual check (`requireCsrf()`, comparing the `X-CSRF-Token` header against the session's stored `csrf_secret`) does not change at all — the fix is entirely in how the token gets to the frontend, not in how it's verified.

### Step 4 — Remove CORS entirely for same-origin traffic
- Once every frontend call site uses a relative path, `backend/middleware/cors.ts` (`corsHeaders()`, `handlePreflight()`, `withCors()`) and its wiring in `worker/index.ts` can be deleted outright — same-origin requests never trigger CORS in the browser, so there is nothing left for that middleware to serve.
- `env.ALLOWED_ORIGIN` becomes dead configuration and can be removed from `wrangler.jsonc`'s `vars` and `Env` type.
- **Caveat:** confirm no other legitimate cross-origin caller exists before deleting this (e.g., a future mobile app, a partner integration, or a preview/staging frontend on a different domain). If any such caller is expected, keep a minimal CORS allowance scoped to that specific case rather than deleting the middleware wholesale.

### Step 5 — Decide the fate of `workers.dev`
- Once every real caller uses the same-origin route, `workers_dev` can be set to `false` (or left `true` harmlessly — Cloudflare Workers happily serve both a `workers.dev` subdomain and zone routes simultaneously indefinitely; there's no forcing function to turn it off). Recommend leaving it on for now as a low-cost operational escape hatch (direct access for debugging, `wrangler tail`, etc.) rather than removing it as part of this migration.

### Step 6 — Re-run the full adversarial audit
- Everything verified in the Phase 0.2 independent security audit (forged/tampered/expired sessions, logout replay, deep-linking, multi-tab, rate limiting, malformed input) should be re-run against the new same-origin path after Steps 1–4 land, exactly as rigorously as before — a cookie-scope and CSRF-transport change is precisely the kind of thing that class of testing exists to catch.

### What does *not* need to change
- `middleware/requireAuth.ts`, `middleware/requireRole.ts`, `services/admin/sessionService.ts`, `services/admin/authService.ts`, D1 schema — none of this depends on which origin the request arrived from. Only the cookie attributes, the CSRF-token transport, and CORS are in scope.

## Current state

- Production Worker: **both** endpoints live (`workers.dev` unchanged; new same-origin route added and verified).
- Production D1: clean — no leftover test data.
- Code: PoC changes (`backend/routes/health.ts`, `backend/wrangler.jsonc`, `backend/worker/index.ts`) committed locally, not yet pushed.
- No endpoint migration (Steps 1–6 above) has been started. Awaiting go-ahead before touching the admin auth cookie/CSRF code again.
