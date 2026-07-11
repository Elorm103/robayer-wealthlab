# Digital Fulfilment — Version 1.2 Sprint 2.5

## Status

**Fulfilment only. Nothing in this sprint builds a customer dashboard,
refunds, subscriptions, memberships, or analytics.** Those are later
sprints. This sprint's entire job: once a payment is verified (Sprint
2.4), securely grant access to the digital asset(s) that purchase paid
for — and make every step of that grant auditable.

Sprints 2.1–2.4 are complete and frozen; this sprint extends the
webhook-verified payment flow with one more step, and adds the one
real frontend page that flow has needed since Sprint 2.3 first baked
its URL into the checkout callback.

## Core principle

Every decision in this codebase about whether a file may be served is
framed as one question, and only this question:

> Does this purchase currently grant access to this digital asset?

Never "did they pay?" — payment is Sprint 2.4's settled fact, recorded
once as `purchase_sessions.status = 'verified'`. This sprint asks a
narrower, renewable question every single time a download is
requested, because entitlement can change independently of payment
having happened: an asset can be unpublished, a delivery can (in the
future) be revoked, a download limit can be reached, an access window
can expire. Paying once does not mean access is permanent by default —
it means access exists *according to whatever policy that purchase was
granted under*, checked fresh, every time.

## Asset model

A **Digital Asset** is one downloadable file associated with a
product. Assets live in `content/products/{slug}.json`'s
`downloadFiles` array (extending Sprint 2.1's original `{ label, path,
format }` shape — see `content/SCHEMA.md`'s Product entry), not a new
D1 table:

```json
{
  "assetId": "asset-starting-to-invest-with-gh100-pdf-v1",
  "productSlug": "starting-to-invest-with-gh100",
  "filename": "starting-to-invest-with-gh100.pdf",
  "displayName": "eBook (PDF)",
  "fileType": "PDF",
  "fileSizeBytes": null,
  "version": "1.0",
  "checksum": null,
  "storageKey": "ebooks/starting-to-invest-with-gh100.pdf",
  "status": "published"
}
```

| Field | Purpose |
|---|---|
| `assetId` | Stable identifier — the only value a `deliveries`/`download_tokens` D1 row ever references. Never `filename` or `storageKey`, either of which can change without invalidating an already-granted entitlement. |
| `productSlug` | Explicit self-description (which product this belongs to), even though it's also implied by which product's JSON file the entry lives in — an asset object is self-contained, not dependent on caller context. |
| `filename` | The name shown to the buyer's browser on download (`Content-Disposition`). |
| `displayName` | Human label shown on the fulfilment page's Download button (e.g. "Download eBook (PDF)"). |
| `fileType` | `PDF`\|`ZIP`\|`XLSX`\|`DOCX`\|`MP4`\|`MP3`\|`JPG`/`PNG`/etc. — drives the `Content-Type` served (`routes/downloads.ts`). |
| `fileSizeBytes` | `null` until a real file exists to measure — never fabricated. |
| `version` | Locked into Paystack metadata at checkout time (Sprint 2.4) and cross-checked at verification; also the field Future Asset Updates (below) hangs off. |
| `checksum` | Reserved for future use — `null` until a real file exists to hash. Intended as SHA-256, verifiable by a determined buyer or an automated integrity check, never computed from a file that doesn't exist. |
| `storageKey` | The planned R2 object key (`docs/storage-strategy.md`'s bucket layout, e.g. `ebooks/{slug}.pdf`) — **server-only**, never sent to a client. |
| `status` | `draft`\|`published`\|`archived` — independent of the parent product's own `status`, so one file can be pulled or swapped without touching the product's sale status. |

Why content-JSON, not a new D1 table: this is the same architectural
choice Sprint 2.1–2.4 already made repeatedly (`purchase_sessions.product_slug`,
metadata locking) — content describes *what exists*, D1 tracks *what
was transacted*. `deliveries` (below) references an asset by its
`assetId` string, the same pattern `purchase_sessions.product_slug`
already established for products.

`backend/services/productCatalogService.ts` parses `downloadFiles`
into `DigitalAsset[]` server-side, dropping any malformed entry rather
than failing the whole product — the same "drop invalid, don't break
everything" discipline `js/components/product-loader.js` already
applies to its own content.

## Entitlement model

`backend/services/entitlementService.ts` is the one place this
codebase answers the core-principle question. `checkEntitlement(env,
purchaseReference, assetId)` re-derives the answer from nothing but
fresh reads, every single call:

1. **Is the purchase verified?** Reads `purchase_sessions.status`,
   written only by `commerceService.ts`'s webhook-verified flow
   (Sprint 2.4) — never anything else.
2. **Does the asset exist and is it published?** Looked up fresh from
   `content/products/{slug}.json` — an asset pulled after purchase but
   before delivery is honestly unavailable, not silently served from a
   stale cache.
3. **Does a `deliveries` row (the actual entitlement grant) exist for
   this exact (purchase, asset) pair, and is it not revoked?** A
   delivery is never auto-created here — only `fulfilmentService.ts`
   ever grants one (see "Delivery lifecycle" below). No delivery row
   means no entitlement, regardless of payment status.
4. **Is the delivery still within its snapshotted policy** (download
   count, access window)?

Every denial reason (`purchase_not_verified`, `asset_not_found`,
`delivery_not_found`, `delivery_revoked`, `download_limit_reached`,
`access_expired`) is tracked internally for logging, but **never
surfaced to a caller individually** — `routes/purchases.ts` maps every
one to the same generic `DOWNLOAD_NOT_AVAILABLE` response. Distinguishing
them externally would tell a prober which part of a guessed
`(reference, assetId)` pair was wrong.

`generateDownloadPermission()` calls `checkEntitlement()` and, only if
granted, mints a fresh single-use `download_tokens` row (15-minute
TTL, 256 bits of entropy via `backend/utils/downloadToken.ts` —
finally implementing `backend/utils/README.md`'s long-deferred
`generateDownloadToken()` entry).

## Download lifecycle

```
Visitor clicks "Download {asset}" on the fulfilment page
  │
  ▼
