# Version 2.0 — Authentication & Authorization Design

**Grounding:** `admin_users` already exists in production D1 with exactly the shape this design needs (`email`, `password_hash`, `role` CHECK-constrained to `super_admin`/`editor`/`support`, `is_active`, `last_login_at`, `deleted_at`) — confirmed live, confirmed empty. This design uses it as-is (plus the two additive columns from `docs/v2-database-expansion.md`) rather than redesigning it.

---

## Login flow

```
1. POST /api/admin/auth/login { email, password }
2. Rate-limited (new bucket: "admin-login", 5 attempts/15min per IP — stricter than any
   existing rate limit, since credential-stuffing is the realistic threat here, not form spam)
3. Look up admin_users WHERE email = ? AND is_active = 1 AND deleted_at IS NULL
4. Constant-time password verification (see "Password hashing" below)
5. On success:
   a. Create an admin_sessions row (256-bit token, same generateXToken() pattern as
      download/unsubscribe tokens — utils/adminSessionToken.ts, one new file, same
      15-line shape as the two it mirrors)
   b. Set an HttpOnly, Secure, SameSite=Lax cookie containing the session token
      (originally specified as Strict here, briefly corrected to None during a
      cross-origin period, now Lax as of the Version 2.0 Same-Origin Migration —
      see docs/v2-same-origin-architecture.md for the final, permanent model)
   c. Set a separate, readable (non-HttpOnly) CSRF cookie containing the session's csrf_secret
   d. UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?
   e. auditService.record({ actor_type: 'admin', actor_id, action: 'admin.login' })
6. On failure: identical response shape/timing whether the email doesn't exist or the
   password is wrong (never reveal which) — generic "Invalid email or password."
```

## Password hashing

**PBKDF2 via Web Crypto's `crypto.subtle`** — not bcrypt/argon2 (neither is available as a native Workers API without a WASM dependency this project has no other reason to add). Web Crypto's `PBKDF2` with a high iteration count (≥600,000, per current OWASP guidance for PBKDF2-SHA256) and a per-user random salt is a real, credible, native-to-the-runtime choice — matches the project's established "zero-runtime-dependency posture" (already stated explicitly in `utils/downloadToken.ts`'s own comments) rather than introducing a new dependency for a problem the platform can already solve natively. Stored as `salt:iterations:hash`, all in the existing `password_hash TEXT` column — no schema change needed.

## Sessions (not JWT)

**Chosen deliberately over JWT.** A session row in `admin_sessions` can be revoked the instant it's created — deactivate a user, log out everywhere, or respond to a compromised device, and the session stops working on the very next request. A JWT, once issued, remains valid until it expires no matter what the server does in the meantime, unless a separate revocation-list mechanism is built (which is just a database-backed session by another name, with more complexity). For an admin surface — where "revoke access right now" is a real operational requirement, not a hypothetical — a plain server-side session is the more honest, simpler choice.

- **Expiry:** 12 hours of absolute lifetime, refreshed (sliding) on activity up to that cap, `expires_at` checked on every request via `requireAuth`.
- **Storage:** `admin_sessions` (see database-expansion doc) — one row per active login, `revoked_at` set on logout, expired rows cleaned up by a lightweight scheduled task (future Cron Trigger — not required for launch, since an expired row simply fails the `expires_at` check regardless of whether it's been deleted).

## CSRF

**Double-submit cookie pattern.** The CSRF cookie (readable by JS, since the frontend must read it to attach it as a header) and the session cookie (HttpOnly, never readable by JS) are deliberately different cookies with different properties — an attacker who can trigger a cross-site request cannot also read the CSRF cookie's value to forge the matching header, which is the entire point of the pattern. Every mutating admin request (`POST`/`PATCH`/`DELETE`) must include an `X-CSRF-Token` header matching the session's stored `csrf_secret`; `middleware/csrf.ts` checks this before the route handler ever runs, mirroring exactly where `requireAuth` sits in the chain.

## Rate limiting (extends the existing `middleware/rateLimit.ts`, no new mechanism)

| Endpoint | Limit | Reasoning |
|---|---|---|
| `admin-login` | 5 / 15 min / IP | Credential-stuffing resistance |
| Every other `/api/admin/*` route | 120 / min / session (not IP — an admin working quickly through a data table is not abuse) | Generous enough for real use, still a real ceiling |

## 2FA readiness (not built now, designed for)

`admin_users.totp_secret` (nullable, added in the same migration) is the only schema this requires — when a future phase turns 2FA on for a user, it populates that column and the login flow gains one more step (TOTP code verification via Web Crypto's HMAC-SHA1, the same native-runtime approach as password hashing, no new dependency). **Not built in V2.0's first phase** — see `docs/v2-development-roadmap.md` for why this is explicitly deferred rather than half-built.

## Role-based permissions

| Capability | super_admin | editor | support |
|---|:---:|:---:|:---:|
| Products, Blog, Resources — create/edit/publish | ✅ | ✅ | ❌ (view only) |
| Newsletter — send campaigns | ✅ | ✅ | ❌ |
| Consultations, Contacts — respond, assign, note | ✅ | ✅ | ✅ |
| Orders — view, resend receipt/download | ✅ | ✅ | ✅ |
| Orders — refund | — (not built at all, see API expansion doc) | — | — |
| Media Library — upload/delete | ✅ | ✅ | ❌ (view only) |
| Analytics — view | ✅ | ✅ | ✅ |
| Settings | ✅ | ❌ | ❌ |
| User Management | ✅ | ❌ | ❌ |

This maps the brief's 4 named roles (Administrators, Editors, Marketing, Support) onto the 3 that already exist in production, with "Marketing" capabilities (newsletter, blog) granted to `editor` rather than invented as a 4th role — see the database-expansion doc's reasoning. If a real future need for a narrower marketing-only role emerges (e.g., someone who should send newsletters but not touch product pricing), that's a real, well-scoped follow-up, not a V2.0 blocker.

## Audit logging (every login, every mutation)

`auditService.record()` is the single function every authenticated mutation calls — never a route or a raw `INSERT` scattered across service files. Logged: `admin.login`, `admin.logout`, `product.created/updated/archived/published`, `blog_post.created/updated/published/scheduled`, `resource.uploaded/replaced/archived`, `newsletter_campaign.sent`, `consultation.status_changed/assigned`, `media.uploaded/deleted`, `settings.updated`, `admin_user.created/role_changed/deactivated`. Uses the exact existing `audit_logs` shape (`actor_type`, `actor_id`, `action`, `entity_type`, `entity_id`, `metadata` JSON with a `before`/`after` diff where meaningful) — already correct, already indexed, needs zero schema change.

## Secure uploads (summarized here, full detail in media-library-spec.md)

Every upload passes through server-side validation *before* touching R2: content-type allowlist (no executable/script MIME types ever accepted), a hard size ceiling per asset type, filename sanitization (no path traversal, no control characters) — enforced in the Worker, never trusted from the client's own `Content-Type` header alone (the Worker inspects the actual file bytes' magic number for images/PDFs, not just the claimed header).

## Input validation, SQL injection, XSS — inherited, not reinvented

Every new route reuses the existing `middleware/validate.ts` field-validator pattern and D1's prepared-statement binding (`.bind()`) — the exact same mechanism that has protected every public endpoint since Version 1.0, with zero raw string interpolation into SQL anywhere in this codebase's history. Blog post `body_html` is the one genuinely new XSS surface (rich text, admin-authored but still untrusted input by policy) — sanitized server-side on every save via an allowlist-based HTML sanitizer (a real, justified new dependency — see risk assessment for why this is the one exception to "no new dependencies").
