# Admin Authentication Strategy (Phase 5)

**Status: research and recommendation only. No login page, session
system, or authentication code exists.** This document explains what
this project will use for admin authentication and why — not how to
build it yet.

## Recommendation: two complementary layers, not one

Rather than choosing "Cloudflare Access **or** a traditional login,"
this project recommends both, each solving a different problem:

1. **Cloudflare Access** gates the admin API's existence at
   Cloudflare's edge — before a request even reaches the Worker.
2. **An app-level session** (after Access has verified identity)
   determines *which admin role* that person has, and drives the
   permission checks documented in `docs/admin-module.md`.

### Why Cloudflare Access first

Cloudflare Access can require a recognized identity (via Google, a
one-time email code, or similar) for any request to a configured
path — e.g. everything under `/api/admin/*` — with **zero custom code**.
For a project with one founder and a small number of admins (per
`docs/admin-module.md`'s roles), this is a strong, low-effort first
line of defense: a random internet visitor, or a brute-force script,
never even reaches this project's own login logic, because Access
already rejected them.

### Why not stop at Access alone

Access answers "is this a person we recognize?" — it doesn't know
this project's own concept of **roles** (`super_admin`/`editor`/
`support`, per `backend/database/schema.sql`'s `admin_users.role`).
`POST /api/admin/login` (already scoped in `docs/worker-api-design.md`)
still exists to map a verified identity to this project's own
`admin_users` row and establish a role-aware session — Access confirms
*who*, this project's own login still decides *what they can do*.

## Session mechanism: signed cookie + KV, not a bare JWT

For the app-level session (after Access), the recommendation is:

- An **opaque, random session ID**, stored in a cookie —
  `HttpOnly` (unreadable by JavaScript, mitigating XSS-based theft),
  `Secure` (HTTPS only), `SameSite=Strict` (this admin area has no
  legitimate cross-site linking use case, so the strictest setting
  costs nothing).
- The actual session data (`adminUserId`, `role`, `expiresAt`) stored
  server-side in **Cloudflare KV**, keyed by the session ID, with a KV
  TTL matching the session's own expiration.

**Why not a bare JWT?** A JWT is self-contained and stateless — valid
until its expiry claim, with no server-side lookup needed to trust
it. That's a genuine advantage for service-to-service calls, but a
real drawback for a *human* admin session: **logging out cannot
immediately revoke a JWT** without maintaining a separate revocation
list (which reintroduces the exact server-side state a JWT was meant
to avoid). A KV-backed opaque session means `POST /api/admin/logout`
(already scoped in `docs/worker-api-design.md`) can delete the KV
entry and the session is *instantly* invalid everywhere — including
the "someone's laptop was stolen" scenario, where immediate,
guaranteed revocation matters more than avoiding one KV read per
request. This is also the concrete, genuine use of KV this sprint's
brief asks for ("only where appropriate") — alongside rate-limit
counters (`docs/backend-security.md`), both are short-lived,
high-read-frequency, key-value-shaped data that would be a poor fit
for D1's relational model.

## Session expiration

Recommended: an **absolute** expiration of 12 hours from login
(matching a single working day plus margin, appropriate for a small
admin team, not a high-turnover consumer product) **and** an idle
timeout of 2 hours (a session unused for 2 hours expires even within
the 12-hour window). Both are simple TTL/timestamp checks against the
KV-stored session data — no separate "refresh token" mechanism is
needed at this project's scale; re-authenticating once or twice a
working day is a reasonable, low-friction cost for the security
benefit.

## CSRF protection

Because authentication uses a cookie (not a bearer token manually
attached to each request), **cross-site request forgery is a genuine
risk to design against** — a malicious page elsewhere could otherwise
trigger a state-changing request that rides along with the browser's
existing admin cookie. Two layers, applied together:

1. **`SameSite=Strict`** on the session cookie already stops the
   overwhelming majority of CSRF attempts — the browser simply won't
   attach the cookie to a request originating from another site.
2. **A double-submit CSRF token** as defense in depth for state-
   changing (`POST`/`PUT`/`DELETE`) admin requests: a token issued at
   login, stored in a second, JS-readable cookie *and* required as a
   request header on state-changing calls — a cross-site attacker can
   trigger a request but cannot read the token cookie to attach it
   correctly (browsers' same-origin policy blocks that), so the
   request is rejected. This is `middleware/csrf.ts` in
   `backend/middleware/README.md`.

`GET` requests (e.g., `GET /api/products`) never need CSRF protection
— they don't change state, so there's nothing for a forged request to
exploit.

## Rate limiting (admin-login-specific)

`POST /api/admin/login` is the single most attractive brute-force
target in this whole API. Beyond the general rate-limiting approach in
`docs/backend-security.md`, this endpoint specifically should track
failed attempts **per email** (not just per IP, since a determined
attacker rotates IPs easily) in KV, and apply a short lockout (e.g., 5
failed attempts → 15-minute lockout for that email) — independent of
whether Cloudflare Access already blocked most unauthorized traffic,
since Access alone doesn't stop a *recognized* identity from being
brute-forced if their own password is weak.

## Admin roles

Three roles, matching `backend/database/schema.sql`'s
`admin_users.role` constraint:

- **`super_admin`** — full access, including managing other admin
  users and Settings (see `docs/admin-module.md`'s expanded
  permissions matrix for the full per-module breakdown).
- **`editor`** — day-to-day operations (Products, Orders, Downloads,
  Newsletter, Consultations) — everything except managing other
  admins or account-level Settings.
- **`support`** — read-only access to Orders, Customers, Downloads,
  and Consultations, for handling buyer support questions without the
  ability to change product prices or issue refunds.

Full per-module permission detail is in `docs/admin-module.md`, not
duplicated here — this document defines *how* a role is established
and trusted; that document defines *what* each role can do.
