# Cloudflare Resources (Version 1.2 Sprint 3)

**Status: tracking document, not a deployment record.** This is the
single place to check which real Cloudflare resources actually exist
for this project, versus which are still just planned bindings in
`backend/wrangler.jsonc`. Update the **Created** column yourself the
moment you actually provision each resource (`wrangler d1 create`,
`wrangler kv namespace create`, `wrangler r2 bucket create`,
`wrangler deploy`) — this file should always reflect reality, not
intent, matching this project's existing "no fabricated status"
convention (see `docs/cloudflare-architecture.md`,
`docs/deployment-checklist.md`).

| Resource | Name | Purpose | Created | Notes |
| -------- | ---- | ------- | ------- | ----- |
| D1 | `robayer-wealthlab-db` | Structured data — 12 tables (`backend/database/schema.sql`): products, orders, customers, newsletter subscribers, consultation requests, contact messages, email log, etc. | ✓ | UUID `1c4c883e-afc0-4d74-bad4-6b8b2caa1570`, created 2026-07-06. `wrangler.jsonc`'s `database_id` updated to match. `schema.sql` applied via `wrangler d1 execute --remote` — all 12 tables + 19 indexes verified present (`SELECT name FROM sqlite_master`), and a `CHECK` constraint was verified to actually reject an invalid `status` value. Tracked going forward as `backend/database/migrations/0001_initial.sql`, registered as already-applied in `d1_migrations` (both local and remote) so a future `wrangler d1 migrations apply` won't try to re-run it. |
| KV | `RATE_LIMIT_KV` | Per-IP/per-endpoint rate-limit counters (`docs/backend-security.md`) | ✓ | Namespace ID `fb02f751cac14749a4b2efa3701c0ba9`. `wrangler.jsonc`'s `id` updated to match. Confirmed via `wrangler kv namespace list`. |
| R2 | `robayer-wealthlab-storage` | Planned: eBooks, templates, cover images, receipts (`docs/storage-strategy.md`) | ✓ | Created 2026-07-06. Confirmed via `wrangler r2 bucket list`. Binding name kept as `STORAGE` (unchanged) — R2 buckets have no separate ID, just the `bucket_name`, which already matched exactly. **Still unused by any route** — Orders/Downloads are explicitly out of Sprint 3's scope. |
| Worker | `robayer-wealthlab-api` | API for `POST /api/newsletter`, `/api/contact`, `/api/consultation` (`docs/worker-api-design.md`) | ✗ Not deployed | Fully tested locally via `wrangler dev` and, separately, verified to build correctly against the now-real bindings (`wrangler deploy --dry-run`). `wrangler deploy` has still never been run — no Worker exists in the Cloudflare account yet. |

## How to update this file

After actually creating a resource, replace its **Created** cell with
`✓` and its **Notes** with the real detail (e.g. the database ID, the
bucket's region, the deployed Worker's `*.workers.dev` URL), and paste
the resulting real ID into the matching field in `backend/wrangler.jsonc`
(replacing the `PLACEHOLDER_*` value there) — the two files should
never disagree about whether a resource is real.

## What this file is not

- Not a substitute for `docs/deployment-checklist.md`, which has the
  full step-by-step local/staging/production procedure.
- Not a substitute for `wrangler d1 list` / `wrangler kv namespace list`
  / `wrangler r2 bucket list`, which are the actual source of truth for
  what exists in your Cloudflare account — this file is a quick,
  human-readable summary of that, kept in sync manually.
