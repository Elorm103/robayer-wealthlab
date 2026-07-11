# Backup & Disaster Recovery (Version 1.2 Sprint 2.5)

**Status: architecture and documentation only.** No backup job, no
restore script, no rollback has ever been performed — nothing in this
document has been executed, because no D1 database, R2 bucket, or
Worker deployment exists yet (`docs/cloudflare-architecture.md`). This
is the runbook whoever operates this backend follows once it's live.

## D1 backup strategy

Cloudflare D1 has **built-in point-in-time recovery ("Time Travel")**
— every write is retained, and the database can be restored to any
timestamp within the retention window without any custom backup job.
This covers the common case (an accidental bad write, a botched
migration) with no additional architecture needed.

For longer-term retention beyond D1's own window, and for a copy that
survives even a full Cloudflare-account-level incident:

- A **weekly** scheduled Worker (Cron Trigger — the same primitive
  already used for email retry, `docs/email-architecture.md`) runs
  `wrangler d1 export` (or the equivalent D1 API) and writes the
  resulting SQL dump to `exports/db-backups/{date}.sql` in R2 — reusing
  the `exports/` prefix already defined in `docs/storage-strategy.md`
  rather than inventing a new bucket location.
- Retention: keep the last 8 weekly exports (roughly 2 months), then
  let R2's lifecycle rule (`docs/storage-strategy.md`) expire older
  ones automatically — consistent with treating `exports/` as bounded,
  not a permanent archive.

## R2 backup/versioning strategy

**Honest starting point: R2 does not have native object versioning**
comparable to some other object stores. Rather than building custom
versioning to work around that, this project's existing architecture
already avoids needing it for most of what R2 holds:

