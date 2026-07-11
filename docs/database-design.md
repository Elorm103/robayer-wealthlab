# D1 Database Design (Phase 2)

**Status: design only.** `backend/database/schema.sql` has never been
run against a real database — no D1 instance exists. This document
explains the reasoning behind every table in that file: primary keys,
relationships, indexes, constraints, timestamp conventions, and
soft-delete strategy, as this sprint's brief requires.

## Conventions applied to every table

- **Primary key:** every table uses a surrogate `INTEGER PRIMARY KEY
  AUTOINCREMENT`, plus a natural unique key where a real one exists
  (`slug`, `email`, `order_reference`, `token`). A surrogate key means
  a natural key can be corrected later (e.g., an admin's email
  changing) without cascading updates through every table that
  references it.
- **Timestamps:** `created_at`/`updated_at` on every table (matching
  the `publishedDate`/`updatedDate` convention already used throughout
  `content/`), stored as ISO 8601 text — D1/SQLite has no native
  datetime type, and text keeps values both human-readable and
  correctly sortable.
- **Money:** stored as an integer in the smallest currency unit
  (pesewas for GHS) — `price_pesewas`, `amount_pesewas` — never a
  float, to avoid rounding-error bugs in a financial context. This is
  a deliberate difference from `content/products/{slug}.json`'s
  `price` field, which stays a plain display number (e.g. `39`) for
  content-authoring convenience (see `content/products/README.md`).
  The conversion between the two happens exactly once — in
  `backend/services/commerceService.ts`'s `createCheckoutSession()`
  (implemented Version 1.2 Sprint 2.3, see
  `docs/commerce-foundation.md`), the single call site that actually
  needs it, rather than a generically-named standalone utility with
  one caller.

## Table-by-table

### `products`, `customers`, `orders` — deprecated (Version 1.2 Sprint 2.4)

**Not built against by any live code.** See
`backend/database/schema.sql`'s deprecation note directly above these
three tables, and `docs/payment-verification.md`'s "Database": Sprint
2.1 pivoted the real product catalog to `content/products/{slug}.json`
files, so `products` was never populated; Sprint 2.3's `purchase_sessions`
became the real checkout record; Sprint 2.4 repointed
`payment_transactions` at `purchase_sessions` directly, formally
retiring `orders`/`customers` as the intended order/customer store.
Kept in the schema file for design history, not deleted — the
rationale below is preserved as a record of that earlier design, not
as current guidance.

### `products`

- **Primary key:** surrogate `id`; `slug` is a separate unique key
  matching `content/products/{slug}.json`'s filename.
- **Relationships:** referenced by `orders.product_id` and
  `downloads.product_id`. `category` is intentionally a plain `TEXT`
  column, **not** a foreign key to a D1 `categories` table — this
  sprint's table list doesn't include one, and categories are
  slow-changing content (four values, defined in
  `content/categories/index.json`, per Sprint 1), not transactional
  data. Adding an 11th table to enforce a constraint on data that
  changes maybe once a year would be exactly the kind of premature
  structure this project avoids elsewhere. *(Version 1.2 Sprint 2.1
  note, no backend change made here: the content-layer schema this
  column was designed to mirror has since renamed `category` to
  `productType` and split out a separate `topic` field —
  `content/product-types/`/`content/topics/`, see
  `docs/product-platform-architecture.md`. Whoever first actually
  creates this D1 table should reconcile the column name/count with
  the current content schema rather than this document's original
  Sprint 2 wording — out of scope for a "no backend changes" sprint to
  fix here.)*
- **Indexes:** `category` and `status`, since a future storefront's
  most common query is "active products in category X."
- **Constraints:** `status` is restricted to `draft`/`active`/`archived`
  via `CHECK`, matching `content/products/README.md`'s existing
  definition of that field — the database enforces the same rule the
  content schema already documents, rather than trusting application
  code alone to never write an invalid value.
- **Soft delete:** yes (`deleted_at`). A product might need to be
  pulled from sale without losing its order history — every `orders`
  row referencing it must remain valid and queryable.

### `customers`

- **Primary key:** surrogate `id`; `email` is the natural unique key.
- **Relationships:** referenced by `orders.customer_id`.
- **Indexes:** none beyond the unique index `email` gets automatically.
- **Constraints:** `email` `UNIQUE` and `NOT NULL` — this table's
  entire reason to exist is "one row per real email address."
