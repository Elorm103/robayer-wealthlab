# Worker API Design (Phase 4)

**Status: design only. No endpoint is implemented.** Every request/
response shape below follows the standardized envelope defined in
`backend/types/api-contracts.ts` (Phase 7) — `{ success: true, data }`
or `{ success: false, error }` for every endpoint, no exceptions.

---

## `POST /api/checkout/sessions`

*(Added in Version 1.2 Sprint 2.3 — Commerce Foundation. See
`docs/commerce-foundation.md` for the full architecture. This endpoint
**supersedes** `POST /api/orders` immediately below, which remains
here only as a record of the earlier design — see that section's own
updated note.)*

**Purpose:** Validate a product against the Product Platform
(`content/products/{slug}.json`, not a D1 table — see
`docs/commerce-foundation.md`), create an internal purchase session +
reference, ask the configured payment provider to prepare checkout,
and return a checkout URL for the browser to redirect to. Implemented
in `backend/routes/checkout.ts` → `backend/services/commerceService.ts`.

**Request**
```json
{ "productId": "starting-to-invest-with-gh100" }
```
Nothing else — no email, price, currency, or title. The Worker loads
all product data itself.

**Response (success)**
```json
{
  "success": true,
  "data": { "purchaseReference": "RWL-2026-000001", "checkoutUrl": "https://checkout.paystack.com/..." }
}
```

**Authentication:** None — any visitor may start a purchase.

**Validation:** `productId` must be a plausible slug shape; the
product it resolves to must have `status: "active"` and a real,
positive price/currency — see `docs/commerce-foundation.md`'s "Product
validation."