| R2 content | Recovery path if lost | Needs its own backup? |
|---|---|---|
| `ebooks/`, `templates/`, `resources/`, `covers/` | Re-upload from `assets/products/`, `assets/covers/` (git-tracked source of truth — `docs/storage-strategy.md`) | **No** — git history is already the version history for these files |
| `receipts/` | Regenerate from the `orders`/`payment_transactions` D1 rows the receipt was built from | **No** — D1 is the source of truth; the R2 file is a rendered artifact |
| `temporary/`, `exports/` | Nothing to recover — explicitly disposable by design (`docs/storage-strategy.md`'s lifecycle rules) | No |

This means R2 itself needs **no independent backup mechanism** — it's
either a rebuildable mirror of git, a regeneratable artifact of D1, or
intentionally disposable. The one thing worth actually protecting is
D1 (above) and the git repository itself (already protected by GitHub,
outside this document's scope).

## Disaster recovery procedures

Realistic scenarios for a small operation, each with a concrete first
response — not enterprise-scale incident response theater:

- **D1 data corrupted or a bad migration ran.** Restore via Time
  Travel to the timestamp just before the bad write (see "Database
  restore procedure" below). No R2 or Worker changes needed for this
  scenario alone.
- **R2 bucket accidentally emptied.** Re-run the promotion step from
  `docs/storage-strategy.md` (copy from `assets/products/`/`assets/covers/`
  in git back into R2) for product files; regenerate any needed
  receipts from D1. No data is actually lost — only availability is
  briefly affected.
- **A bad Worker deployment breaks the API.** Roll back immediately
  (see "Worker rollback strategy" below) — this is the fastest
  recovery path of any scenario here, by design of how Cloudflare
  Workers deployments work.
- **Cloudflare account credentials compromised.** Rotate every secret
  immediately (see "Secret rotation" below), review recent deployments
  and D1 writes for tampering, and treat this as the one scenario
  where Time Travel's full audit trail matters most — review what
  changed, not just revert it.
- **Paystack secret key or webhook secret leaked.** Rotate both
  immediately in the Paystack dashboard and via `wrangler secret put`
  (see below); review recent transactions for anything that doesn't
  match a real `orders` row.

In every scenario: the live static site (GitHub Pages) is unaffected —
none of these are site outages, only backend/API disruptions, which is
exactly the isolation this architecture was designed for
(`docs/cloudflare-architecture.md`'s "two separate deployables that
happen to share a domain").

## Secret rotation

- **Routine rotation:** no fixed mandatory schedule at this project's
  scale, but an annual review of all secrets in
  `backend/config/README.md`'s table is a reasonable minimum cadence.
- **Incident rotation:** immediate, for any secret suspected exposed —
  `wrangler secret put {NAME}` overwrites the value with zero
  deployment needed (secrets are read at request time, not baked into
  a build).
- **`ADMIN_SESSION_SECRET` rotation is a deliberate incident-response
  tool, not just routine hygiene** — rotating it immediately
  invalidates every existing admin session (since sessions are
  verified against it — `docs/authentication-strategy.md`), which is
  exactly the desired effect if an admin session or device is
  suspected compromised. This is a feature of the KV-backed session
  design, not a side effect to work around.
- Secrets are **never** rotated by editing `wrangler.toml` — that file
  never holds secret values (`backend/config/README.md`), only
  non-secret configuration and binding names.

## Database restore procedure

1. Identify the target restore point (a timestamp just before the
   problem occurred) — Time Travel operates on timestamps, not named
   checkpoints, so this requires knowing roughly when the bad write
   happened (D1's own query log/`updated_at` columns across tables
   help narrow this down).
2. Restore D1 to that timestamp via Wrangler's Time Travel command
   (`wrangler d1 time-travel restore`) or the Cloudflare dashboard.
3. **Verify before resuming normal operation:** spot-check a few
   `orders`/`products` rows against what's expected, confirm
   `email_log` and `payment_transactions` don't show gaps that would
   indicate the restore point was too far back.
4. If Time Travel's retention window has already passed, fall back to
   the most recent weekly export in `exports/db-backups/` (above) —
   accepting up to a week of data loss in this specific, harder
   scenario, which is the honest trade-off of a weekly export cadence
   at this project's scale.

## Worker rollback strategy

Cloudflare Workers deployments are versioned and near-instant to roll
back — this is a genuine operational strength of the platform, not
something this project needs to build tooling for:

1. Every deployment should be tagged/labeled with a version identifier
   (e.g., matching a git commit hash) at deploy time — see
   `docs/deployment-checklist.md`.
2. If a deployment misbehaves, roll back via `wrangler rollback` (or
   the dashboard's deployment history) to the immediately prior
   version — typically effective within seconds, since this simply
   repoints traffic to the previous Worker version rather than
   rebuilding or redeploying anything.
3. **No database rollback is implied by a Worker rollback** — the two
   are independent. Only restore D1 (above) if the *data*, not just
   the code, is the actual problem — most Worker bugs don't require
   touching D1 at all.

## Webhook failure recovery

Paystack retries a failed webhook delivery automatically for a period
(per Paystack's own retry schedule), which handles most transient
failures without any action here. For the rarer case where a webhook
is missed entirely (e.g., the Worker endpoint was down for the whole
retry window):

- A **daily reconciliation Cron Trigger** queries Paystack's own
  transaction list API for the prior day's transactions and cross-
  checks each against `payment_transactions.paystack_reference`. Any
  Paystack transaction with no matching local row (or a local row
  stuck in `pending`) is flagged — surfaced today as an `email_log`-
  style entry for manual review, and in the future Admin Analytics
  module (`docs/admin-module.md`) as a genuine dashboard item.
- This reconciliation job is a safety net, not the primary mechanism —
  the client-side callback and the webhook itself both still fire
  first in the overwhelming majority of cases (`docs/paystack-integration.md`).

## Email retry recovery

Routine failures are already handled by `docs/email-architecture.md`'s
design (one inline retry, then the Cron-Trigger-driven `email_log`
retry loop). For a **disaster-level** failure — Resend itself down or
the account suspended for an extended period:

1. Failed sends keep accumulating safely in `email_log` with
   `status = 'failed'` — no data is lost, since sending was always
   decoupled from the underlying business action succeeding
   (`docs/email-architecture.md`).
2. Once Resend service is restored, the existing Cron Trigger retry
   loop drains the backlog automatically — no manual bulk-resend
   script needs to be built in advance for this, since the retry
   mechanism already designed handles exactly this case by design.
3. `emailService.ts` (`backend/services/README.md`) is a single,
   isolated abstraction specifically so that swapping providers, if
   Resend itself were ever the actual problem, touches one file — not
   scoped or built now, but the architecture doesn't block it later.