- **Soft delete:** not implemented today. A customer record here holds
  no sensitive data beyond an email and optional name, so there's
  little to gain from hiding-without-deleting; a real deletion request
  (e.g. a data-privacy request) should be a genuine `DELETE`, handled
  by a future admin action with its own audit-log entry — not a
  soft-delete flag that leaves the data sitting there regardless.

### `orders`

- **Primary key:** surrogate `id`; `order_reference` is the natural
  unique key (the human-legible Paystack reference format from
  `docs/paystack-integration.md`).
- **Relationships:** `customer_id` → `customers`, `product_id` →
  `products`, `payment_transaction_id` → `payment_transactions`
  (nullable — an order can exist in `pending` status before any
  payment attempt is recorded).
- **Indexes:** `customer_id`, `product_id`, `status` — the three
  columns a future admin "Orders" view (see `docs/admin-module.md`)
  will filter by most often.
- **Constraints:** `status` restricted to
  `pending`/`paid`/`failed`/`refunded`; `amount_pesewas >= 0`.
- **Soft delete:** yes. An order should never be hard-deleted (it's
  financial history), but might need hiding from normal admin views
  (e.g., a confirmed-fraudulent attempt) without breaking the
  `payment_transactions`/`downloads` rows that reference it.

### `payment_transactions`

*(Updated Version 1.2 Sprint 2.4 — Payment Verification. See
`docs/payment-verification.md`'s "Database" for the full
reasoning.)*

- **Primary key:** surrogate `id`; `paystack_reference` is the natural
  unique key — this project's primary webhook idempotency guard
  (`INSERT OR IGNORE`, checked via rows-affected, never a
  read-then-write).
- **Relationships:** `purchase_session_id` → `purchase_sessions`
  (nullable — a webhook could in principle arrive for a reference with
  no matching session; still recorded for audit). Replaces `order_id`
  → `orders`, which never had a real target under the live
  architecture (see `products`' entry above).
- **Indexes:** `purchase_session_id`, `status`.
- **Constraints:** `status` restricted to
  `pending`/`success`/`failed`/`abandoned`, matching Paystack's own
  transaction status vocabulary as closely as possible so no
  translation layer is needed when logging a webhook payload.
  `event_type` (new) records the raw Paystack event name (e.g.
  `charge.success`) for audit.
- **Soft delete:** deliberately **not implemented** — this table is a
  financial record of what a payment gateway reported. It is never
  deleted, soft or hard, matching standard financial record-keeping
  practice and this project's own honesty-first posture (a "hidden"
  payment record would be indistinguishable from data loss during an
  audit).

### `purchase_sessions`

*(Added in Version 1.2 Sprint 2.3 — Commerce Foundation, updated
Sprint 2.4 — Payment Verification. See
`docs/commerce-foundation.md` and `docs/payment-verification.md` for
the full architecture.)*

- **Primary key:** surrogate `id`; `purchase_reference` is the natural
  unique key (nullable only for the instant between insert and the
  follow-up update that sets it from the row's own new `id` — see
  `backend/services/commerceService.ts`).
- **Relationships:** **none** — `product_slug`/`product_id` are plain
  `TEXT` matching `content/products/{slug}.json`'s own identifiers, not
  a foreign key into `products` above. This table predates Sprint 2.1's
  pivot of the live product catalog to content-JSON files; `products`
  has never been populated under the live architecture, so a foreign
  key into it could never resolve for a real purchase. **Resolved
  Sprint 2.4:** this table *is* the project's order-equivalent record
  — `payment_transactions` now references it directly (see above), and
  `orders` is formally deprecated.
