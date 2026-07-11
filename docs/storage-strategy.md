# R2 Storage Strategy (Phase 3)

**Status: design only.** No R2 bucket exists in any Cloudflare
account. This document explains the planned bucket/folder structure,
which files belong where, and — building directly on the general
principles already established in `docs/download-security.md` (Sprint
1) — the concrete Cloudflare-specific mechanism for signed downloads
and expiration.

## Bucket structure

A single R2 bucket (e.g. `robayer-wealthlab-storage`) with folder-like
key prefixes, rather than multiple separate buckets — R2 bills and
manages access per-bucket, and this project's storage needs don't
require the isolation multiple buckets would provide:

```
ebooks/{product-slug}.pdf          — source files for ebook products
templates/{product-slug}.xlsx      — source files for spreadsheet/Word templates
resources/{resource-slug}.pdf      — free (price: 0) resource files
covers/{product-slug}.jpg          — product cover images
receipts/{order-reference}.pdf     — generated order receipts, one per order
temporary/{uuid}.*                 — short-lived generated files (see "Lifecycle rules" below)
exports/{export-id}.csv            — admin-generated reports (e.g., an orders export)
```

### What's public vs. private

| Prefix | Access | Why |
|---|---|---|
| `covers/` | Public read | A cover image needs to display on a future storefront card with no purchase required — nothing to protect |
| `resources/` | Public read | Free products (`price: 0`) have nothing to gate — see `content/products/README.md`'s note on treating free resources as `Product` records |
| `ebooks/`, `templates/` | **Private — never public** | The actual paid files. Only ever reachable through the token-mediated download flow below, never a direct R2 URL |
| `receipts/` | **Private** | Contains a specific buyer's order details |
| `temporary/`, `exports/` | **Private** | Transient or admin-only content |

## Signed downloads — the concrete Cloudflare mechanism

`docs/download-security.md` already establishes the *principle*
(short-lived, signed access, never a permanent public link to a paid
file). Two ways to implement that principle on Cloudflare, and which
this project recommends:

### Option A — R2 presigned URLs (S3-compatible)

R2 supports generating presigned URLs the same way S3 does, using an
R2 API token's access key/secret to sign a URL with a built-in
expiry. The Worker would generate this presigned URL and hand it to
the buyer directly, who then downloads straight from R2.

### Option B — Worker-mediated download (recommended)

The Worker itself validates a request (checking the `download_tokens`
table — see `docs/database-design.md` — for a valid, unexpired,
unused token), and only if valid, reads the object from R2 using its
own R2 binding (direct bucket access, no presigning needed) and
streams the file back as the HTTP response.

**This project recommends Option B.** Reasoning:

- **One place to enforce policy.** `docs/database-design.md`'s
  `download_tokens.used_at` (one-time use) and `downloads.max_downloads`
  checks happen naturally inside the same Worker request that serves
  the file — there's no way to "have" a valid file URL without the
  Worker itself deciding, at that exact moment, that this request is
  allowed. A presigned URL (Option A), once generated, is valid on its
  own for its whole TTL regardless of what happens afterward (e.g., a
  refund) unless separately revoked — which R2 doesn't support
  mid-flight.
- **Simpler secret management.** No R2 API token/signing keys need to
  exist in the Worker at all for Option B — only the R2 *binding*
  (configured in `wrangler.toml`, not a secret value), which Cloudflare
  itself manages.
- **File sizes here are small.** Ebooks, templates, and checklists are
  well within a Worker's ability to stream in a single request — this
  isn't video or large media, where Worker CPU/execution limits might
  make presigned direct-from-R2 URLs the better choice.

### The two-tier expiry this enables

Matching `backend/database/schema.sql`'s two-table design:

1. **Entitlement** (`downloads.expires_at`) — long-lived (the
   product's `download_expires_days`, e.g. 30 days) — "this order can
   still request downloads at all."
2. **Token** (`download_tokens.expires_at`) — short-lived (minutes,
   e.g. 15) and single-use (`used_at`) — "this *specific* link, if it
   leaked right now, stops working almost immediately."

A buyer clicking "Download" on an order-confirmation or "resend my
download" email always mints a **fresh token** at that moment — the
email never contains a permanent link, only a link to request one
(`GET /api/download/:token` where the token itself is freshly issued
right before the email is sent, per `docs/worker-api-design.md`).

## Lifecycle rules

- **`temporary/`** — configured with an R2 object lifecycle rule to
  auto-delete objects after a short period (e.g. 24 hours), so
  generated exports/scratch files never accumulate indefinitely.
- **`exports/`** — a longer but still bounded lifecycle (e.g. 30 days),
  since these are admin-requested reports, not permanent records — the
  underlying D1 data (`orders`, etc.) remains the permanent source of
  truth; a CSV export is a convenience snapshot, not an archive.
- **`ebooks/`, `templates/`, `covers/`, `resources/`, `receipts/`** — no
  automatic expiry; these are the durable, intentional files.

## Relationship to `assets/` in this git repository

`assets/covers/`, `assets/products/`, and `assets/downloads/`
(Version 1.2 Sprint 1) are the **authoring/staging** location — plain
files, committed to git, edited the same way every other real asset on
this site already is. A product's files move from there into R2 as
part of "going on sale" (see `docs/migration-roadmap.md`), a manual or
future-admin-triggered promotion step — not an automatic sync. Keeping
authoring separate from live serving means a half-finished product
(cover drafted, file not ready) never accidentally becomes downloadable.

## Today

*(Updated — Version 1.2 Sprint 2.5, Digital Fulfilment Platform.)*
**Option B (Worker-mediated download) is implemented exactly as
recommended** — see `docs/digital-fulfilment.md` and
`backend/routes/downloads.ts`/`backend/services/entitlementService.ts`.
The two-tier expiry described above is real: `deliveries.access_expires_at`
(long-lived entitlement, renamed from this document's `downloads`
table reference — see `backend/database/schema.sql`'s deprecation
note) and `download_tokens.expires_at` (short-lived, single-use,
15 minutes). A fresh token is minted only at the moment the
fulfilment page's Download button is clicked, never embedded in an
email, exactly as this document specifies.

**Still no bucket, no lifecycle rule, no R2 binding value exists** —
the `STORAGE` binding itself has existed in `wrangler.jsonc`/`env.ts`
since Sprint 3, but no real Cloudflare R2 bucket has been provisioned,
and no real files have been uploaded to one. `env.STORAGE.get()` is
architecturally complete and will correctly return `null` (handled as
`ASSET_UNAVAILABLE`, not a crash) until a real bucket with real
objects exists.
