# Monitoring & Alerting (Version 1.2 Sprint 2.5)

**Status: architecture and documentation only.** No monitoring
dashboard, alert, or log query has been set up — nothing here is
active, because no Worker, D1 database, or R2 bucket is deployed yet.
This document specifies what to watch and what "wrong" looks like,
once there's something running to watch.

Scope note: this document deliberately stays proportionate to a small
operation's real needs. It does not recommend a third-party
observability platform (e.g., Datadog, Sentry) — Cloudflare's own
built-in tooling, used deliberately, is sufficient at this project's
scale, matching the same "smallest reasonable footprint" reasoning
`docs/cloudflare-architecture.md` already applied to hosting choices.

## Worker logs

- **Real-time debugging:** `wrangler tail` streams live requests
  during active troubleshooting — the day-to-day equivalent of
  watching a server's stdout, with no setup needed.
- **Structured logging convention:** every log line a Worker emits
  should be a single JSON object with a consistent shape —
  `{ timestamp, requestId, route, level, message, context }` — so logs
  are filterable and greppable rather than free-text. `requestId`
  (generated once per incoming request, threaded through
  `middleware/` → `routes/` → `services/`) is what ties together every
  log line from a single request, and is also the value returned to a
  client on `INTERNAL_ERROR` responses so a support conversation can
  reference one concrete ID instead of "it happened sometime this
  morning."
- **Persistent retention:** Cloudflare Workers Logs (via the dashboard)
  retains recent request logs without extra setup; Logpush (exporting
  logs to external storage) is a future option only if retention needs
  genuinely exceed what the dashboard provides — not assumed necessary
  from day one.

## D1 health monitoring

- Cloudflare's dashboard exposes basic D1 metrics (query volume,
  storage size, error rate) with no custom code needed.
- Beyond passive dashboard review, a lightweight **scheduled health
  check** (a lightweight Cron Trigger — the same recurring pattern
  already used for email retry and backup export) runs a trivial query
  (e.g., `SELECT 1`) against D1 every few minutes and logs/alerts if it
  fails or takes unusually long — catching an availability problem
  before a real user's request does.
- **What to watch for specifically:** storage size trending toward D1's
  plan limits (a capacity problem, not a bug), and query error rate —
  a sudden spike almost always means a bad deployment, not a database
  problem (see "Error thresholds" below).

## R2 monitoring

- Storage size and request counts, via the Cloudflare dashboard —
  primarily useful for confirming the lifecycle rules
  (`docs/storage-strategy.md`) are actually doing their job: `temporary/`
  and `exports/` should show a bounded, roughly-flat storage trend, not
  unbounded growth. Unbounded growth in either prefix is itself the
  alert-worthy signal that a lifecycle rule isn't firing as configured.
- No custom R2 monitoring code is needed beyond that periodic glance —
  R2 usage at this project's realistic product catalog size (a
  handful of files) is not going to surprise anyone.

## Email delivery monitoring

- **Resend's own dashboard** shows delivery, bounce, and complaint
  rates natively — the first place to look, not something to rebuild.
- **`email_log` is this project's own, queryable monitoring surface**
  (`docs/email-architecture.md`): a simple periodic count of
  `status = 'failed'` and `status = 'permanently_failed'` rows is the
  concrete, project-specific signal that something needs attention,
  surfaced eventually in the Admin Analytics module
  (`docs/admin-module.md`).
- **What to watch for specifically:** a rising `permanently_failed`
  rate for the same recipient domain (e.g., many failures to the same
  provider) often indicates a deliverability problem (SPF/DKIM/DMARC
  misconfiguration) rather than individually bad addresses — worth
  distinguishing from routine, expected single-address bounces.

## Paystack webhook monitoring

- **Paystack's own dashboard** shows webhook delivery attempts and
  failures directly — the first place to check if a webhook seems to
  be missing.
- **This project's own cross-check:** the daily reconciliation job
  already designed in `docs/backup-and-recovery.md`'s "Webhook failure
  recovery" section is also this project's webhook *monitoring*
  mechanism, not just its recovery mechanism — the same job that
  catches a missed webhook for recovery purposes is what surfaces "how
  often is this actually happening" as a trend worth watching.
- **What to watch for specifically:** any `payment_transactions` row
  with `verified_at` set (client-side flow completed) but
  `webhook_received_at` still `NULL` after a reasonable delay (e.g., 1
  hour) — this is the concrete, queryable definition of "a webhook
  might be missing" this project can check directly, rather than a
  vague sense that "webhooks seem unreliable."

## Error thresholds

Concrete starting thresholds (tunable once real traffic exists — these
are reasoned starting points, not permanent fixed values):

| Signal | Threshold | Likely meaning |
|---|---|---|
| `POST /api/payments/verify` failure rate | >5% of attempts in a rolling hour | Paystack API issue, or a bad deployment — check Worker logs first |
| `admin/login` failed attempts | >5 for the same email in 15 minutes | Already rate-limited (`docs/authentication-strategy.md`); a sustained pattern across *many* emails suggests a broader brute-force sweep, worth a manual look |
| `email_log` failure rate | >10% of sends in a rolling day | Provider-side issue or a deliverability/configuration problem — check Resend's dashboard |
| D1 health-check query | Fails, or takes >2 consecutive checks to succeed | Possible D1 availability issue — check Cloudflare status page before assuming a local bug |
| Webhook/verify mismatch (above) | Any row unresolved after 1 hour | Investigate via the reconciliation job's output before assuming data loss |

## Recommended Cloudflare Analytics usage

- **Cloudflare Web Analytics** (privacy-respecting, cookie-free) is a
  reasonable, low-effort option for the *static site's* traffic, if
  and when this project wants that — a separate decision from the
  backend, and not something this sprint adds (per this sprint's own
  "no frontend changes" constraint).
- **Workers Analytics Engine / the GraphQL Analytics API** is the
  equivalent for the *backend* — request volume, error rates, and
  latency percentiles for the Worker, queryable without needing a
  third-party APM tool bolted on. Appropriate to introduce once the
  Worker is actually deployed and generating real traffic to analyze
  (Step 1 of `docs/migration-roadmap.md`) — not before, since there's
  nothing to analyze yet.
