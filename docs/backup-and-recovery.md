# Backup & Disaster Recovery

**Status: describes the real, deployed production system as of the Version 2.1 Phase 7 Final Acceptance Audit.** This document was originally written in Version 1.2 Sprint 2.5, before anything was deployed, and described a mix of real Cloudflare platform capabilities and planned-but-never-built custom infrastructure (a weekly backup-export Cron Trigger, a daily Paystack reconciliation Cron Trigger, "KV-backed" admin sessions). None of that custom infrastructure was ever actually built — this project has **zero Cloudflare Queues, Cron Triggers, or Durable Objects** anywhere, a fact re-confirmed during the Phase 7 audit. This rewrite removes every reference to infrastructure that doesn't exist and states plainly, for each scenario, what protection is real today versus what remains a known gap.

## D1 backup strategy

Cloudflare D1 has **built-in point-in-time recovery ("Time Travel")** — every write is retained, and the database can be restored to any timestamp within the retention window without any custom backup job. This is real, requires no code in this project, and covers the common case (an accidental bad write, a botched migration).

**Known gap: no backup exists beyond Time Travel's retention window.** The originally planned weekly Cron-Trigger-driven export to R2 was never built. There is currently no long-term archival copy of D1 data beyond what Time Travel itself retains. This is tracked as a known limitation in `docs/v2.1-technical-debt-register.md` rather than presented here as if it were mitigated — if genuine long-term retention becomes a real need, that document names the concrete trigger for building it.

## R2 backup/versioning strategy

**R2 does not have native object versioning.** What R2 actually holds today, and what happens if it's lost, differs by content type:

| R2 content | Recovery path if lost | Needs its own backup? |
|---|---|---|
| `ebooks/`, `templates/`, product/resource cover images sourced from git | Re-upload from the git-tracked source in `assets/products/`, `assets/covers/` | **No** — git history is the version history |
| `receipts/` (if/when generated) | Regenerate from the `orders`/`payment_transactions` D1 rows the receipt was built from | **No** — D1 is the source of truth |
| **Media Library uploads** (`media_assets` table, `env.STORAGE` bucket — Version 2.0 Phase 1) | **None.** An admin-uploaded image or file exists only as bytes in R2; the `media_assets` D1 row records metadata (filename, content hash, dimensions) but not the file content itself. | **Yes — this is a real, currently-unmitigated gap**, not present when this document was first written (Media Library shipped afterward). If the R2 bucket were lost, every admin-uploaded media file would be unrecoverable; only the metadata row would remain. |

This is a genuine change from this document's original architecture, which assumed every R2 object was either git-rebuildable or D1-regeneratable — that assumption held until Media Library introduced true user-uploaded originals. This gap is also tracked in `docs/v2.1-technical-debt-register.md`.

## Disaster recovery procedures

Realistic scenarios for a small operation, each with the concrete, *actually available* first response:

- **D1 data corrupted or a bad migration ran.** Restore via Time Travel to the timestamp just before the bad write (see "Database restore procedure" below). No R2 or Worker changes needed for this scenario alone.
- **R2 bucket accidentally emptied.** Product/resource files sourced from git can be re-promoted from `assets/products/`/`assets/covers/`. **Media Library uploads cannot be recovered** — see the gap noted above.
- **A bad Worker deployment breaks the API.** Roll back immediately (see "Worker rollback strategy" below) — this is real, fast, and requires no custom infrastructure.
- **Cloudflare account credentials compromised.** Rotate every real secret immediately (see "Secret rotation" below) and review recent deployments and D1 writes for tampering — Time Travel's full history is genuinely useful here for reviewing what changed, not just reverting it.
- **Paystack secret key leaked.** Rotate it immediately in the Paystack dashboard and via `wrangler secret put PAYSTACK_SECRET_KEY`; review recent `payment_transactions` rows for anything that doesn't match a real order. (There is no separate webhook secret to rotate — Paystack signs webhooks with the same account secret key; see `backend/worker/env.ts`'s own comment on this.)

In every scenario: the live static site (GitHub Pages) is unaffected by any backend incident — these are two genuinely separate deployables sharing a domain via a Workers Route, not a single system.

