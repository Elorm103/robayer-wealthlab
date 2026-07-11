# Payment Verification — Version 1.2 Sprint 2.4

## Status

**Verification only. Nothing in this sprint delivers an ebook, issues
a receipt, or grants access to anything.** The output of this sprint
is a single durable fact recorded in D1: whether a given purchase
session has been genuinely, provider-confirmed paid. Sprint 2.5
(Secure Ebook Delivery) is the only code allowed to act on that fact.

Sprint 2.3 (Commerce Foundation) built the pre-payment half of
checkout — validate a product, create a purchase session, redirect to
Paystack. This sprint builds the other half: confirming, with high
confidence, that money genuinely moved before anything is ever allowed
to treat a purchase as real.

## Core principle

Nothing from the browser is ever trusted to mean "payment succeeded" —
not a redirect, not a query parameter, not anything read from
`window.location`, `localStorage`, or JavaScript state. **The only
trusted payment confirmation is a direct, authenticated call to
Paystack's own verify endpoint**, triggered by a signed webhook. See
"Trust boundaries" below for the complete reasoning, and
`docs/commerce-foundation.md`'s own "Core principle" for the
checkout-side half of this same posture (the frontend never sends
price/currency, and never will).

## Verification lifecycle

```
Visitor completes payment on Paystack's hosted page
        ↓
Paystack sends a signed webhook: POST /api/webhooks/paystack
        ↓
routes/webhooks.ts verifies the signature (reject if invalid)
        ↓
routes/webhooks.ts parses/shape-checks the payload (reject if malformed)
        ↓
commerceService.handlePaymentWebhook() — see "Webhook flow" below
        ↓
  payment_transactions row recorded (idempotency layer 1)
        ↓
  purchase_sessions row looked up by reference
        ↓
  rejected if: not found / already resolved / expired
        ↓
  for charge.success: provider.verifyPayment() — the ONLY
  authoritative call — checks status/amount/currency/metadata
  against the LOCKED checkout-time values, plus a fresh
  product-still-valid check
        ↓
  purchase_sessions atomically transitions to 'verified'
  (idempotency layer 2)
        ↓
Ready for Sprint 2.5 to ask: getPurchaseVerificationStatus()
```

See `docs/payment-lifecycle.md` for the full visitor-to-delivery
diagram this fits into.

## Webhook flow

`POST /api/webhooks/paystack` (`backend/routes/webhooks.ts`) is
intentionally the thinnest possible HTTP layer:

1. Read the **raw** request body as text — before any JSON parsing.
   Signature verification must run over the exact bytes Paystack sent;
   parsing and re-serializing JSON can reorder keys or change
   whitespace, which would silently break every signature check.
2. Verify `x-paystack-signature` (`backend/utils/webhookSignature.ts`)
   — reject immediately, before touching the payload at all, if it
   doesn't match.
3. Parse the raw body as JSON; reject if it doesn't parse or is
   missing `event` / `data.reference` / `data.amount` / `data.currency`
   in the expected shape.
4. Hand off to `commerceService.handlePaymentWebhook()` — every
   business decision from here happens in the Commerce Service, never
   in the route. See "Commerce Service" below.
5. Always respond `200` once the request itself was authentic and
   well-formed, regardless of what step 4 decided internally. See
   "Failure handling" below for why.

## Trust boundaries

The single most important design decision in this sprint: **the
webhook payload's own `data` fields (status, amount, currency,
metadata) are never used to decide whether a payment succeeded.**
Only `provider.verifyPayment(reference)` — a fresh, separately-
authenticated `GET /transaction/verify/:reference` call to Paystack's
own API, using the account's secret key — is trusted for that
decision. The webhook is a **signed trigger**, telling the Worker
*which* reference to go verify; it is not itself the source of truth.

This is a deliberately doubled defense, not redundancy for its own
sake:

- Signature verification proves the request came from Paystack.
- The separate `verifyPayment()` call proves the *current* state of
  that specific transaction, queried directly and authenticated with
  the secret key — immune to any tampering that could theoretically
  happen to a webhook payload in transit or in a queue, and immune to
  Paystack itself ever sending an inconsistent webhook body (an
  extremely unlikely provider bug, but the cost of not depending on it
  is zero).

The webhook payload's `data.amount`/`data.currency` ARE still recorded
— into `payment_transactions`, this project's raw, unverified audit
log of what was *reported* (see "Idempotency" below) — but never into
`purchase_sessions`, and never used in any verification decision.

**What the frontend can never influence, structurally, not just by
validation:** price, currency, product identity, and purchase status.
Every one of these is either (a) looked up server-side from
`content/products/{slug}.json` at checkout time and locked onto the
`purchase_sessions` row, or (b) confirmed directly by Paystack's own
verify response at verification time. There is no code path, in
either sprint, where a client-supplied value reaches a verification
decision.

## Purchase state machine