- **Indexes:** `status`, `product_slug`, `purchase_reference`.
- **Constraints:** `status` restricted to
  `pending`/`verified`/`failed`/`expired`/`cancelled`/`refunded`
  (revised Sprint 2.4 — `paid` renamed `verified`, `abandoned` removed
  as unreachable, `cancelled`/`refunded` added as schema-provisioned
  future states — see `docs/payment-verification.md`'s "Purchase state
  machine" for the full reasoning). New columns `product_id`,
  `product_version` (locked at checkout, cross-checked against
  Paystack's echoed-back metadata at verification), `provider_status`,
  `verified_at`.
- **Soft delete:** deliberately **not implemented**, same reasoning as
  `payment_transactions` above — a purchase attempt is a factual
  record, never hidden.

### `downloads` — deprecated (Version 1.2 Sprint 2.5)

Referenced `orders`/`products`, neither of which ever had a real
target under the live architecture (same reasoning as `orders`/
`customers`/`products` themselves). Superseded by `deliveries` below.
Kept in the schema for history, not deleted — no real data was ever
written to it.

### `deliveries`

*(Added in Version 1.2 Sprint 2.5 — Digital Fulfilment Platform. See
`docs/digital-fulfilment.md` for the full architecture.)*

- **Primary key:** surrogate `id`.
- **Relationships:** `purchase_session_id` → `purchase_sessions`.
  `asset_id` is a plain `TEXT` matching a
  `content/products/{slug}.json` `downloadFiles[].assetId` — never a
  D1 foreign key, the same "content is the source of truth for what
  exists, D1 tracks what was transacted" pattern
  `purchase_sessions.product_slug` already established.
- **Indexes:** `UNIQUE(purchase_session_id, asset_id)` — not just an
  index; this is what makes `fulfilPurchase()` idempotent by
  construction (`INSERT OR IGNORE`), the identical pattern
  `payment_transactions.paystack_reference` already established for
  webhook idempotency. Also `status`.
- **Constraints:** `status` restricted to `ready`/`delivered`/`revoked`
  (`revoked` schema-provisioned, not reachable by any code this
  sprint — see `docs/digital-fulfilment.md`'s "Delivery lifecycle").
  `max_downloads`/`access_expires_at` are copied from the product's
  `downloads` policy **at fulfilment time**, deliberately, so a later
  change to that policy never silently changes a past buyer's
  entitlement — the same reasoning this document's original `downloads`
  table (above) already established, carried forward to its real
  replacement.
- **Soft delete:** not implemented — a delivery is a factual
  entitlement-grant record, same reasoning as `purchase_sessions`/
  `payment_transactions`.

### `download_tokens`

*(Updated Version 1.2 Sprint 2.5: `download_id` → `orders`-era
`downloads` replaced by `delivery_id` → `deliveries`.)*

- **Primary key:** surrogate `id`; `token` is the natural unique key
  (the actual value used in `GET /api/download/:token`) — 256 bits of
  entropy, `backend/utils/downloadToken.ts`.
- **Relationships:** `delivery_id` → `deliveries`.
- **Indexes:** `delivery_id`.
- **Constraints:** `used_at` starts `NULL` and is set exactly once, in
  a single atomic `UPDATE ... WHERE used_at IS NULL AND expires_at >
  now`, not a read-then-write — see `docs/digital-fulfilment.md`'s
  "Security" (URL guessing / expired links) for why a used or expired
  token must never validate again, enforced at the database layer,
  not merely the application layer.
- **Soft delete:** not applicable — these rows are short-lived by
  design (a token's own `expires_at` is 15 minutes) and are expected
  to be periodically hard-deleted by a future scheduled cleanup job
  once expired, since they hold no long-term historical value once
  redeemed or expired.

### `newsletter_subscribers`

- **Primary key:** surrogate `id`; `email` is the natural unique key.
- **Relationships:** none — intentionally standalone. A newsletter
  subscriber is not required to ever be a customer or vice versa.
- **Indexes:** `status`, for "how many active subscribers" queries.
- **Constraints:** `status` restricted to `subscribed`/`unsubscribed`.
- **Soft delete:** not needed — **unsubscribing is already modeled as
  a status change**, not a deletion. This is more honest than a
  boolean "deleted" flag: the record of "this person once subscribed
  and later opted out" is meaningful history, not something to hide.

### `consultation_requests`

- **Primary key:** surrogate `id`.
- **Relationships:** none by foreign key — `email` is stored directly
  rather than requiring a `customers` row to exist first, since a
  consultation request and a product purchase are unrelated actions
  (see `docs/commerce-architecture.md`'s Phase 1 finding that
  Consultation is "not a commerce target").
- **Indexes:** `status` (for the admin review queue), `email`.
- **Constraints:** `preferred_contact_method` restricted to
  `email`/`phone`, matching the existing form's two options exactly
  (Sprint 3); `status` modeled as
  `new`/`reviewed`/`responded`/`closed` to match the "reviewed
  manually" workflow already promised on the live page.
- **Soft delete:** yes — spam or duplicate submissions should be
  hideable from the admin queue without losing the record entirely.

### `contact_messages`

*(Added in Version 1.2 Sprint 3.)*

- **Primary key:** surrogate `id`.
- **Relationships:** none by foreign key, for the same reason as
  `consultation_requests` — a general enquiry is unrelated to any
  purchase or customer record.
- **Indexes:** `status`, `email`.
- **Constraints:** `status` modeled identically to
  `consultation_requests` (`new`/`reviewed`/`responded`/`closed`) for
  consistency, even though this table has no "manual review" promise
  attached to it the way a consultation request does — the same
  status vocabulary still usefully describes "has anyone looked at
  this yet."
- **Soft delete:** yes, for the same reason as `consultation_requests`
  — spam is a real, expected occurrence for an open contact form.
- **Why a separate table from `consultation_requests`, not a shared
  one:** a general enquiry has no category, no preferred contact
  method, and no consultation-specific workflow — the two forms
  already serve deliberately different purposes on the live site
  (`docs/commerce-architecture.md`'s Phase 1 audit), and a shared table
  with several always-null columns for one form or the other would
  obscure that distinction rather than reflect it.

### `admin_users`

- **Primary key:** surrogate `id`; `email` is the natural unique key.
- **Relationships:** referenced conceptually by `audit_logs.actor_id`
  (not a strict foreign key, since `audit_logs.actor_type` can also be
  `system` or `customer`, for whom `actor_id` means something
  different — see below).
- **Indexes:** none beyond the unique `email` index.
- **Constraints:** `role` restricted to
  `super_admin`/`editor`/`support` (see `docs/admin-module.md`'s
  expanded permissions matrix for what each role can do);
  `password_hash` is never nullable and never holds plain text — see
  `docs/authentication-strategy.md` for the hashing approach.
- **Soft delete:** yes — revoking an admin's access (e.g., someone
  leaving the team) should deactivate them (`is_active = 0` handles
  the immediate access question) while `deleted_at` preserves the
  option to fully remove the row later without losing
  `audit_logs` rows that reference their past actions in the
  meantime.

### `audit_logs`

- **Primary key:** surrogate `id`.
- **Relationships:** loosely tied to `entity_type`/`entity_id` (e.g.,
  `"product"` / `42`) rather than strict foreign keys, because a
  single audit log table intentionally spans many different entity
  types — a strict foreign key would require a separate nullable
  column per possible entity type, which is worse than the minor loss
  of referential-integrity checking here.
- **Indexes:** `(entity_type, entity_id)` for "show me the history of
  this one product/order," and `created_at` for chronological admin
  views.
- **Constraints:** `actor_type` restricted to
  `admin`/`system`/`customer`.
- **Soft delete:** explicitly **not implemented, and never should be**
  — an audit log exists specifically to be a trustworthy, permanent
  record. A deletable audit log defeats its own purpose.

### `email_log`

*(Added alongside `docs/email-architecture.md`.)*

- **Primary key:** surrogate `id`.
- **Relationships:** same generic `entity_type`/`entity_id` pattern as
  `audit_logs`, for the same reason — one send can relate to an order,
  a consultation request, a newsletter subscriber, or a future admin
  password reset, and a strict foreign key can't span all of those.
- **Indexes:** `status` (for the Cron Trigger's retry query — "find
  everything still `queued`/`failed` below the attempt ceiling"), and
  `(entity_type, entity_id)` (for "did this order's receipt email ever
  send?").
- **Constraints:** `status` restricted to
  `queued`/`sent`/`failed`/`permanently_failed` — the distinction
  between `failed` (will be retried) and `permanently_failed` (won't
  be, e.g. an invalid address) matters for the retry query above, per
  `docs/email-architecture.md`'s failure-handling section.
- **Soft delete:** not implemented, for the same reason as
  `audit_logs` — this is a factual record of what was attempted and
  when, not something to selectively hide.

## What this document does not decide

- The exact password-hashing algorithm for `admin_users.password_hash`
  — see `docs/authentication-strategy.md`.
- Whether D1 or Cloudflare's own dashboard is used to run
  `schema.sql` for the first time, and how migrations are tracked
  operationally — an implementation-time decision, not an
  architecture one.
