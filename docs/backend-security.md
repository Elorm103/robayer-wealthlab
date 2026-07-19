# Backend Security Review (Phase 6)

**Status: research and documentation only.** Nothing below is
implemented. This document is the Cloudflare-specific security layer
that sits on top of the general principles already established in
`docs/download-security.md` and `docs/paystack-integration.md` —
where a topic is already covered there in depth, this document
cross-references it rather than repeating it.

## Signed download URLs

Already fully designed in `docs/storage-strategy.md` (Worker-mediated
download, two-tier expiry via `downloads`/`download_tokens`). No
further design needed here.

## Paystack webhook verification

**Implemented — Version 1.2 Sprint 2.4.** See
`docs/payment-verification.md`'s "Webhook flow" and "Webhook security."
`backend/utils/webhookSignature.ts` does exactly what this section
originally specified: Paystack sends an `x-paystack-signature` header
containing an HMAC-SHA512 hash of the **raw** request body, computed
using the account's own secret key. The Worker (`backend/routes/webhooks.ts`):

1. Reads the raw request body **before** parsing it as JSON (parsing
   and re-serializing can change whitespace/key order, which would
   change the hash and cause every signature check to fail).
2. Computes the same HMAC-SHA512 over that raw body using the same
   secret key (Web Crypto's `crypto.subtle`, no Node `crypto`
   dependency).
3. Compares the two using a **constant-time comparison** — a naive
   `===` string comparison can leak timing information about how many
   leading bytes matched, which is a known (if narrow) side-channel
   risk for signature checks.
4. Rejects the request (without parsing the payload at all) if the
   signatures don't match — never falls back to "trust it anyway."

One correction from this section's original assumption: Paystack signs
webhooks with `PAYSTACK_SECRET_KEY` (the same key used for API calls),
not a separate `PAYSTACK_WEBHOOK_SECRET` — unlike some other providers.
See `docs/payment-verification.md`'s "Known limitations" for the
confidence caveat (unverified against a live account).

## Replay attack prevention

Three distinct replay scenarios:

- **A webhook delivered more than once** (Paystack explicitly may
  retry) — **implemented Sprint 2.4.** Defense:
  `payment_transactions.paystack_reference` is `UNIQUE`
  (`docs/database-design.md`); `INSERT OR IGNORE` against it is the
  atomic check (not a read-then-decide) — a second delivery for a
  reference already recorded is recognized immediately and returns
  `200` (so Paystack stops retrying) without re-running verification a
  second time. A second, independent layer (a status-gated conditional
  `UPDATE` on `purchase_sessions`) closes a narrower concurrent-request
  race. See `docs/payment-verification.md`'s "Idempotency" and "Replay
  protection" for the full design — idempotency-by-reference *is* this
  project's replay protection, not a separate mechanism.