`purchase_sessions.status`:
`pending | verified | failed | expired | cancelled | refunded`

```
                    ┌──────────────────────────────┐
                    │           pending             │  (created by checkout — Sprint 2.3)
                    └──────────────────────────────┘
                       │        │        │       │
        charge.success │        │        │       │ TTL passes,
        + all checks   │        │        │       │ no resolution
        pass           │        │        │       │
                        ▼        │        │       ▼
                  ┌──────────┐   │        │  ┌─────────┐
                  │ verified │   │        │  │ expired │
                  └──────────┘   │        │  └─────────┘
                                  │        │
              charge.failed, OR  │        │  (schema-provisioned,
              any verification   ▼        │   not reachable by any
              check fails  ┌──────────┐   │   code this sprint)
                            │  failed  │   │
                            └──────────┘   ▼
                                      ┌───────────┐
                                      │ cancelled │
                                      └───────────┘

  verified ──(future refunds sprint, not this one)──▶ refunded
```

### Transition table

| From | To | Trigger | Where |
|---|---|---|---|
| *(none)* | `pending` | Checkout session created | `commerceService.createCheckoutSession()` (Sprint 2.3) |
| `pending` | `failed` | `initialize` call itself throws | `createCheckoutSession()` (Sprint 2.3) |
| `pending` | `failed` | Webhook: `charge.failed` for a still-pending session | `handlePaymentWebhook()` |
| `pending` | `failed` | Webhook: `charge.success`, but any verification check fails (status/amount/currency/metadata/product-validity) | `handlePaymentWebhook()` |
| `pending` | `verified` | Webhook: `charge.success`, every check passes | `handlePaymentWebhook()` → `verifySessionAtomic()` |
| `pending` | `expired` | Any webhook arrives (or a future read) for a session past `expires_at` | `handlePaymentWebhook()` → `transitionSessionAtomic()` |
| `pending` | `cancelled` | *Not reachable this sprint* — schema-provisioned for a future admin action |
| `verified` | `refunded` | *Not reachable this sprint* — `refundPayment()` remains a documented stub, see "Future refunds" |

Every transition out of `pending` is **one-way and terminal** this
sprint — nothing un-expires, un-fails, or un-cancels a session. An
operator needing to override an outcome (e.g. the "expired but paid"
edge case below) is a manual, out-of-band action, not a code path,
until an admin dashboard exists.

### Why `abandoned` was removed and `cancelled`/`refunded` were added

