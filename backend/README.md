# Backend

## Status

**This is the live production backend.** A Cloudflare Worker (`robayer-wealthlab-api`) is deployed and serves `robayerwealthlab.com/api/*`, `/books/*`, `/resources/*`, and `/blog/*` via a Workers Route, alongside a real D1 database (16 applied migrations, through Version 2.1 Phase 6), an R2 bucket (Media Library uploads, product/resource files), and a KV namespace (rate-limit counters). The static site itself — every other page, GitHub Pages — is a separate deployable that happens to share the same domain; see `docs/cloudflare-architecture.md` for the original rationale and each `docs/v2.1-phaseN-implementation.md` for what's shipped since.

## Folder structure

| Folder | Purpose |
|---|---|
| `worker/` | The single Cloudflare Worker entry point (`index.ts`) — request routing, environment bindings (`env.ts`), top-level error handling |
| [`routes/`](routes/README.md) | One module per resource — public routes (newsletter, contact, consultation, checkout, webhooks, downloads, unsubscribe, books/resources/blog server-rendering) and `admin/` routes (auth, users, settings, products, media, orders, consultations, contacts, analytics, resources, blog, newsletter campaigns) |
| `middleware/` | Cross-cutting request handling: `requireAuth`, `requireRole`, CSRF, rate limiting, CORS, maintenance mode, input validation, error handling |
| [`services/`](services/README.md) | Business logic, independent of HTTP — the layer routes call into, and the layer that calls D1/R2/KV, Resend, and the Paystack API |
| `database/` | The cumulative D1 schema (`schema.sql`) and every applied migration (`migrations/0001` through `0016`) |
| `emails/` | Outbound email templates (bundled as importable strings via `wrangler.jsonc`'s text-module rule) and `emailService.ts` |
| `types/` | Shared TypeScript types: standardized API response contracts (`api-contracts.ts`) |
| `utils/` | Small, pure helpers — password hashing, session/CSRF token generation, rich-text sanitization, validation, logging |

## Real secrets vs. non-secret configuration

`wrangler.jsonc` holds only non-secret configuration and binding names — the two real secrets this project has, `RESEND_API_KEY` and `PAYSTACK_SECRET_KEY`, are set via `wrangler secret put` and never committed. There is no separate Paystack webhook secret (Paystack signs webhooks with the account's own secret key — see `backend/worker/env.ts`'s comment) and no admin-session signing secret (admin sessions are validated against D1 rows, not a shared secret). See `docs/deployment-checklist.md` for the full deployment procedure and `docs/backup-and-recovery.md` for secret rotation.

## What does not exist

- No Cloudflare Queues, Cron Triggers, or Durable Objects anywhere in this project — see `docs/v2.1-technical-debt-register.md` for the reasoning and the concrete triggers that would justify introducing one.
- No staging environment — `wrangler.jsonc` has no `env.staging` block yet; see `docs/deployment-checklist.md`'s "Staging deployment" section.
- No automated backup export beyond D1's built-in Time Travel, and no automated Paystack webhook reconciliation — both are known, documented gaps, not silent ones (`docs/backup-and-recovery.md`).