POST /api/purchases/:reference/downloads  { assetId }
  │  entitlementService.generateDownloadPermission()
  │  re-checks EVERYTHING above, fresh
  ▼
{ downloadUrl: "/api/download/{token}" }
  │  browser navigates directly to this URL
  ▼
GET /api/download/:token
  │  entitlementService.redeemDownloadToken():
  │    1. Atomically consume the token (UPDATE ... WHERE
  │       used_at IS NULL AND expires_at > now — single-use
  │       and expiry enforced in one statement, no race window)
  │    2. Atomically increment deliveries.downloads_used, only if
  │       still within policy (the REAL enforcement of the download
  │       limit — checkEntitlement()'s own limit check is advisory
  │       only, see "Download policy" below)
  │    3. Resolve the asset's storageKey
  ▼
env.STORAGE.get(storageKey) → streamed directly as the HTTP response
  (Content-Disposition: attachment, Cache-Control: no-store)
```

No presigned URL is ever generated; no R2 API token/signing key exists
in this Worker. This is `docs/storage-strategy.md`'s already-designed
"Option B — Worker-mediated download," now implemented exactly as
specified: the Worker's own R2 *binding* is the only way to reach a
file, and every single request re-validates policy at the moment of
serving, not once at link-generation time.

## Delivery lifecycle

`deliveries` (new D1 table, `backend/database/schema.sql`) is the real
entitlement record — one row per (purchase, asset) pair:

```
(fulfilPurchase() called — see "Fulfilment flow" below)
  │
  ▼
'ready'      — entitlement granted, deliveries row exists,
  │             downloads already work from this point
  │             (email success is NOT a gate on access —
  │             see "Email integration" below)
  ▼
'delivered'  — the fulfilment email was successfully sent
  │             (terminal in this sprint — no code transitions
  │             a delivery away from 'delivered')
  ▼
'revoked'    — NOT reachable by any code this sprint.
               Schema-provisioned for a future refund/admin
               action (same "declared, not yet reachable,
               documented explicitly" pattern as Sprint 2.4's
               'cancelled'/'refunded' purchase_sessions states).
