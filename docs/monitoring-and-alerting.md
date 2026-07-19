# Monitoring & Alerting

**Status: describes the real, deployed production system as of the Version 2.1 Phase 7 Final Acceptance Audit.** This document was originally written in Version 1.2 Sprint 2.5, before anything was deployed, and described a mix of real Cloudflare dashboard capabilities and a planned-but-never-built custom D1 health-check Cron Trigger and reconciliation job. Neither was ever built — this project has zero Cloudflare Queues, Cron Triggers, or Durable Objects anywhere. This rewrite removes those references and states plainly what monitoring is real today versus what remains manual.

Scope note: this document deliberately stays proportionate to a small operation's real needs. It does not recommend a third-party observability platform (Datadog, Sentry) — Cloudflare's own built-in tooling, used deliberately, is sufficient at this project's scale.

## Worker logs

- **Real-time debugging:** `wrangler tail` streams live requests during active troubleshooting — the day-to-day equivalent of watching a server's stdout, with no setup needed. This is real and has been used throughout Version 2.1's phases to diagnose production issues (e.g. the Phase 0.1 `PBKDF2_ITERATIONS` ceiling was discovered this way).
- **Structured logging convention:** every log line a Worker emits is a single JSON object with a consistent shape — `{ timestamp, requestId, route, level, message, context }` — so logs are filterable and greppable. `requestId` (generated once per incoming request, threaded through `middleware/` → `routes/` → `services/`) ties together every log line from a single request, and is also the value returned to a client on `INTERNAL_ERROR` responses.
- **Persistent retention:** Cloudflare Workers Logs (via the dashboard) retains recent request logs without extra setup. `wrangler.jsonc`'s `observability.head_sampling_rate: 1` means every request is sampled, appropriate at this project's real, low traffic volume.

## D1 health monitoring

- Cloudflare's dashboard exposes basic D1 metrics (query volume, storage size, error rate) with no custom code needed — this part is real.
- **There is no automated health check.** The originally planned "lightweight Cron Trigger that runs `SELECT 1` every few minutes" was never built. `GET /api/health` is a real, existing, no-auth endpoint (see `docs/deployment-checklist.md`), but nothing calls it on a schedule today — checking it is a manual step (post-deployment, or when investigating a suspected issue), not a passive alert.
- **What to watch for, manually:** storage size trending toward D1's plan limits, and a query error rate spike in the dashboard (almost always a bad deployment, not a database problem).

## R2 monitoring

- Storage size and request counts, via the Cloudflare dashboard — no custom code needed. At this project's real usage (Media Library uploads, product/resource assets), this periodic manual glance is proportionate.
- No lifecycle rules or automated cleanup jobs exist for R2 today.

## Email delivery monitoring

- **Resend's own dashboard** shows delivery, bounce, and complaint rates natively — the first place to look.
- **`email_log` is this project's own, queryable monitoring surface**: a manual periodic query of `status = 'failed'` and `status = 'permanently_failed'` rows is the concrete signal that something needs attention. There is no automated retry or alert on this today (see `docs/backup-and-recovery.md`'s "Email retry recovery" and `docs/v2.1-technical-debt-register.md` item 4) — this is a manual check, not a dashboard widget yet.
- **What to watch for specifically:** a rising `permanently_failed` rate concentrated on one recipient domain often indicates a deliverability problem (SPF/DKIM/DMARC) rather than individually bad addresses.

## Paystack webhook monitoring

- **Paystack's own dashboard** shows webhook delivery attempts and failures directly — the first place to check if a webhook seems to be missing. This is real and requires nothing from this project.
- **There is no automated reconciliation job.** The originally planned daily Cron-Trigger-driven cross-check was never built (see `docs/backup-and-recovery.md`'s "Webhook failure recovery"). The concrete, queryable definition of "a webhook might be missing" — any `payment_transactions` row with `verified_at` set but no corresponding webhook confirmation after a reasonable delay — is still a valid signal to check, but it requires someone to actually run the query; nothing surfaces it automatically today.

## Error thresholds

Concrete starting thresholds, useful as manual review guidance since no automated alerting exists to enforce them:

| Signal | Threshold | Likely meaning |
|---|---|---|
| `POST /api/checkout` / payment verification failure rate | >5% of attempts in a rolling hour | Paystack API issue, or a bad deployment — check Worker logs first |
| `admin/login` failed attempts | >5 for the same email in 15 minutes | Already rate-limited and lockout-protected (Version 2.1 Phase 3); a sustained pattern across *many* emails suggests a broader brute-force sweep worth a manual look |
| `email_log` failure rate | >10% of sends in a rolling day | Provider-side issue or a deliverability/configuration problem — check Resend's dashboard |
| Webhook/verify mismatch (above) | Any row unresolved after 1 hour | Investigate manually — there is no automated reconciliation to check first |

## Recommended Cloudflare Analytics usage

- **Cloudflare Web Analytics** (privacy-respecting, cookie-free) remains a reasonable, low-effort option for the static site's traffic, if and when this project wants it — not currently configured.
- **Workers Analytics Engine / the GraphQL Analytics API** is the equivalent for the backend — request volume, error rates, and latency percentiles for the Worker, queryable without a third-party APM tool. The Worker has real production traffic now (unlike when this document was first written), so this is a genuinely available option today, not a future one — not yet configured, but no longer blocked on "nothing to analyze yet."
