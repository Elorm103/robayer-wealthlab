# config/

## Purpose

Documents the environment variables and Cloudflare Worker configuration
(`wrangler.jsonc`) a future deployment will need — **names and purposes
only, never real values.** No secret, key, or credential of any kind
belongs in this repository at any time, committed or not — real values
are set through Cloudflare's own secrets mechanism (`wrangler secret put`)
or dashboard, entirely outside git.

## Planned environment variables (future)

| Variable (future) | Purpose | Secret? |
|---|---|---|
| `ADMIN_SESSION_SECRET` | Signing admin session tokens — see `docs/authentication-strategy.md` | Yes |
| ~~`ALLOWED_ORIGIN`~~ | Was a CORS allow-list. Implemented in Version 2.0 Phase 0.2, then **removed entirely** in the Version 2.0 Same-Origin Migration once the frontend and this Worker became same-origin (no CORS-consuming caller remained) — see `../../docs/v2-same-origin-architecture.md` | — |
| `RESEND_API_KEY` | Outbound transactional email via Resend — see `docs/email-architecture.md` (this row was a generic `EMAIL_API_KEY` placeholder until the provider was chosen) | Yes |

`PAYSTACK_WEBHOOK_SECRET` (originally planned here as a distinct
variable) turned out not to be needed — see "Implemented" below and
`docs/payment-verification.md`'s "Known limitations."

## Implemented environment variables (Version 1.2 Sprint 2.3 — Commerce Foundation, extended Sprint 2.4 — Payment Verification)

| Variable | Purpose | Secret? |
|---|---|---|
| `SITE_BASE_URL` | Where `content/products/*.json` (the Product Platform) is publicly served — see `docs/commerce-foundation.md` | No |
| `PAYMENT_PROVIDER` | Selects a `backend/services/payments/` implementation (`"paystack"` today) | No |
| `PAYSTACK_BASE_URL` | e.g. `https://api.paystack.co` | No |
| `PAYSTACK_SECRET_KEY` | Server-side Paystack API calls (`POST /transaction/initialize`, Sprint 2.3; `GET /transaction/verify/:reference`, Sprint 2.4) — **and, as of Sprint 2.4, also verifies the `x-paystack-signature` webhook header** (`backend/utils/webhookSignature.ts`). Paystack signs webhooks with the account's own secret key, not a separate webhook secret — see `docs/paystack-integration.md` and `docs/payment-verification.md` | Yes — Worker secret, never in `wrangler.jsonc` directly |
| `PAYSTACK_PUBLIC_KEY` | Non-secret, but unset — no real Paystack account exists yet, and unused by `createCheckoutSession()`'s Standard/Redirect flow | No, but reserved |

## Planned `wrangler.jsonc` bindings (future)

- A D1 binding pointing at the database defined in `database/schema.sql`.
- One or more R2 bucket bindings, matching `storage/README.md`'s
  bucket layout.
- A KV namespace binding, for the two specific use cases documented in
  `docs/backend-security.md` (rate-limit counters) and
  `docs/authentication-strategy.md` (admin session storage) — per this
  sprint's brief, KV is used "only where appropriate," not as a general-purpose
  store when D1 already fits (e.g., orders, customers).

## Today

*(Updated in Version 1.2 Sprint 3.)* `../wrangler.jsonc` now exists,
with real D1/R2/KV binding *names* and placeholder IDs
(`PLACEHOLDER_D1_DATABASE_ID`, `PLACEHOLDER_KV_NAMESPACE_ID`) — no
Cloudflare account has actually provisioned a database, bucket, or
namespace yet, so these placeholders don't point at anything real
until the deployment steps in the Sprint 3 implementation report are
run. Of the variables listed above, only `ALLOWED_ORIGIN` (non-secret,
in `wrangler.jsonc`) and `RESEND_API_KEY` (secret, see
`../.dev.vars.example` for local development) are relevant to this
sprint's scope — `PAYSTACK_SECRET_KEY`, `PAYSTACK_WEBHOOK_SECRET`, and
`ADMIN_SESSION_SECRET` remain undefined on purpose, since Paystack and
the admin dashboard are explicitly out of scope for Sprint 3.

*(Updated again — Version 1.2 Sprint 2.3, Commerce Foundation.)*
`SITE_BASE_URL`, `PAYMENT_PROVIDER`, and `PAYSTACK_BASE_URL` are now
real, non-secret values in `../wrangler.jsonc`'s `vars`.
`PAYSTACK_SECRET_KEY` is documented in `../.dev.vars.example` with a
placeholder value for local development — no real Paystack account
exists yet, so this has no real value anywhere, matching this
project's discipline of never committing fabricated credentials.
`ADMIN_SESSION_SECRET` remains undefined on purpose — it belongs to
the admin dashboard.

*(Updated again — Version 1.2 Sprint 2.4, Payment Verification.)* No
new environment variable was added for webhook verification —
`PAYSTACK_SECRET_KEY` (already configured in Sprint 2.3) does double
duty, per Paystack's own documented webhook-signing behavior. The
`PAYSTACK_WEBHOOK_SECRET` row this document originally planned is
removed rather than left unimplemented, since it turned out not to
describe a real, separate credential this project needs.

*(Updated again — Sprint 3, Worker-initialization pass.)* The config
was originally written as `wrangler.toml`, then migrated to
`wrangler.jsonc` (Wrangler's currently-recommended format — newer
features are JSON-only) once real Wrangler tooling became available to
generate and verify it properly: `wrangler types` and
`wrangler deploy --dry-run` both run cleanly against it, confirming
the bindings/placeholder values are actually well-formed, not just
manually reasoned about. The old `.toml` was removed rather than kept
alongside the `.jsonc`, since Wrangler treats one config file as
canonical and keeping both risks silent drift. `observability` was
also added (`head_sampling_rate: 1`), matching current Workers
guidance and `docs/monitoring-and-alerting.md`'s existing "Cloudflare's
own dashboard tooling is sufficient" reasoning. No `compatibility_flags`
are set — this Worker has zero runtime npm dependencies, so
`nodejs_compat` has nothing to shim.