```

Tracked per delivery: `purchase_session_id`, `asset_id` (the "purchase
reference" + "asset ID" pair the brief asks for — `purchase_reference`
itself is one join away via `purchase_sessions`, not duplicated onto
every row), `delivered_at` (delivery time), the implicit "delivery
method" (always `secure_download` — see "Email integration," there is
only one method this sprint), `downloads_used` (download count),
`last_download_at` (latest download), and `status` (fulfilment
status).

**Idempotent by construction:** `deliveries` has a `UNIQUE(purchase_session_id,
asset_id)` index — `fulfilPurchase()` uses `INSERT OR IGNORE`, the
identical pattern Sprint 2.4 established for
`payment_transactions.paystack_reference`. Calling fulfilment twice for
the same purchase (e.g. after a transient failure, or a retried
webhook) never creates a duplicate entitlement or double-sends an
email for an already-fulfilled asset — it recognizes nothing new needs
to happen and returns quietly.

## Download policy

`content/products/{slug}.json`'s existing `downloads` object
(`{ maxPerPurchase, expiresAfterDays }`, present since Sprint 2.1) is
the configurable policy — never hardcoded. At fulfilment time, this
policy is **snapshotted** onto the `deliveries` row
(`max_downloads`, `access_expires_at`), the same "policy at time of
purchase, not whatever the product says today" discipline
`purchase_sessions.amount_pesewas`/`product_title` already established.
A later change to a product's policy never retroactively affects an
already-granted entitlement.

Both fields are nullable, meaning: `maxPerPurchase: null` → unlimited
downloads; `expiresAfterDays: null` → lifetime access. The two extremes
of the brief's policy examples (Unlimited, 5 downloads, Single-use —
`maxPerPurchase: 1`, 30-day access, Lifetime access) are all
expressible with these two fields; no new policy vocabulary was
needed.

**Two-layer enforcement, deliberately not redundant with itself:**
`checkEntitlement()` pre-checks the limit as an advisory ("don't mint a
token that could never be redeemed"), but the actual, final enforcement
is the atomic `UPDATE deliveries SET downloads_used = downloads_used +
1 ... WHERE downloads_used < max_downloads` at redemption time — the
only point that can never race, since two concurrent redemptions right
at the limit boundary are resolved by the database itself, not by
application-level logic that ran moments earlier.

## Fulfilment flow

```
Verified Purchase                purchase_sessions.status = 'verified'
  │                               (Sprint 2.4, unchanged)
  ▼
Entitlement Check + Grant        fulfilmentService.fulfilPurchase(),
  │                               called from commerceService.ts
  │                               immediately after verification —
  │                               never earlier, never independently
  │                               triggered by anything client-facing
  ▼
Generate Secure Download          Not done eagerly here — see
  │  (deferred to first click)    "Download lifecycle" above. Only an
  │                                entitlement (deliveries row) is
  │                                created now; a token is minted only
  │                                when the customer actually clicks
  │                                Download, matching
  │                                docs/storage-strategy.md's "a fresh
  │                                token is only ever minted at that
  │                                exact moment."
  ▼
Record Delivery                   deliveries row created (status: 'ready')
  ▼
Email Customer                    purchase-receipt + secure-download
  │                                emails sent via the existing
  │                                emailService.ts — see "Email
  │                                integration" below
  ▼
Ready for Future Downloads        deliveries row now 'delivered';
                                   entitlement remains usable from the
                                   fulfilment page for as long as its
                                   policy allows
