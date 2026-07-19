# Deployment Checklist

**Status: describes the real deployment process for this project, as of the Version 2.1 Phase 7 Final Acceptance Audit.** This document was originally written in Version 1.2 Sprint 2.5, before anything was deployed, and read "nothing has been deployed" throughout. That has been true many times over since — the Worker has been deployed repeatedly through Version 2.1 Phase 6, 16 migrations have been applied to production, and this checklist is now the real, exercised procedure, not a hypothetical one. It has also been corrected to match the real configuration file (`wrangler.jsonc`, not `wrangler.toml`), the real secret names, and the real migration-apply command.

## Local development

- [ ] Run the Worker locally via `wrangler dev` (uses a local, disposable D1 instance and local R2/KV emulation — never the real production database or bucket).
- [ ] Secrets for local use live in `backend/.dev.vars`, git-ignored, copied from `backend/.dev.vars.example` and filled in with real test-mode values. The only two real secrets this project has are `RESEND_API_KEY` and `PAYSTACK_SECRET_KEY` — there is no `ADMIN_SESSION_SECRET` or any other admin-auth secret; admin sessions are validated against D1 rows, not a signing secret.
- [ ] Local `PAYSTACK_SECRET_KEY` is always a **test-mode** key — a real live key should never exist on a local machine.
- [ ] Apply `backend/database/migrations/*.sql` to the local D1 instance via `wrangler d1 migrations apply --local` (not a raw `wrangler d1 execute --file=` — that runs the SQL but silently skips registering the migration in the `d1_migrations` tracking table, a real gap caught during Version 2.1 Phase 5's local verification). `backend/database/schema.sql` is the human-readable reference the migrations should sum to, not something applied directly.
- [ ] Confirm the static site itself still runs unmodified alongside (e.g. via a local static-file server) — the two are separate deployables, but a developer should still be able to see both together while wiring up a feature that touches both.

## Production deployment

- [ ] Both real secrets (`RESEND_API_KEY`, `PAYSTACK_SECRET_KEY`) are set for the production environment via `wrangler secret put {NAME}` — double-check neither was accidentally left as a test-mode value.
- [ ] Any new migration file in `backend/database/migrations/` applied to the **production** D1 database via `wrangler d1 migrations apply --remote` (not `--file=` — see the Local development note above; this exact mistake happened once, during Phase 5, and was caught and fixed manually before it caused a real problem).
- [ ] `backend/database/schema.sql` updated to match the new migration, so it stays the accurate cumulative reference (verified for drift as part of every phase's release audit, most recently Phase 7).
- [ ] `PAYSTACK_BASE_URL`/`SITE_BASE_URL`/`PAYMENT_PROVIDER` in `wrangler.jsonc`'s `vars` block reflect production values (they already do, and are non-secret, so no per-deploy action needed unless one of them is intentionally changing).
- [ ] Deploy the Worker with `wrangler deploy --var DEPLOYED_COMMIT:{git commit hash} --var DEPLOYED_AT:{ISO timestamp}` — this is the real, already-used mechanism (not a future recommendation) that lets the Settings page's System Information panel report which commit is actually live, and gives `docs/backup-and-recovery.md`'s "Worker rollback strategy" a concrete rollback target.

## Post-deployment verification

- [ ] **The live static site is unaffected** — load the homepage and at least one page from each major public section, and confirm zero console errors and no visual change.
- [ ] `GET /api/health` (a real, existing, no-auth endpoint) responds successfully — this is the actual, minimal health check this project has; there is no scheduled/automated health-check job watching it today (see `docs/monitoring-and-alerting.md`), so this is a manual step, not something to "confirm is already running."
- [ ] Admin login succeeds for a real admin account, and a CSRF-token-missing request to a state-changing admin endpoint is correctly rejected.
- [ ] Spot-check one write path per newly-changed module against production, using disposable test data only, followed by cleanup — matching the discipline used in every phase's own deployment report (create → verify → delete, confirm baseline D1 state is restored).

## Rollback

- [ ] If the problem is Worker code: roll back to the immediately prior tagged deployment (`wrangler rollback` or the dashboard) — expected to take effect within seconds.
- [ ] If the problem is bad data from a migration: restore D1 via Time Travel to just before the migration ran (`docs/backup-and-recovery.md`'s "Database restore procedure") — independent of, and not automatically triggered by, a Worker rollback. There is no fallback beyond Time Travel's retention window (a known, documented gap — see `docs/backup-and-recovery.md` and `docs/v2.1-technical-debt-register.md`).
- [ ] After any rollback: re-run the "Post-deployment verification" checks above before considering the incident closed.

## Staging deployment — not currently built

**This section describes a pattern, not a real environment.** No staging Cloudflare environment exists today — `wrangler.jsonc` has no `env.staging` block, no separate D1/R2/KV, and no staging domain has been chosen. This was a deliberate deferral (per `wrangler.jsonc`'s own comment: inventing a placeholder staging domain would be exactly the kind of fabricated detail this project avoids). If a real staging environment is ever built, it should follow this pattern:

- A separate Cloudflare environment (Wrangler's named-environments feature, `[env.staging]` in `wrangler.jsonc`) with its own D1 database, R2 bucket (or a `staging/` prefix in the same bucket), and KV namespace — never sharing production data.
- Staging uses **test-mode** Paystack keys only, and its `ALLOWED_ORIGIN`-equivalent CORS/routing configuration points at the staging domain, never production.
- The Paystack webhook is configured to point at the staging Worker's webhook URL while testing there — a common, easy-to-miss mistake is leaving it pointed at production (or nothing) during staging tests.

Until this exists, "staging verification" in practice means local `wrangler dev` verification plus careful, disposable-data-only spot-checks directly against production after deploy (see "Post-deployment verification" above) — a real, working substitute at this project's current scale, not a gap this document should pretend is already closed.