**Possible errors:** `VALIDATION_ERROR` (malformed/missing
`productId`), `PRODUCT_NOT_FOUND`, `PRODUCT_NOT_ACTIVE` (covers
draft/archived/coming-soon/free — one generic message, see
`docs/commerce-foundation.md`'s "Security"), `PAYSTACK_API_ERROR`
(the provider call itself failed), `RATE_LIMITED`.

---

## `POST /api/orders` *(superseded — see above)*

**Status: this design predates Sprint 2.3 and was never implemented.**
Kept here for history; `POST /api/checkout/sessions` above is the
real, implemented endpoint. Key differences: this design required an
`email` upfront (Sprint 2.3's checkout collects none — see
`docs/commerce-foundation.md`'s email-collection note) and assumed a
D1 `products` table lookup (Sprint 2.3 reads the live
`content/products/{slug}.json` instead — see "Purchase session" in
`docs/commerce-foundation.md`).

**Purpose:** Create a `pending` order record before payment is
attempted — see `docs/database-design.md`'s `orders` table. This lets
an order exist (and be looked up later) even if the buyer abandons
checkout before paying.

**Request**
```json
{ "productSlug": "starting-to-invest-with-gh100", "email": "buyer@example.com" }
```

**Response (success)**
```json
{
  "success": true,
  "data": { "orderReference": "RWL-starting-to-invest-with-gh100-1751760000-x7f2", "amountPesewas": 3900, "currency": "GHS" }
}
```

**Authentication:** None — any visitor may start a purchase.

**Validation:** `productSlug` must match an existing product with
`status = 'active'`; `email` must be a plausible email shape (full
verification isn't possible or necessary here — only used to create/
find the `customers` row and, later, deliver the download).

**Possible errors:** `PRODUCT_NOT_FOUND`, `PRODUCT_NOT_ACTIVE`,
`INVALID_EMAIL`, `RATE_LIMITED` (see `docs/backend-security.md`).

---

## `POST /api/payments/verify` *(superseded — never built)*

**Status: this design predates Sprint 2.4 and was never implemented.**
It assumed a **client-triggered** verify call, fired after a
client-side popup reported success. Sprint 2.3 settled on
Standard/Redirect (no client-side popup exists), and Sprint 2.4's
actual design is **webhook-triggered**, not client-triggered — see
`POST /api/webhooks/paystack` below, the real, implemented endpoint.
Kept here for history; nothing calls this route, and it does not
exist in `worker/index.ts`.

---

## `POST /api/webhooks/paystack`

*(Added in Version 1.2 Sprint 2.4 — Payment Verification. See
`docs/payment-verification.md` for the full architecture, and
`docs/payment-lifecycle.md` for the end-to-end diagram this fits
into.)*

**Purpose:** The single most security-critical endpoint in this
codebase. Receives Paystack's signed webhook, verifies its signature,
and — for a `charge.success` event — performs the actual
server-side Verify Transaction call before trusting anything (never
the webhook payload's own embedded fields). On success, transitions
the matching `purchase_sessions` row to `'verified'`. Triggers no
email and no delivery — that's Sprint 2.5's job, gated on
`commerceService.getPurchaseVerificationStatus()`.

**Request:** Paystack's own webhook payload, e.g.
```json
{ "event": "charge.success", "data": { "reference": "RWL-2026-000001", "amount": 3900, "currency": "GHS", "customer": { "email": "..." }, "metadata": { "purchaseReference": "...", "productId": "...", "productSlug": "...", "productVersion": "..." } } }
```

**Response:** Always `{ "success": true, "data": { "received": true } }`
(HTTP 200) once the request is authentically signed and well-formed —
regardless of what the business logic internally decided. A non-200 is
reserved for a request that isn't genuinely from Paystack or couldn't
be parsed at all. See `docs/payment-verification.md`'s "Failure
handling" for why.

**Authentication:** No bearer token or session — the
`x-paystack-signature` header (HMAC-SHA512 over the raw body, using
the account's secret key) *is* the authentication.

**Validation:** Signature verified before the payload is parsed at
all. Payload shape-checked (`event`, `data.reference`, `data.amount`,
`data.currency` all present and correctly typed). Business validation
(purchase session exists / not expired / not already resolved / amount
and currency match the locked checkout-time values / metadata
consistent / product still valid) happens entirely in
`commerceService.handlePaymentWebhook()` — see
`docs/payment-verification.md`'s "Verification rules" for the full,
ordered list.

**Possible errors:** `INVALID_SIGNATURE` (401), `VALIDATION_ERROR`
(400, malformed payload) — both are the only two paths that return
anything other than success; every other outcome (not found, expired,
already processed, amount mismatch, etc.) is logged and handled
internally, still returning `200`.

---

## `POST /api/newsletter`

**Purpose:** Subscribe an email to the newsletter — closes the "form
submits nowhere" gap in `js/components/newsletter-form.js` flagged in
`docs/admin-module.md`. Triggers the newsletter-welcome email on first
subscribe only — see `docs/email-architecture.md`.

**Request**
```json
{ "email": "reader@example.com", "source": "homepage-footer" }
```

**Response (success)**
```json
{ "success": true, "data": { "status": "subscribed" } }
```

**Authentication:** None.

**Validation:** Plausible email shape; if the email already exists
with `status = 'unsubscribed'`, re-subscribing updates the existing
row rather than erroring (a subscriber shouldn't be told "you already
tried to subscribe once" as a failure).

**Possible errors:** `INVALID_EMAIL`, `RATE_LIMITED`.

---

## `POST /api/contact`

*(Added in Version 1.2 Sprint 3 — flagged as a gap in this document by
`docs/email-architecture.md` when that doc was written, since a
contact-acknowledgement email needs a triggering endpoint that didn't
exist here yet. Same shape as `POST /api/consultation` below.)*

**Purpose:** Submit a general enquiry — closes the "form submits
nowhere" gap for `js/components/contact-form.js`, recording into the
`contact_messages` table (`docs/database-design.md`). Triggers the
contact-acknowledgement email — see `docs/email-architecture.md`.

**Request**
```json
{ "name": "Ama Owusu", "email": "ama@example.com", "phone": "+233...", "message": "..." }
```

**Response (success)**
```json
{ "success": true, "data": { "status": "received" } }
```

**Authentication:** None.

**Validation:** `name`, `email`, `message` required; `phone` optional.

**Possible errors:** `MISSING_REQUIRED_FIELD`, `INVALID_EMAIL`, `RATE_LIMITED`.

---

## `POST /api/consultation`

**Purpose:** Submit a consultation request — closes the same "form
submits nowhere" gap for `js/components/consultation-form.js`,
recording into the `consultation_requests` table. Triggers the
consultation-acknowledgement email — see `docs/email-architecture.md`
for why that email must not sound like a booking confirmation.

**Request:** matches every field the live form (Sprint 3) already
collects — `name`, `email`, `phone` (optional), `country`, `category`,
`description`, `preferredContactMethod`, `consent`.

**Response (success)**
```json
{ "success": true, "data": { "status": "received" } }
```

**Authentication:** None.

**Validation:** `name`, `email`, `country`, `category`, `description`,
`preferredContactMethod` required; `consent` must be `true` (the form
cannot submit without it, matching the live client-side check in
Sprint 3 — this is server-side enforcement of the same rule, not a new
one).

**Possible errors:** `MISSING_REQUIRED_FIELD`, `CONSENT_REQUIRED`,
`INVALID_EMAIL`, `RATE_LIMITED`.

---

## `GET /api/purchases/:reference`

*(Added in Version 1.2 Sprint 2.5 — Digital Fulfilment Platform. See
`docs/digital-fulfilment.md`.)*

**Purpose:** The fulfilment page's (`checkout/callback/index.html`)
one read — "what should I show for this purchase right now?"
Implemented in `backend/routes/purchases.ts` →
`services/fulfilmentService.ts`'s `getFulfilmentStatus()`.

**Request:** no body — `:reference` is the only input.

**Response (success)**
```json
{
  "success": true,
  "data": {
    "status": "ready",
    "purchaseReference": "RWL-2026-000001",
    "productTitle": "Starting to Invest with GH₵100",
    "amountDisplay": "GH₵39.00",
    "assets": [{ "assetId": "asset-starting-to-invest-with-gh100-pdf-v1", "displayName": "eBook (PDF)", "fileType": "PDF" }]
  }
}
```

**Authentication:** None — the reference itself is not a secret (see
`docs/digital-fulfilment.md`'s "Security": knowing a reference grants
nothing without a genuinely verified purchase behind it).

**Validation:** `:reference` must match the `RWL-{year}-{sequence}`
shape. `status` is always one of `processing`/`ready`/`unavailable` —
never `purchase_sessions`'s own six-value internal vocabulary (see
"Do not expose internal identifiers" in the sprint brief this endpoint
was built against).

**Possible errors:** `PURCHASE_NOT_FOUND`, `RATE_LIMITED`.

---

## `POST /api/purchases/:reference/downloads`

*(Added in Version 1.2 Sprint 2.5 — Digital Fulfilment Platform.)*

**Purpose:** What the fulfilment page's Download button actually
calls — re-validates entitlement from scratch and mints a fresh,
single-use download link. Implemented via
`services/entitlementService.ts`'s `generateDownloadPermission()`.

**Request**
```json
{ "assetId": "asset-starting-to-invest-with-gh100-pdf-v1" }
```

**Response (success)**
```json
{ "success": true, "data": { "downloadUrl": "/api/download/{token}", "expiresAt": "2026-07-10T12:15:00.000Z" } }
```

**Authentication:** None — the entitlement check itself is the
access control.

**Validation:** `assetId` required. The full entitlement chain
(purchase verified, asset published, delivery exists and isn't
revoked, within download policy) is re-checked here, not trusted from
an earlier `GET /api/purchases/:reference` response.

**Possible errors:** `PURCHASE_NOT_FOUND`, `VALIDATION_ERROR`,
`DOWNLOAD_NOT_AVAILABLE` (one generic code for every entitlement
denial reason — see `docs/digital-fulfilment.md`'s "Entitlement
model"), `RATE_LIMITED`.

---

## `GET /api/download/:token`

**Implemented — Version 1.2 Sprint 2.5.** See
`docs/digital-fulfilment.md`'s "Download lifecycle" for the live
architecture — matches this section's original design exactly, with
one field-name update: `downloads` → `deliveries` (renamed/repointed
in the same sprint, see `backend/database/schema.sql`'s deprecation
note on the old `downloads` table).

**Purpose:** Redeem a single-use download token and stream the
purchased file — see `docs/storage-strategy.md`'s "Option B" (Worker-
mediated download).

**Request:** no body — `:token` is the only input.

**Response (success):** the file itself (binary response,
`Content-Disposition: attachment`), **not** a JSON envelope — this is
the one endpoint that doesn't return `{ success, data }`, since its
successful response *is* the file. A failed attempt still returns the
standard JSON error envelope.

**Authentication:** None (the token itself is the credential — no
login exists for buyers, per this project's explicit "no
authentication" stance for customers).

**Validation:** Token must exist in `download_tokens`, be unexpired,
and have `used_at IS NULL` — all three checked in one atomic
`UPDATE ... WHERE`, not a read-then-write. On success, `used_at` is
set immediately (before streaming the file) so a concurrent second
request with the same token cannot also succeed.

**Possible errors:** `TOKEN_NOT_FOUND`, `TOKEN_EXPIRED`,
`TOKEN_ALREADY_USED`, `DOWNLOAD_LIMIT_REACHED` (checked against the
parent `deliveries` row), `ASSET_UNAVAILABLE` (added Sprint 2.5 — the
token was valid but the asset itself couldn't be resolved or streamed,
e.g. no real R2 object exists yet).

---

## `GET /api/products`

**Purpose:** List `active` products for a future storefront grid —
the live, real-data counterpart to `js/components/product-loader.js`'s
current dormant, no-op state.

**Request:** optional query string, e.g. `?category=ebook&featured=true`.

**Response (success)**
```json
{
  "success": true,
  "data": [
    { "slug": "starting-to-invest-with-gh100", "title": "...", "priceDisplay": "GH₵39", "category": "ebook", "coverImageUrl": "..." }
  ]
}
```

**Authentication:** None — public product listing.

**Validation:** `category` (if present) must match a known category
slug; unknown query parameters are ignored, not errors.

**Possible errors:** none expected beyond generic server errors — this
is a read-only, unauthenticated endpoint with no user input that can
meaningfully fail validation.

---

## `GET /api/orders/:id`

**Purpose:** Power a "thank you" / order-status page — lets a buyer
(or their browser, immediately after checkout) check whether an order
has been verified yet, without needing an account/login.

**Request:** no body — `:id` is the `order_reference`, not the
internal database `id` (never expose the surrogate integer key
externally).

**Response (success)**
```json
{ "success": true, "data": { "orderReference": "...", "status": "paid", "productTitle": "...", "downloadAvailable": true } }
```

**Authentication:** None, but deliberately returns **only** status
information, never the buyer's email or any other order detail that a
guessed reference shouldn't reveal — the reference itself
(`RWL-{slug}-{timestamp}-{random}`) is long and random enough to not
be practically guessable, but the response is designed to be harmless
even if it somehow were.

**Possible errors:** `ORDER_NOT_FOUND`.

---

## `POST /api/admin/login`

**Purpose:** Authenticate an admin user — see
`docs/authentication-strategy.md` for the full session-design
reasoning.

**Request**
```json
{ "email": "robert@robayerwealthlab.com", "password": "…" }
```

**Response (success):** sets a secure, `HttpOnly` session cookie (see
`docs/authentication-strategy.md`); body confirms success without
echoing anything sensitive:
```json
{ "success": true, "data": { "role": "super_admin" } }
```

**Authentication:** None (this endpoint *creates* authentication).

**Validation:** Email must match an `admin_users` row with
`is_active = 1`; password checked against `password_hash`.

**Possible errors:** `INVALID_CREDENTIALS` (deliberately identical
wording whether the email doesn't exist or the password is wrong, to
avoid confirming which emails have admin accounts), `ACCOUNT_INACTIVE`,
`RATE_LIMITED` (see `docs/backend-security.md` — this endpoint is a
prime brute-force target).

---

## `POST /api/admin/logout`

**Purpose:** End an admin session.

**Request:** no body — the session cookie identifies the session to
end.

**Response (success)**
```json
{ "success": true, "data": null }
```

**Authentication:** Requires a valid existing session (there is
nothing meaningful to "log out" of otherwise).

**Validation:** none beyond the auth check itself.

**Possible errors:** `NOT_AUTHENTICATED` (already logged out, or
invalid/expired session).