```

**Never throws back into the payment-verification flow.**
`fulfilPurchase()` catches everything internally and logs it — a bug
in fulfilment must never retroactively make a genuinely verified
payment look unverified. See `backend/services/fulfilmentService.ts`'s
own doc comment, and "Deferred work" below for what happens if
fulfilment fails partway.

## Email integration

Two emails, reusing `backend/services/emailService.ts` exactly as
every prior triggering action already does — **no second
email-sending code path**, per the brief's explicit "do not duplicate
email logic":

- `purchase-receipt` — product, amount paid, purchase reference.
- `secure-download` — links to the fulfilment page
  (`/checkout/callback/?ref={reference}`), **never** a direct file or
  token link. The email is a pointer to where a fresh link can be
  requested, not the link itself — identical reasoning to
  `docs/storage-strategy.md`'s original design for the (still
  unbuilt) "resend my download" flow, now the *only* download path
  this sprint has, not a separate one.

Both are added to `backend/emails/README.md`'s already-planned
template list (`purchase-receipt.html`, `secure-download.html`), the
two entries that sprint's own planning left for "Orders/Payments/Downloads."

**Email success is not an access gate.** A `deliveries` row reaches
`'ready'` (fully usable) before either email is even attempted — if
sending fails, the entitlement still works from the fulfilment page
(which the buyer reaches via Paystack's own redirect regardless of
email). Only the `'delivered'` status marking depends on email
succeeding; access itself never does. This directly serves the
sprint's own framing quote: a failed *delivery* must never lose a
legitimate purchase, and here "delivery" (the email) failing doesn't
even touch "access" (the entitlement).

## Frontend

`checkout/callback/index.html` — the page Paystack's `callback_url`
(baked in since Sprint 2.3) has always pointed to, built for the first
time this sprint. `js/components/fulfilment-status.js` drives it:

1. Reads `?ref=` from the URL. Missing → immediate, honest "we
   couldn't find a purchase reference" state, no API call made.
2. Polls `GET /api/purchases/:reference` every 3 seconds (up to 10
   attempts, ~30 seconds) — payment verification is webhook-driven and
   asynchronous, so the page cannot assume the purchase is already
   verified the instant Paystack redirects the browser back.
3. Renders exactly one of three states — `processing`, `ready`,
   `unavailable` — a customer-facing vocabulary deliberately coarser
   than `purchase_sessions`'s six internal status values (see
   "Security" below).
4. In the `ready` state, one Download button per published asset;
   clicking it drives the download lifecycle above.

**No internal identifier is ever rendered** — not a `purchase_sessions.id`,
not a `deliveries.id`, not the raw internal status string. Only
`purchaseReference` (already public — the customer generated the need
to know it by completing a purchase), `productTitle`, `amountDisplay`,
and each asset's `displayName`/`assetId` (needed by the frontend to
request the right download, not itself sensitive — see "Security").

## Security

**Trust boundaries.** The frontend supplies exactly two values across
this whole sprint's new endpoints: a purchase reference (already known
to the customer, generated server-side, never guessable in a way that
grants anything on its own) and an `assetId` (public — every product's
`downloadFiles` are visible in its own public content JSON). Neither
grants access by itself; `entitlementService.ts` re-derives the actual
access decision from D1/content state every time, never from anything
the client asserts.

**Never exposes raw storage URLs.** `storageKey` never leaves
`productCatalogService.ts`/`entitlementService.ts`/`routes/downloads.ts` —
no route, response, or email ever contains it. The only way to reach
an R2 object is `env.STORAGE.get()`, called exclusively inside
`routes/downloads.ts`, exclusively after a token has been atomically
redeemed.

**URL guessing.** `download_tokens.token` is 256 bits of entropy
(`crypto.getRandomValues`) — computationally infeasible to guess
within its 15-minute window, independent of rate limiting (defense in
depth, not the primary defense).

**Expired links.** Enforced in the same atomic `UPDATE` that consumes
the token — `expires_at > now` is part of the WHERE clause, not a
separate check.

**Revoked entitlement.** `deliveries.status != 'revoked'` is
re-checked at every redemption, not just at token-mint time — a future
revocation takes effect immediately for any already-minted-but-unused
token too.

**Unpublished assets.** `findPublishedAsset()` is the only way
`entitlementService.ts` ever resolves an asset — an asset moved to
`draft`/`archived` stops being servable immediately, without touching
any `deliveries` row.

**Direct bucket access.** Never possible — no presigned URL is ever
generated, no R2 API credentials exist in this Worker at all, only the
`STORAGE` binding (Cloudflare-managed, not a secret value).

**Asset enumeration.** Knowing a real `(purchaseReference, assetId)`
pair grants nothing without `checkEntitlement()` independently
confirming the purchase is genuinely `verified` and the delivery
genuinely exists — the same "guessing an identifier is harmless
without also having genuine entitlement behind it" principle Sprint
2.3 already established for checkout, applied here to downloads.

**Do not expose internal identifiers.** Every response shape in this
sprint (`FulfilmentStatus`, `GenerateDownloadPermissionResult`) was
designed field-by-field to contain only what a legitimate buyer needs
to see — cross-checked against this exact requirement while writing
`routes/purchases.ts` and `routes/downloads.ts`.

## Digital Asset versioning (future)

Not implemented this sprint (no update-notification system, as
instructed) — but the data shape already supports it without a
redesign:

```
Version 1                    asset.version = "1.0", locked into
  │                          deliveries at fulfilment time (not stored
  │                          on deliveries directly today — see below)
  ▼
Version 2                    A future re-publish bumps
  │                          content/products/{slug}.json's asset
  │                          entry to version = "2.0" (same assetId,
  │                          same storageKey or a new one)
  ▼
Customer still entitled      checkEntitlement() only checks
                             `deliveries` (purchase_session_id, asset_id)
                             — version isn't part of that lookup key,
                             so a version bump never breaks an existing
                             entitlement. The customer's next download
                             simply serves whatever the asset's current
                             storageKey points to.