Sprint 2.3's original enum was `pending | paid | failed | abandoned |
expired`. Revised this sprint:

- **`paid` → `verified`.** This project's Worker *verifies* a payment
  — "paid" undersold what actually happens (status/amount/currency/
  metadata all cross-checked against a provider-confirmed source).
- **`abandoned` removed.** Sprint 2.3's own freeze audit already found
  this state was never reachable by any code — a webhook-driven design
  has no natural trigger for "the buyer opened checkout and walked
  away" (Paystack simply never sends a webhook for that case; there is
  nothing to react to). Paystack's own "abandoned" transaction status,
  on the rare occasion `verifyPayment()` reports it, is treated as this
  table's `failed` — see `PaymentStatus` in
  `backend/services/payments/types.ts` for the provider's own
  vocabulary, kept distinct from this table's business vocabulary.
- **`cancelled`/`refunded` added**, per this sprint's brief. Neither
  is reachable by any code this sprint — `cancelled` awaits a future
  admin action, `refunded` awaits a future refunds sprint
  (`refundPayment()` stays a stub, see below). Declared explicitly
  rather than left implicit, matching the same pattern Sprint 2.3
  already established for `abandoned`.

## Idempotency

Two independent layers, each closing a different race:

**Layer 1 — `payment_transactions.paystack_reference UNIQUE`.**
Every webhook delivery attempts `INSERT OR IGNORE` into
`payment_transactions` keyed by Paystack's own reference. If a row
already exists, this is a duplicate delivery of an already-seen
transaction — logged (`webhook.duplicate`), and processing stops
immediately, before any further logic runs. This is atomic at the
database layer (SQLite's own UNIQUE-constraint enforcement), not a
`SELECT`-then-`INSERT` — there is no window where two near-simultaneous
deliveries of the same webhook could both pass a "does this exist?"
check before either writes.

**Layer 2 — status-gated conditional `UPDATE` on `purchase_sessions`.**
Every state transition (`transitionSessionAtomic()`,
`verifySessionAtomic()`) is a single `UPDATE ... WHERE status =
'pending'`, checked via rows-affected. If a session was already
resolved by a different request in the meantime, the `UPDATE` affects
zero rows and the caller treats it as a duplicate rather than
re-processing. This closes a narrower race than layer 1: two
*different* `payment_transactions` rows (e.g. a genuinely retried
Paystack-side charge attempt with its own new reference) somehow both
resolving to the same `purchase_sessions` row concurrently.

Neither layer depends on the other; either alone would already prevent
double-processing the common case (Paystack retrying an identical
webhook delivery), but together they also cover the rarer case above.

## Replay protection

**Idempotency-by-reference *is* this project's replay protection** —
not a separate mechanism. Every field in a webhook payload is covered
by the HMAC signature; an attacker who captured a valid, signed
webhook cannot alter *any* field (amount, reference, metadata) without
invalidating the signature, so the only thing they could do is replay
the exact payload verbatim — which layer 1's idempotency guard
recognizes and no-ops, regardless of how many times or how long after
the original delivery it's replayed.

**Deliberately not implemented: a timestamp-freshness window.**
Paystack's webhook signature does not include a verified timestamp
component the way some other providers' schemes do (e.g. a `t=…`
prefix covered by the same HMAC) — there is no provider-guaranteed
value to check freshness against without trusting an unverified field
in the JSON body itself. Given idempotency-by-reference already
neutralizes the practical impact of a replay (the same transaction can
never be double-processed, no matter when a copy of its webhook
arrives), a freshness window would add complexity without closing a
gap that's actually open. Documented as a deliberate choice, not an
oversight — revisit if Paystack's documentation is found to provide a
signed timestamp field usable for this.

## Metadata verification

The sprint brief requires, at minimum: purchase reference, product ID,
product slug, product version. All four are:

1. **Locked at checkout time** (`commerceService.createCheckoutSession()`,
   extended this sprint) — read from `content/products/{slug}.json`
   via `productCatalogService.ts` (now also parsing `id`/`version`),
   stored on the `purchase_sessions` row, and sent to Paystack's
   `initialize` call as top-level `metadata` fields (not just inside
   the cosmetic `custom_fields` array).
2. **Re-confirmed at verification time** (`metadataMatches()` in
   `commerceService.ts`) — the `metadata` object `provider.verifyPayment()`
   returns (echoed back by Paystack from what was originally sent) is
   compared field-by-field against the LOCKED values on the
   `purchase_sessions` row. Any mismatch — missing, wrong type, or a
   different value — fails verification outright (`reason:
   metadata_mismatch`), no partial credit.

**Why compare against the LOCKED values, not a fresh re-fetch:** a
legitimate content edit mid-checkout (an admin bumping a product's
`version` between checkout and payment) should be caught as a genuine
inconsistency worth investigating, not silently smoothed over by
re-deriving "current" values and finding they happen to differ for an
innocent reason. This is a deliberately conservative choice — see
"Verification rules" below for the same reasoning applied to price.

## Verification rules

Every check `handlePaymentWebhook()` performs, in order, any one of
which stops the whole flow and fails the session:

1. **Idempotency** — not a duplicate webhook delivery (layer 1, above).
2. **Purchase session exists** — the reference resolves to a real
   `purchase_sessions` row.
3. **Purchase session not already resolved** — `status === 'pending'`.
4. **Purchase session not expired** — `now() <= expires_at`.
5. **Payment succeeded** — `provider.verifyPayment()` reports
   `status === 'success'` (the authoritative call, never the webhook
   payload's own `data.status`).
6. **Amount matches** — `verifyPayment()`'s `amountPesewas` equals the
   value LOCKED on the `purchase_sessions` row at checkout time (never
   a fresh re-derivation — see "Pricing" reasoning in
   `docs/commerce-foundation.md` for why the checkout-time lock is
   itself already the correct source of truth for "what Paystack was
   asked to charge").
7. **Currency matches** — same reasoning, against the locked value.
8. **Metadata consistent** — purchase reference / product ID / product
   slug / product version all match the locked values (see above).
9. **Product still valid** — a fresh re-fetch of
   `content/products/{slug}.json` still reports `isPurchasable()` true
   (catches a product pulled from sale between checkout and payment —
   distinct from a mere price change, which is tolerated via the
   locked-amount comparison above).

Only after all nine pass does the session atomically become
`verified` (idempotency layer 2, above).

## Failure handling

**User-safe errors.** The webhook route's own error responses
(`INVALID_SIGNATURE`, `VALIDATION_ERROR`) use the same
`jsonError()`/`ERROR_STATUS` machinery as every other endpoint —
generic, pre-written messages, never a raw exception, stack trace,
internal SQL, or internal reference. This matters less for this
specific route (its "client" is Paystack, not a browser) but keeping
the convention uniform costs nothing and avoids a special case.

**A transient provider-call failure never permanently fails a genuine
purchase.** If `provider.verifyPayment()` itself throws (a network
blip, a Paystack outage), the session is left `pending`, not `failed`
— Paystack's own webhook retry mechanism, or a later manual check,
gets another chance. Only a *definitive* negative answer from Paystack
(status not `success`, or an amount/currency/metadata/product-validity
mismatch) fails the session.

**A legitimately expired-but-paid session is flagged, never silently
dropped.** If `charge.success` arrives for a session whose TTL already
passed, the session becomes `expired` (not `verified`) — but this is
logged at error severity (`verification.expired_but_paid_needs_review`)
specifically because money genuinely moved and this project is
declining to honor it. This needs human reconciliation (extend the
session, manually verify and fulfil, or refund) — an operational gap
explicitly deferred to an admin workflow, not resolved by more code
this sprint. See "Deferred work."

**Every webhook is acknowledged with `200` once authentic and
well-formed**, regardless of the business outcome — see "Webhook
flow" above for why (prevents Paystack retry-storms for decisions that
will never change).

## Logging

Every event name the brief requires, plus a few this design needed —
all via the existing structured logger
(`backend/utils/logger.ts`, unchanged):

| Event | Logged when |
|---|---|
| `verification.started` | A `charge.success` webhook begins the real verification path (after idempotency/session/expiry checks pass) |
| `verification.passed` | Every check succeeded; session is now `verified` |
| `verification.failed` | Any verification check failed (reason included: `provider_status_not_success`, `amount_or_currency_mismatch`, `metadata_mismatch`, `product_no_longer_valid`, `purchase_session_not_found`, `provider_reported_charge_failed`) |
| `verification.expired` | A webhook arrived for an already-expired session (not itself a `charge.success`, or a `charge.success` where the anomaly is separately logged as below) |
| `verification.expired_but_paid_needs_review` | A `charge.success` arrived for an already-expired session — the anomaly requiring manual review |
| `verification.provider_error` | `provider.verifyPayment()` itself threw (transient) |
| `webhook.duplicate` | A webhook delivery was recognized as a duplicate (either idempotency layer) |
| `webhook.already_processed` | A webhook arrived for a session already resolved (not `pending`) |
| `webhook.invalid_signature` | Signature verification failed |
| `webhook.malformed_payload` | The body didn't parse, or was missing required fields |
| `webhook.unhandled_event` | A validly-signed webhook for an event type this Worker doesn't act on |

## Commerce Service

All verification logic lives in `backend/services/commerceService.ts`
— extended, not bypassed, per the sprint brief. `routes/webhooks.ts`
calls exactly one function, `handlePaymentWebhook()`, matching the
existing thin-route pattern already established for `checkout.ts`
(Sprint 2.3). No D1 access, no payment-provider call, and no
business-rule decision happens in the route.

`commerceService.ts` also exports `getPurchaseVerificationStatus()` —
a small, read-only, purely-descriptive function answering exactly the
question Sprint 2.5 needs: "has this purchase been verified?" It
grants nothing and performs no side effect; it exists in this sprint
(not Sprint 2.5) because correctly interpreting
`purchase_sessions.status` is this sprint's responsibility, and
Sprint 2.5 should never need its own logic to do so.

## Payment provider

`backend/services/payments/paystackProvider.ts`'s `verifyPayment()` is
now implemented — a `GET /transaction/verify/:reference` call using
the account's secret key, mapping Paystack's response onto
`VerifyPaymentResult` (`status`, `amountPesewas`, `currency`,
`customerEmail`, `providerReference`, `metadata`). `refundPayment()`
remains exactly as Sprint 2.3 left it: typed, stubbed, throwing a
clear "not implemented — see Future refunds" error. See "Future
refunds" below.

## Email strategy

Per the sprint brief: if the payment provider returns a verified
customer email, it is stored and treated as authoritative — an
optional frontend-collected email (were one ever added, per Sprint
2.3's freeze-audit recommendation) would be **overridden**, never
merged or preferred, by whatever `verifyPayment()`'s
`customerEmail` reports.

Concretely: `verifySessionAtomic()` always writes
`verifyResult.customerEmail` into `purchase_sessions.customer_email`
at the moment a session becomes `verified` — there is no code path
that writes a pre-payment email into that column and no code path that
skips overwriting it. This project has still never collected an email
before payment (Sprint 2.3's "frontend sends only productId" constraint
is unchanged this sprint), so in practice `customer_email` is `NULL`
until verification and then becomes whatever Paystack itself confirms
the payer's email to be — the first and only time this project ever
records a "real" customer email, and it is always provider-confirmed,
never client-supplied.

## Database

Both changes are documented in full, with rationale, directly in
`backend/database/schema.sql` and `backend/database/migrations/0003_payment_verification.sql`:

- **`purchase_sessions`**: revised `status` enum (see "Purchase state
  machine" above); new columns `product_id`, `product_version` (locked
  identity/version, for metadata verification), `provider_status`,
  `verified_at`.
- **`payment_transactions`**: `order_id` (referencing the deprecated
  `orders` table — see below) replaced by `purchase_session_id`
  (referencing `purchase_sessions`); new `event_type` column. This
  table is now the primary webhook idempotency ledger (layer 1, above)
  — kept **separate from `purchase_sessions`**, per the sprint brief's
  "keep purchase session separate from fulfilment; do not merge
  concerns": `payment_transactions` is a raw, append-only, one-row-
  per-Paystack-transaction audit log of what the provider reported;
  `purchase_sessions` is this project's own business-state record.
  Neither is a fulfilment table — no delivery-tracking column (a
  download token, a "delivered" flag) exists anywhere in this sprint's
  schema; Sprint 2.5 adds its own table(s) for that, keeping fulfilment
  genuinely separate as instructed.

**Resolved this sprint:** Sprint 2.3's freeze audit flagged an open
question — how does `purchase_sessions` relate to the pre-existing,
never-populated `orders`/`customers`/`products` tables? Resolved by
repointing `payment_transactions` at `purchase_sessions` directly:
`purchase_sessions` **is** this project's order-equivalent record; a
separate `orders` table is not needed on top of it. `products`,
`customers`, and `orders` are now explicitly marked deprecated in
`schema.sql` (not deleted — no real risk either way, since neither was
ever run against a real database, but deleting schema history costs
something and gains nothing). `downloads`/`download_tokens` still
reference the deprecated tables as originally designed; Sprint 2.5
decides their real shape once fulfilment is actually built.

## Future refunds

Not designed in depth yet, unchanged from Sprint 2.3.
`paystackProvider.refundPayment()` remains typed and stubbed
(`RefundResult` with `'refunded' | 'failed' | 'pending'`). Expected
shape when built: admin-triggered only, updating `purchase_sessions.status`
to `'refunded'` and (once Sprint 2.5's fulfilment tables exist)
revoking any outstanding download entitlement for that purchase.

## Delivery integration — implemented in Sprint 2.5

**Done**, and more tightly than originally sketched here. See
`docs/digital-fulfilment.md` for the full architecture.
`commerceService.handlePaymentWebhook()` calls
`fulfilmentService.fulfilPurchase()` directly, synchronously, in the
same function, immediately after `verifySessionAtomic()` succeeds —
not as a separate later call to `getPurchaseVerificationStatus()` as
this section originally anticipated (that function still exists and
is exported, for anything that later needs a read-only "is this
verified?" check outside the webhook flow itself, e.g. the fulfilment
page's status endpoint). Every constraint this section originally
called for held:

- `deliveries` (Sprint 2.5's fulfilment table) keys off
  `purchase_sessions.id`/`purchase_reference`, never a D1
  `products`/`orders` row.
- Fulfilment never writes to `purchase_sessions` itself — `deliveries`
  is a strictly separate table, per this sprint's "do not merge
  concerns" instruction.
- The provider-confirmed email is used as the delivery address,
  passed directly from `verifyResult.customerEmail` (the value this
  exact webhook just confirmed) rather than a separate re-read of
  `purchase_sessions.customer_email` — the same value either way, just
  without an extra D1 round trip since both happen in the same
  function call.

**One correctness property worth restating precisely:** a bug in
`fulfilPurchase()` is caught internally and never propagates back into
`handlePaymentWebhook()` — the `verification.passed` log line and the
`'verified'` status transition both already completed before
fulfilment is even attempted, so nothing about the payment-verification
guarantee this document exists to make is weakened by whatever
fulfilment does next.

## Architecture review — Sprint 2.4 freeze audit

*(Added post-implementation, before freezing the sprint. Review only —
no redesign, no delivery, no receipts. Every claim below was verified
by re-reading the actual shipped code line by line, not recalled from
memory — including one genuine, previously-unflagged correctness risk
found in this pass.)*

### 1. Webhook replay protection

**Duplicate webhook *delivery* is expected and normal** (Paystack may
legitimately redeliver the same event) — what must never happen is
duplicate *processing*. Confirmed: `recordPaymentTransaction()` uses
`INSERT OR IGNORE INTO payment_transactions ... ` keyed on
`paystack_reference UNIQUE`, checked via `result.meta.changes === 1`.
`D1Meta.changes` is a real, officially-typed field
(`@cloudflare/workers-types/experimental/index.d.ts`), confirmed by
direct inspection, not assumed from typecheck passing alone. This is
atomic at the SQLite engine level — two concurrent deliveries for the
same reference cannot both "win" the insert; the one that doesn't
immediately exits via the `isNewTransaction` check without touching
`purchase_sessions` at all. **This is why duplicate processing cannot
occur for a genuinely re-delivered webhook**: the losing request never
reaches any state-mutating code.

**Genuine finding, not previously flagged:** this protection is keyed
on `paystack_reference` alone. If Paystack ever sends more than one
webhook event for the *same* `data.reference` representing genuinely
*different* charge attempts — e.g. a declined card (`charge.failed`)
followed by a successful retry on the same hosted checkout page
(`charge.success`), which is plausible payment-gateway behavior if
Paystack keeps one `reference` alive across multiple attempts within
one checkout session — the second, genuinely successful event would be
misclassified as a duplicate of the first and silently dropped,
leaving a real purchase permanently `failed` despite Paystack later
confirming success. This is **not confirmed** against Paystack's
actual retry semantics (no live account exists to observe it — see
"Known limitations"), but it is a plausible, unverified risk worth
addressing before or during Sprint 2.5 rather than assumed away.
**Recommendation:** before trusting this in production, confirm
whether Paystack's webhook payload includes a per-charge-attempt
identifier distinct from `reference` (commonly `data.id` on similar
gateways) and, if so, key the idempotency ledger on that instead of
(or in addition to) `reference`. Not implemented in this review pass.

### 2. Signature verification

Reviewed `backend/utils/webhookSignature.ts` line by line:

- **HMAC algorithm:** HMAC-SHA512 via `crypto.subtle`, matching
  Paystack's documented signing method.
- **Constant-time comparison:** `constantTimeEqual()` XORs and
  accumulates over every character regardless of where a mismatch
  first occurs, only branching on the final accumulated value — a
  correct, standard implementation. The one early-return (length
  mismatch) leaks nothing secret, since a valid signature's length is
  public knowledge (a fixed-length hex digest), not itself sensitive.
- **Malformed headers:** any non-matching string (garbage, wrong
  length, wrong hex) simply fails the comparison — no exception, no
  special-casing needed.
- **Missing headers:** `if (!signatureHeader) return false` — handles
  the `null` `Headers.get()` returns for an absent header.
- **Invalid signatures:** any non-matching value returns `false`,
  full stop.

All of the above were **executed**, not just read — the real compiled
file was run under Node against 6 test vectors (see "Validation
performed" below); all passed, including a case-insensitive match and
a truncated/malformed signature.

### 3. Payment verification — trust boundary trace

Traced every use of the webhook payload's fields through
`routes/webhooks.ts` → `commerceService.handlePaymentWebhook()`:

- `amountPesewas`/`currency` (from the webhook body): used **exactly
  once**, inside `recordPaymentTransaction()` — written to
  `payment_transactions` as an unverified raw record, never read back
  or compared against anything to make a decision. Confirmed by
  tracing every reference to these two variables in the function body.
- `data.status`: **never read at all.** `routes/webhooks.ts`'s
  `PaystackWebhookPayload` interface doesn't even declare a `data.status`
  field. The only "did this succeed?" signal ever acted on is
  `verifyResult.status`, from a fresh, separately-authenticated call
  to `provider.verifyPayment()`.
- `event` (e.g. `"charge.success"`): used for **routing** — which code
  branch to take — not for a trust decision on its own merits. Worth
  stating precisely: since the webhook is signature-verified before
  this field is even read, routing on it is routing on a
  cryptographically-authenticated assertion from Paystack, not an
  arbitrary client input. The one path that acts on `event` alone
  without an additional `verifyPayment()` call is `charge.failed` →
  session marked `failed` directly. This is a reasonable design (a
  signed "this failed" assertion doesn't need a second API call to
  confirm), but it is the mechanism behind the Section 1 finding above
  — worth being aware the two are connected.
- `metadata`: **never read from the webhook body at all** — only from
  `verifyResult.metadata`, the value `provider.verifyPayment()` itself
  returns, which is Paystack's own verify-endpoint response, not
  anything parsed out of the webhook payload.

**Confirmed:** the Worker never trusts the webhook's own amount,
currency, status, or metadata for any verification decision — only
`provider.verifyPayment()`'s independently-fetched response, exactly
as the sprint's core principle requires.

### 4. Purchase state transitions

Every write to `purchase_sessions.status` in the entire backend
(confirmed exhaustively via `grep`, not sampled):

| From | To | Trigger | Guarded? |
|---|---|---|---|
| *(none)* | `pending` | `insertPurchaseSession()` | N/A (INSERT) |
| `pending` | `failed` | `markPurchaseSessionFailed()` — checkout-time provider error | **No** `WHERE status='pending'` guard (see finding below) |
| `pending` | `failed` | `transitionSessionAtomic()` — `charge.failed`, any verification-rule failure | Yes |
| `pending` | `expired` | `transitionSessionAtomic()` — TTL passed | Yes |
| `pending` | `verified` | `verifySessionAtomic()` — every rule passed | Yes |
| `pending` | `cancelled` | — | Type-accepted by `transitionSessionAtomic()` but **no call site uses it** — unreachable, as documented |
| any | `refunded` | — | Not even in `transitionSessionAtomic()`'s type union — unreachable |

**Minor finding:** `markPurchaseSessionFailed()` (used only at
checkout-creation time, when `provider.createCheckoutSession()`
itself throws) is the one mutator that doesn't use the same
`WHERE status = 'pending'` atomic-guard pattern as the others. In
practice this is safe — it runs synchronously, milliseconds after the
row is created, before any external party could plausibly know the
reference well enough to send a webhook for it — but it's an
inconsistency worth tidying for uniformity, not a live exploit.

**Confirmed: illegal transitions cannot occur.** Every mutating
statement except the one above is gated on `WHERE status = 'pending'`,
and the one exception is only ever reachable while the row is
provably still `pending`. Once a session leaves `pending`, no code
path anywhere in this codebase can move it again — state transitions
are monotonic (one hop from `pending` to exactly one terminal state,
then frozen) **by construction**, not by convention.

### 5. Expired sessions

- **Expired but paid:** handled and logged at `error` severity
  (`verification.expired_but_paid_needs_review`) — the session becomes
  `expired` (never `verified`), and the `payment_transactions` row
  records the event with `status = 'failed'`, but the raw payload
  (including the real amount/currency Paystack reported) is preserved
  in `gateway_response`. **Correction to this document's original
  claim:** this is not "logs only" — it's a durable, queryable D1
  record: `SELECT * FROM payment_transactions pt JOIN purchase_sessions
  ps ON pt.purchase_session_id = ps.id WHERE ps.status = 'expired' AND
  pt.event_type = 'charge.success'` finds every such case today,
  without needing log access.
- **Late webhook (before expiry):** processed normally.
- **Provider retry:** covered by idempotency layer 1, with the Section
  1 caveat.
- **Manual reconciliation:** correctly not built (no admin surface
  exists yet) — but the data needed for it already exists and is
  queryable, per the query above. **Recommendation:** Sprint 2.5 or a
  future admin dashboard should surface this query as a visible report
  rather than requiring someone to know to run it by hand.

### 6. Database consistency

- **`purchase_sessions`:** the only race-prone sequence is the
  two-step insert (`NULL` reference → `UPDATE` with the real one).
  Confirmed safe: lookups are always by `purchase_reference` string
  equality, which cannot match `NULL`, so no webhook can act on a
  session mid-creation.
- **`payment_transactions`:** race-free by the `UNIQUE` constraint
  itself, confirmed via the real `D1Meta.changes` field (see Section
  1) — not merely assumed from TypeScript accepting the code.
- **Cross-request races:** traced the specific scenario of two
  concurrent webhook deliveries for the same reference — the first to
  win `recordPaymentTransaction()`'s insert is the only one that ever
  reaches a `purchase_sessions` mutation; the loser exits immediately.
  The atomic conditional `UPDATE`s (`WHERE status = 'pending'`)
  provide a second, independent backstop even if that reasoning were
  ever wrong under a future architecture change.
- **Future `orders`/deliveries:** don't exist yet; nothing to audit.
  The intended shape (key off `purchase_sessions`, read-only, per
  "Future delivery integration" above) is already documented.

### 7. Security summary

- **Trust boundaries:** confirmed by trace (Section 3) — solid.
- **Replay protection:** confirmed by trace (Section 1) — solid for
  genuine redelivery, with the one flagged, unverified edge case
  around same-reference retry attempts.
- **Idempotency:** two layers; layer 1 (the `UNIQUE` constraint) does
  the actual work under the current architecture; layer 2 (the
  status-gated conditional update) is honest defense-in-depth for a
  race that layer 1 already fully closes today, not a currently-live
  second line of defense against a distinct threat — worth being
  precise about that distinction rather than overclaiming two
  independent protections against the same risk.
- **Logging:** all six required events present and independently
  greppable (`verification.started`, `verification.passed`,
  `verification.failed`, `webhook.duplicate`, `verification.expired`
  / `verification.expired_but_paid_needs_review`,
  `webhook.already_processed`) — confirmed by direct code read.
- **Auditability:** every code path that clears the idempotency gate
  ends in a `payment_transactions` outcome (`success` or `failed`),
  with the raw payload preserved — nothing is silently dropped once
  past that gate.

## Validation performed

- **Typecheck:** `cd backend && npm run typecheck` (`tsc --noEmit`)
  passes cleanly against every new and modified file. Re-run after the
  freeze audit above (which changed only this document) — still
  clean, confirming the review introduced no code drift.
- **Signature verification: executed, not just reasoned about.** The
  real `backend/utils/webhookSignature.ts` was compiled with `esbuild`
  and run directly under Node against six test vectors, each checked
  against an independently-computed HMAC-SHA512 (Node's own `crypto`
  module, not the code under test): a genuinely valid signature is
  accepted; a wrong secret is rejected; a tampered body (one digit of
  the amount changed) is rejected; a missing signature header is
  rejected; a truncated/malformed signature is rejected; an
  uppercase-hex signature header still matches (case-insensitive
  comparison, since hex casing isn't meaningful). All 6 passed. This
  is the one piece of this sprint testable end-to-end without a live
  Paystack account, since HMAC verification has no external
  dependency.
- **Duplicate-webhook behavior, expired-session rejection, incorrect-
  amount/currency/product rejection:** traced by hand against
  `commerceService.handlePaymentWebhook()`'s exact code path for each
  scenario (no live Paystack account exists to generate real signed
  webhooks against, so the D1-dependent paths couldn't be exercised
  end-to-end the same way — see "Known limitations"):
  - *Duplicate webhook*: a second `INSERT OR IGNORE` with the same
    `paystack_reference` returns `meta.changes === 0` —
    `handlePaymentWebhook()` logs `webhook.duplicate` and returns
    immediately, confirmed by reading the exact `recordPaymentTransaction()`
    code path.
  - *Expired session*: `Date.now() > new Date(session.expiresAt).getTime()`
    is checked before any provider call — confirmed the branch fires
    for both `charge.success` (logged as the manual-review anomaly)
    and any other event.
  - *Incorrect amount/currency*: `verifyResult.amountPesewas !==
    session.amountPesewas || verifyResult.currency !== session.currency`
    fails the session before metadata or product checks even run —
    confirmed the comparison is against the row's LOCKED values, not a
    fresh re-fetch.
  - *Incorrect product*: `metadataMatches()` requires an exact
    `productId`/`productSlug`/`productVersion` match against the
    locked row; a fresh `fetchCatalogProduct()` + `isPurchasable()`
    re-check runs afterward for currently-still-valid status.
- **Homepage, Books page, Newsletter, Lead Magnet:** live-browser-
  verified with zero console errors — this sprint touched no frontend
  files at all (webhook-only, server-side sprint), so no new browser
  regression surface exists beyond Sprint 2.3's own already-verified
  state.

## Deferred work

- Ebook delivery, receipts, download links, customer accounts — all
  explicitly out of this sprint's scope per the brief; Sprint 2.5.
- Manual reconciliation workflow for the "expired but paid" anomaly —
  logged at error severity this sprint, but no admin tooling exists
  yet to act on it. Genuinely needs a human process (or a future admin
  dashboard feature) until then.
- Refunds — `refundPayment()` remains a stub.
- Deployment of this sprint's Worker changes — not done, per the
  brief, and still gated behind Sprint 2.5 existing (see
  `docs/commerce-foundation.md`'s "Deployment gate," unchanged and
  still in force: this Worker must not run with a real, live-mode
  Paystack key until delivery exists too).

## Known limitations

- **No live Paystack account exists.** Every claim about Paystack's
  exact API/webhook behavior in this document (webhook signing uses
  the account secret key, not a separate webhook secret; `metadata` is
  faithfully echoed back on both webhook and verify responses; event
  names are `charge.success`/`charge.failed`) is based on Paystack's
  publicly documented behavior, not a live-tested integration. If any
  of these prove incorrect once a real account exists, the specific,
  isolated fix is: (a) if webhooks turn out to use a separate signing
  secret after all, add one `PAYSTACK_WEBHOOK_SECRET` env var and pass
  it into `verifyPaystackSignature()` instead of `PAYSTACK_SECRET_KEY`
  — the function signature already takes `secret` as a plain
  parameter, so this is a one-line call-site change, not a redesign.
- **No idempotency key for checkout-session creation itself** (a
  visitor's *own* duplicate Buy clicks, as opposed to Paystack's
  duplicate webhook deliveries) — flagged in Sprint 2.3's own freeze
  audit, unresolved, unrelated to this sprint's webhook-side
  idempotency (which is solid).
- **The "expired but paid" edge case has no automated remediation** —
  logged, not resolved. See "Deferred work."
- **Idempotency is keyed on `paystack_reference` alone, not on a
  per-charge-attempt identifier** — found during the freeze audit
  above ("Webhook replay protection"). If Paystack ever redelivers
  more than one *genuinely different* event (e.g. a failed attempt
  then a successful retry) under the same `reference`, the second,
  real event would be misclassified as a duplicate of the first and
  dropped. Unconfirmed against Paystack's actual retry behavior — no
  live account exists to observe it — but plausible enough to verify
  before relying on this in production. See the freeze audit's
  Section 1 for the recommended fix direction.
- **The route's shape check assumes every webhook Paystack sends has
  `data.reference`/`data.amount`/`data.currency`.** This holds for the
  two charge-related events this sprint handles
  (`charge.success`/`charge.failed`), but Paystack sends other event
  types (e.g. transfer or subscription events) to the same configured
  webhook URL, and it's unconfirmed whether all of them share this
  exact `data` shape. If a differently-shaped event ever arrives, this
  route currently returns `VALIDATION_ERROR` (400) rather than the
  "acknowledge and ignore" (200) treatment `webhook.unhandled_event`
  gives to a recognized-but-unhandled *event name* — a real gap
  between "wrong shape" and "right shape, event we don't act on."
  Worth revisiting once real webhook traffic (of any event type) can
  be observed; not fixed here since it would mean guessing at
  Paystack's other event shapes without a live account to confirm them
  against.
