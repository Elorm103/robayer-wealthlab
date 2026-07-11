# Deployment Checklist (Version 1.2 Sprint 2.5)

**Status: checklist only — nothing has been deployed.** This is the
procedure whoever implements `docs/migration-roadmap.md`'s steps
follows each time, not a record of anything already done.

## Local development

- [ ] Run the Worker locally via `wrangler dev` (uses a local, disposable
      D1 instance and local R2 emulation — never the real production
      database or bucket).
- [ ] Secrets for local use live in a `.dev.vars` file, **git-ignored**,
      never committed — matching `backend/config/README.md`'s "never in
      git, committed or not" rule for every real secret.
- [ ] Local `PAYSTACK_SECRET_KEY` is always a **test-mode** key — a real
      live key should never exist on a local machine.
- [ ] Run `backend/database/schema.sql` against the local D1 instance to
      get a matching schema before testing any route that touches data.
- [ ] Confirm the static site itself still runs unmodified alongside
      (e.g., via the existing GitHub Pages local preview) — the two are
      separate deployables, but a developer should still be able to see
      both together while wiring up a feature that touches both.

## Staging deployment

- [ ] A separate Cloudflare environment (Wrangler's named-environments
      feature — e.g., `[env.staging]` in `wrangler.toml`) with its own
      D1 database, R2 bucket (or a `staging/` prefix in the same
      bucket), and KV namespace — never sharing production data.
- [ ] Staging uses **test-mode** Paystack keys only.
- [ ] Staging's `ALLOWED_ORIGIN` (CORS, `docs/backend-security.md`)
      points at the staging domain/subdomain, not production.
- [ ] Apply `backend/database/schema.sql` to the staging D1 database.
- [ ] Deploy the Worker to staging; run through every endpoint in
      `docs/worker-api-design.md` manually at least once, including a
      full test-mode purchase → download flow end to end.
- [ ] Confirm the Paystack webhook is configured to point at the
      **staging** Worker's webhook URL while testing — a common,
      easy-to-miss mistake is leaving this pointed at production (or
      nothing) during staging tests.

## Production deployment

- [ ] Every secret (`PAYSTACK_SECRET_KEY`, `PAYSTACK_WEBHOOK_SECRET`,
      `ADMIN_SESSION_SECRET`, `RESEND_API_KEY`) set via
      `wrangler secret put` for the production environment —
      double-check none of these were accidentally left as staging/test
      values.
- [ ] `backend/database/schema.sql` applied to the **production** D1
      database for the first time (or the specific migration file, if
      this is a later change — `backend/database/README.md`'s
      "migrations, not rewrites" rule applies from the second schema
      change onward).
- [ ] R2 bucket created with the folder structure from
      `docs/storage-strategy.md`, and lifecycle rules configured for
      `temporary/` and `exports/` **before** anything is written to
      those prefixes — not added retroactively after they've already
      grown unbounded.
- [ ] `ALLOWED_ORIGIN` set to the exact production origin
      (`https://robayerwealthlab.com`), never a wildcard
      (`docs/backend-security.md`).
- [ ] Paystack **live** keys are only ever set at this step, never
      earlier — test-mode keys should still be what staging uses even
      the day before a production launch.
- [ ] Paystack webhook URL updated to point at the production Worker.
- [ ] Deploy the Worker, tagged with a version identifier (matching the
      git commit hash of the code deployed) so a rollback target is
      always known (`docs/backup-and-recovery.md`'s "Worker rollback
      strategy").
- [ ] The weekly D1 export Cron Trigger and the reconciliation Cron
      Trigger (`docs/backup-and-recovery.md`) are both scheduled and
      confirmed running before considering the deployment complete —
      not "added later once things feel stable."

## Rollback

- [ ] If the problem is Worker code: roll back to the immediately
      prior tagged deployment (`wrangler rollback` or the dashboard) —
      expected to take effect within seconds.
- [ ] If the problem is bad data from a migration: restore D1 via Time
      Travel to just before the migration ran
      (`docs/backup-and-recovery.md`'s "Database restore procedure") —
      independent of, and not automatically triggered by, a Worker
      rollback.
- [ ] After any rollback: re-run the "Post-deployment verification"
      checks below before considering the incident closed — a rollback
      is a mitigation, not automatically proof that everything is
      healthy again.

## Post-deployment verification

- [ ] **The live static site is unaffected** — load the homepage and at
      least one page from each major section (Services, Calculators,
      Goal Planner, Learning Hub, Investment Centre, Consultation), and
      confirm zero console errors and no visual change. This check
      exists because it has been the standing requirement of every
      backend-planning sprint so far, and remains true even once real
      backend deployment begins.
- [ ] Every endpoint in `docs/worker-api-design.md` responds with the
      correct standardized shape (`backend/types/api-contracts.ts`) for
      both a success and at least one deliberately-triggered error case.
- [ ] A full real (or Paystack live-mode test) purchase completes end
      to end: order created → payment verified → webhook received →
      download email delivered → download link redeems successfully
      exactly once and fails correctly on a second attempt (confirming
      `docs/backend-security.md`'s replay protection is actually
      working in production, not just in design).
- [ ] Admin login succeeds for a real admin account, and a CSRF-token-
      missing request to a state-changing admin endpoint is correctly
      rejected (`docs/authentication-strategy.md`).
- [ ] The D1 health-check and reconciliation Cron Triggers
      (`docs/monitoring-and-alerting.md`) have run at least once
      successfully since deployment.