## Secret rotation

The real secrets in this project, confirmed against `backend/worker/env.ts`, are exactly two: **`RESEND_API_KEY`** and **`PAYSTACK_SECRET_KEY`**. Both are set via `wrangler secret put {NAME}` — never in `wrangler.jsonc`, which holds only non-secret configuration and binding names.

- **Routine rotation:** no fixed mandatory schedule at this project's scale; an annual review is a reasonable minimum cadence.
- **Incident rotation:** immediate, for any secret suspected exposed — `wrangler secret put` overwrites the value with zero deployment needed (secrets are read at request time, not baked into a build).
- **Admin session compromise is handled differently from a secret rotation** — there is no shared signing secret behind admin sessions to rotate. Sessions are individual rows in the `admin_sessions` D1 table (`token`, `csrf_secret` per row), validated by a direct database lookup, not by verifying a signature against an environment secret. To respond to a suspected compromised session or device: revoke that specific session (or all of an admin's sessions) via the Account & Security admin page, or directly via `sessionService.revokeSession()`/`revokeAllSessions()` — this is the actual mechanism, and it requires no secret rotation or Worker redeploy.

## Database restore procedure

1. Identify the target restore point (a timestamp just before the problem occurred) — Time Travel operates on timestamps, not named checkpoints, so this requires knowing roughly when the bad write happened (`updated_at` columns across tables help narrow this down).
2. Restore D1 to that timestamp via `wrangler d1 time-travel restore` or the Cloudflare dashboard.
3. **Verify before resuming normal operation:** spot-check a few `orders`/`products` rows against what's expected, confirm `email_log` and `payment_transactions` don't show gaps that would indicate the restore point was too far back.
4. **If Time Travel's retention window has already passed, there is currently no fallback.** This is the known gap named above — there is no weekly export to fall back to. Data loss beyond the retention window is a real, current risk, not a documented-but-mitigated one.

## Worker rollback strategy

Cloudflare Workers deployments are versioned and near-instant to roll back — this is a genuine, already-used operational strength of the platform (every production deploy through Version 2.1 has been tagged with `--var DEPLOYED_COMMIT:{git hash} --var DEPLOYED_AT:{timestamp}`, confirmed via the Settings page's System Information diagnostics):

1. Every deployment is tagged with the git commit hash at deploy time, so a rollback target is always identifiable.
2. If a deployment misbehaves, roll back via `wrangler rollback` or the Cloudflare dashboard's deployment history — typically effective within seconds, since this repoints traffic to the previous Worker version rather than rebuilding anything.
3. **No database rollback is implied by a Worker rollback** — the two are independent. Only restore D1 (above) if the *data*, not just the code, is the actual problem.

## Webhook failure recovery

Paystack retries a failed webhook delivery automatically for a period, which handles most transient failures without any action here. **There is no automated reconciliation job** — the originally planned daily Cron-Trigger-driven reconciliation was never built. For the rarer case of a missed webhook, the only recovery path today is manual: cross-check Paystack's own transaction dashboard against `payment_transactions` rows where `verified_at` is set but the corresponding webhook confirmation never arrived, and re-trigger fulfilment manually if a genuine mismatch is found.

## Email retry recovery

There is **no automated retry** for a failed email send. `emailService.ts` sends inline, at the moment the triggering action happens; a failure is recorded in `email_log` with `status = 'failed'` and nothing automatically retries it. This is a deliberate, documented trade-off (see `docs/v2.1-technical-debt-register.md` item 4), not a bug — but it means:

1. Failed sends accumulate safely in `email_log` — no data is lost, since sending is decoupled from the underlying business action succeeding.
2. Recovery today is manual: notice the failure (via `email_log` or Resend's own dashboard) and manually re-trigger the underlying action, or — for newsletter campaigns specifically — use the real, built Resume feature (`campaignService.ts`), which is the one case where retry-after-failure genuinely is automated, scoped to that one feature.
3. `emailService.ts` remains a single, isolated abstraction, so if a real automated retry mechanism is ever built (a Cron Trigger draining `email_log WHERE status = 'failed'`), it touches one file.