- **A download token reused.** Defense: `download_tokens.used_at` is
  set the moment a token is redeemed, checked before every use — a
  second request with the same token is rejected regardless of
  whether the first request even finished (see "Download abuse
  prevention" below for the concurrency detail).
- **A CSRF token replayed from a captured request.** Defense:
  `docs/authentication-strategy.md`'s double-submit CSRF pattern is
  paired with the session itself — a CSRF token is only valid for its
  originating session, so replaying a captured request after the
  session ends (logout, expiry) fails regardless of whether the token
  string itself is still "correct."

## Download abuse prevention

Beyond the `maxPerPurchase`/`expiresAfterDays` **policy** already
designed in `docs/download-security.md`:

- **Concurrency-safe token redemption.** Setting
  `download_tokens.used_at` must happen as part of the same operation
  that decides the token is valid (a single atomic D1 statement, e.g.
  `UPDATE download_tokens SET used_at = ? WHERE token = ? AND used_at
  IS NULL`, checking the number of rows affected) — not a
  read-then-write in two steps, which would let two near-simultaneous
  requests with the same token both pass the "is it used?" check
  before either one sets `used_at`.
- **Per-IP rate limiting on `GET /api/download/:token` itself**
  (independent of whether a given token is valid), to slow down
  someone attempting to guess or brute-force token values — see "Rate
  limiting" below for the general mechanism.

## Checkout session creation

*(Added in Version 1.2 Sprint 2.3.)* Full detail in
`docs/commerce-foundation.md`'s "Security" section — summarized here
for anyone scanning this document specifically: price, currency, and
product-availability are never accepted from the client for
`POST /api/checkout/sessions`; the request body carries only a product
identifier, and every other value is loaded server-side from the
Product Platform (`content/products/{slug}.json`). This makes price/
currency/product tampering structurally impossible rather than merely
validated-against — there is no field to tamper with in the first
place. Rate-limited like every other endpoint (10/minute/IP, slightly
more generous than the form endpoints since a legitimate checkout
retry is common).

## Order verification

**Implemented — Version 1.2 Sprint 2.4**, as a webhook-triggered flow
rather than the client-triggered `POST /api/payments/verify` endpoint
originally sketched (no such endpoint exists — see
`docs/worker-api-design.md`'s updated note). Never marks a purchase
verified from a client-supplied value alone; always confirms directly
with Paystack's own Verify Transaction API, checking status, amount,
currency, and metadata against the `purchase_sessions` row (not an
`orders` row — see `docs/payment-verification.md`'s "Database"). Full
detail in `docs/payment-verification.md`.

## Input validation

- **Validate at the edge, not deep in business logic** —
  `middleware/validate.ts` (`backend/middleware/README.md`) applies a
  per-route schema before a route's own handler ever runs, so a route
  never has to defensively re-check "is this field even present."
- **Whitelist, not blacklist.** Every field has an explicit expected
  type, length limit, and (where applicable) enum of allowed values —
  matching the `CHECK` constraints already in `backend/database/schema.sql`
  (e.g. `consultation_requests.preferred_contact_method` only ever
  accepts `email`/`phone`). Rejecting anything that doesn't match the
  expected shape is safer than trying to enumerate every bad input.
- **Escape on output, not just validate on input.** Free-text fields
  (`consultation_requests.description`, `orders`/`customers` names)
  must be HTML-escaped wherever a future admin frontend renders them —
  storing text safely doesn't guarantee it's safe to render as HTML
  later; that escaping happens at render time, in whatever frontend
  eventually displays this data.

## Rate limiting

A single shared mechanism, applied per-endpoint with different
thresholds: a KV counter keyed by `ratelimit:{endpoint}:{ip}` (or
`:{email}` for the admin-login-specific case in
`docs/authentication-strategy.md`), incremented on each request with a
TTL matching the rate-limit window (e.g., a 1-minute fixed window). If
the counter exceeds the endpoint's threshold before the TTL expires,
the request is rejected with `RATE_LIMITED` (the standard error code
used throughout `docs/worker-api-design.md`). Suggested starting
thresholds (tunable at implementation time, not fixed by this
document): form-style endpoints (`newsletter`, `consultation`) a few
requests per minute per IP; `checkout/sessions` 10/minute per IP
(implemented Sprint 2.3); `admin/login` five attempts per 15 minutes
per email (per `docs/authentication-strategy.md`). **Deliberately not
rate-limited:** `POST /api/webhooks/paystack` (implemented Sprint 2.4)
— signature verification is this endpoint's access control, and
Paystack's own delivery can be legitimately bursty; a per-IP limit
here risks dropping genuine webhook deliveries rather than blocking
abuse. See `docs/payment-verification.md`'s "Webhook security."

## Secret management & environment variables

Already fully documented in `backend/config/README.md` — the two real
secrets this project actually has (`PAYSTACK_SECRET_KEY` — which, as of
Sprint 2.4, also verifies webhook signatures, see above — and
`RESEND_API_KEY`) are set via Cloudflare's own `wrangler secret put`
mechanism or dashboard, **never** committed to this repository in any
form, including in `wrangler.jsonc` itself (which holds only non-secret
configuration and binding names). No separate `PAYSTACK_WEBHOOK_SECRET`
exists — see "Paystack webhook verification" above. **`ADMIN_SESSION_SECRET`
was planned here but never built** — admin sessions are validated
against `admin_sessions` D1 rows directly, not a signed token; see
`backend/config/README.md` and `docs/v2.1-technical-debt-register.md`
for the corrected picture, found during the Version 2.1 Phase 7 audit.

## CORS

The Worker API should set `Access-Control-Allow-Origin` to the exact
production origin (`https://robayerwealthlab.com`), never a wildcard
(`*`) — especially important once admin session cookies are involved,
since a wildcard origin combined with credentialed requests is a
well-known misconfiguration that defeats the same-origin protections
cookies are supposed to provide. A second allowed origin for a staging/
preview environment can be added once one exists; no such environment
exists today.

## Content Security Policy

CSP is a response header served by whatever serves the **HTML**, not
the API — relevant to a future admin frontend, not to
`robayerwealthlab.com`'s existing static pages, which this sprint does
not touch. When an admin frontend is eventually built, it should ship
with a restrictive CSP (no inline scripts, no unexpected external
script sources) from day one, since it's far easier to start strict
and loosen deliberately than to retrofit a CSP onto a frontend already
built without one. Adding a CSP to the existing static site's pages is
a separate, optional future consideration — explicitly out of scope
for this sprint's "nothing existing changes" constraint.