```

**What this sprint deliberately leaves open, not resolved:** whether a
buyer should be notified of a new version, whether old and new
versions should both remain downloadable, and whether `deliveries`
should snapshot the version a buyer originally received (today it
does not — a re-download always serves the *current* published
version of that `assetId`, not the version that existed at purchase
time). This is a genuine, undecided product question — deferred here
explicitly rather than silently resolved by omission.

## Future customer library

Not built this sprint (would overlap "customer dashboard," explicitly
excluded). The data already exists to build one: `SELECT * FROM
deliveries JOIN purchase_sessions ... WHERE customer_email = ?` would
answer "what has this email address ever purchased and can still
access" completely, without any new table. A future sprint's job is
presentation (a page, an email-based magic-link lookup, or an actual
account system), not new data modeling.

## Future licence management

Not designed in depth. `content/SCHEMA.md`'s Product already reserves
a `license` field (currently `null` on every real product). The
natural extension point, when needed: a `licenseType` value
(`personal-use`/`commercial`/`extended`) on the Digital Asset record
itself (not the product, since a bundle could theoretically ship
assets under different license terms), checked as one more
`entitlementService.ts` gate alongside publication status. Not built,
since no real product has ever needed more than an implicit
personal-use license — building this now would be exactly the kind of
speculative structure this project has consistently avoided elsewhere.

## Validation performed

- **Typecheck:** `cd backend && npm run typecheck` (`tsc --noEmit`)
  passes cleanly against every new and modified file.
- **Download token generation: executed, not just reasoned about.**
  The real `backend/utils/downloadToken.ts` was compiled with `esbuild`
  and run directly under Node: 10,000 generated tokens were all
  well-formed (64 lowercase hex characters — 256 bits) with zero
  collisions, and confirmed to exactly match
  `entitlementService.ts`'s own `TOKEN_PATTERN` validation regex — a
  genuine consistency check between the generator and the validator,
  not merely a code-review assertion that they agree.
- **Fulfilment page, live-tested:** navigated to
  `/checkout/callback/` with no `?ref=` — correctly shows the
  "couldn't find a purchase reference" state immediately, zero API
  calls made. Navigated with a plausible reference — correctly enters
  the polling loop, makes exactly the expected `GET
  /api/purchases/{reference}` request every ~3 seconds, and after 10
  attempts (since the Worker isn't deployed with this sprint's routes,
  matching every prior sprint's "not deployed" state) gracefully gives
  up with an honest, specific message pointing the visitor to their
  email and to support — zero console errors throughout, zero
  unhandled promise rejections.
- **`ready` state rendering:** not exercised live (would require a
  real backend response) — verified by code review only, consistent
  with how Sprint 2.3/2.4 handled paths that need a live backend this
  project doesn't have yet.
- **Homepage, Books page, Newsletter, Lead Magnet:** re-verified live
  — zero console errors, zero regressions. This sprint added one new
  page and one new script include, touching no existing page.
- **Route dispatch with URL parameters:** `worker/index.ts`'s dispatch
  change (from `.test()` to `.exec()`, adding a `params` argument) was
  typechecked against every existing route handler
  (newsletter/contact/consultation/checkout/webhooks) without
  modifying any of them — TypeScript's structural typing confirms a
  3-parameter handler still satisfies the 4-parameter `RouteHandler`
  type.

## Deferred work

- Customer dashboard, refunds, subscriptions, memberships, analytics —
  all explicitly out of scope per the brief.
- A retry/sweep mechanism for a purchase that verified but never
  fulfilled (e.g. a transient D1 error mid-`fulfilPurchase()`) — today,
  the only retry path is Paystack redelivering the same webhook (which
  correctly re-runs fulfilment idempotently) or a future scheduled
  Cron Trigger sweep (the same pattern `email_log`'s own documented,
  still-unbuilt retry consumer already anticipates).
- `RETURNING`-based single-query token consumption — deliberately
  written as two D1 calls instead of one, since this project hasn't
  confirmed `UPDATE ... RETURNING`'s exact behavior against a real D1
  instance; a reasonable future optimization once that's verified.
- Real file size/checksum for the one real digital asset — both `null`
  until a real PDF exists at the asset's `storageKey` (no real file
  exists in this repository or any R2 bucket today).
- Deployment of this sprint's Worker/schema changes — explicitly not
  done, and still gated behind the same "no live Paystack key" rule
  `docs/commerce-foundation.md` established, now for one more reason:
  no real R2 bucket has real objects in it either.

## Known limitations

- No real R2 bucket exists (`docs/storage-strategy.md`'s own "Today"
  section: "No bucket... exists"). `routes/downloads.ts`'s
  `env.STORAGE.get()` call is architecturally complete but has never
  been exercised against a real object — it would correctly return
  `null` and the route would correctly respond `ASSET_UNAVAILABLE`
  today, an honest, non-crashing outcome for genuinely missing
  storage.
- The polling interval/attempt count (3 seconds × 10) on the
  fulfilment page is a reasonable starting value, not derived from any
  measured real-world webhook-delivery latency (no live Paystack
  account exists to measure against) — worth revisiting once real
  traffic can be observed.
- `deliveries` does not snapshot which asset *version* a buyer
  originally received — see "Digital Asset versioning" above for why
  this is a deliberately open, not silently resolved, question.
