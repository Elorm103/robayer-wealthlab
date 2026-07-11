# Cloudflare Backend Architecture — Version 1.2 Sprint 2

## Purpose of this document

This is the entry point for Sprint 2's backend planning, matching the
role `docs/commerce-architecture.md` played for Sprint 1. It records
why Cloudflare specifically, what each Cloudflare primitive is used
for, and links to every deeper Phase document:

- [`backend/README.md`](../backend/README.md) — the `backend/` folder structure itself (Phase 1)
- [`docs/database-design.md`](database-design.md) — D1 schema rationale (Phase 2)
- [`docs/storage-strategy.md`](storage-strategy.md) — R2 bucket structure (Phase 3)
- [`docs/worker-api-design.md`](worker-api-design.md) — Worker API endpoint design (Phase 4)
- [`docs/authentication-strategy.md`](authentication-strategy.md) — Admin auth research (Phase 5)
- [`docs/backend-security.md`](backend-security.md) — Security review (Phase 6)
- `backend/types/api-contracts.ts` — API response contracts (Phase 7)
- [`docs/admin-module.md`](admin-module.md) — Admin architecture, expanded this sprint (Phase 8)
- [`docs/migration-roadmap.md`](migration-roadmap.md) — Full migration roadmap (Phase 9)
- [`docs/email-architecture.md`](email-architecture.md) — Outbound email layer (provider, triggers, retry, branding — added pre-Sprint 3)
- [`docs/backup-and-recovery.md`](backup-and-recovery.md) — D1/R2 backup, disaster recovery, secret rotation, rollback (Sprint 2.5)
- [`docs/monitoring-and-alerting.md`](monitoring-and-alerting.md) — Logs, health checks, error thresholds, Cloudflare Analytics (Sprint 2.5)
- [`docs/deployment-checklist.md`](deployment-checklist.md) — Local/staging/production/rollback/verification checklist (Sprint 2.5)
- [`docs/cloudflare-resources.md`](cloudflare-resources.md) — Tracks which D1/KV/R2/Worker resources are actually provisioned vs. still placeholders in `backend/wrangler.jsonc` (Sprint 3)

**Version 1.2 Sprint 2.5 note:** with these three documents complete,
the backend architecture is considered frozen. Sprint 3 begins actual
implementation against everything designed in this folder — no further
architecture-only sprints are expected before then.

**Nothing in this sprint is deployed.** No Cloudflare Worker, D1
database, R2 bucket, or KV namespace has been created in any account.
No Paystack code exists. The live site is unaffected — see "Backward
compatibility guarantee" below.

**Version 1.2 Sprint 3 note:** the Worker/routes/services/middleware
described by these documents are now genuinely implemented in
`backend/` (`POST /api/newsletter`, `POST /api/contact`,
`POST /api/consultation`), and the three matching live forms now call
them. This is still **not deployed** — no Cloudflare account has
provisioned the real D1 database, R2 bucket, or KV namespace yet (see
the Sprint 3 implementation report's "Deployment steps"), and nothing
has been committed, tagged, or pushed. Paystack, Orders, Downloads,
and the admin dashboard remain unimplemented, per that sprint's
explicit scope.

---

## Why Cloudflare specifically

1. **Already in place.** `robayerwealthlab.com`'s DNS and CDN already
   run through Cloudflare — adding Workers/D1/R2 means one platform
   relationship to manage, not a second unrelated vendor.
2. **Resolves Sprint 1's deliberately deferred decision.** Both
   `docs/paystack-integration.md` and `docs/download-security.md`
   explicitly left "where does the serverless verification function
   run, and where do product files actually live" as an open Sprint 2+
   question. This sprint answers it: Cloudflare Workers (compute), D1
   (structured data), R2 (file storage).
3. **Matches this project's own architectural instincts.** Workers run
   JavaScript/TypeScript — no new language. D1 is SQLite-compatible —
   a plain, well-understood relational model, not a proprietary
   document store. Nothing here requires React, Vue, Next.js, or any
   other framework the site itself is explicitly forbidden from
   adopting; the backend and the static frontend remain two separate
   concerns that happen to share infrastructure.
4. **Explicitly excluded alternatives** (Firebase, Supabase, Netlify,
   Vercel, a Node/Express server) would each introduce a second
   hosting relationship, a different pricing model, and — for a Node
   server specifically — a machine that needs to stay running and
   patched, which this project has no operational capacity for. This
   was a direct instruction for this sprint, not a preference derived
   independently, but it also matches the "smallest reasonable
   footprint" instinct applied throughout this project's history.

## What each Cloudflare primitive is for

| Primitive | Role in this architecture | Why not something else |
|---|---|---|
| **Workers** | The single compute layer — receives every API request, runs `middleware/`, dispatches to `routes/`, calls `services/` | Replaces what would otherwise be a Node/Express server; runs at Cloudflare's edge, no server to provision or patch |
| **D1** | Structured, relational data: products, orders, customers, downloads, subscribers, consultation requests, admin users, transactions, download tokens, audit logs (Phase 2) | SQLite-compatible — relational integrity (foreign keys, constraints) matters for this data; a document store would make "an order references a valid product" a manual check instead of a database guarantee |
| **R2** | File storage: product files, cover images, receipts (Phase 3) | S3-compatible object storage with no egress fees — the natural home for binary files D1 was never meant to hold |
| **KV** | The two places this sprint identifies a genuine fit: rate-limit counters (`docs/backend-security.md`) and admin session storage (`docs/authentication-strategy.md`) — both short-lived, high-read-frequency, key-value-shaped data | Explicitly "only where appropriate" per this sprint's brief — D1 already fits every structured-data need; KV is not used as a second, redundant database |

## How this relates to Sprint 1's commerce architecture

Nothing from Sprint 1 is being redone **by this sprint**. `content/products/`,
`content/categories/`, `content/SCHEMA.md`'s `Product`/`Category`
entries, and `js/components/product-loader.js` are unchanged here —
they remain the **content layer** (what a product *is*). (A later,
separate sprint — Version 1.2 Sprint 2.1, `docs/product-platform-architecture.md`
— did extend this content layer, renaming `content/categories/` to
`content/product-types/` and splitting out `content/topics/`; nothing
in *this* Cloudflare/backend sprint depends on or is affected by that
change.) This sprint adds the **transaction layer** underneath it (what happens when someone
tries to *buy* one) — the exact split Sprint 1's `docs/admin-module.md`
already drew between "content editing" and "transactional records."
D1's `products` table (Phase 2) intentionally mirrors
`content/products/{slug}.json`'s shape rather than replacing it — see
`docs/database-design.md` for how the two stay in sync.

## Backward compatibility guarantee

Every file this sprint creates is either:

- **New**, under `backend/` or `docs/` — folders no existing page,
  script, or build process reads from, and
- **An addition** to an existing doc's "what this document does not
  decide" section (two small, clearly-marked edits — see the
  deliverable report) — never a rewrite of that doc's existing
  content.

No HTML page, CSS file, JS file currently loaded by any page, nav
partial, sitemap, or robots.txt is touched. See Phase 10's verification
pass for the empirical confirmation of this, not just the intention.
