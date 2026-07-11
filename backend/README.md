# Backend (Version 1.2 Sprint 2 — Architecture Only)

## Status

**Nothing in this folder is deployed, connected, or live.** No
Cloudflare Worker has been created in any Cloudflare account, no D1
database exists, no R2 bucket exists, and the static site does not
call anything here. This folder is the designed *shape* of a backend
that will be built and deployed in a future sprint, once explicitly
approved.

The live site — every page, every existing script, GitHub Pages
itself — is completely unaffected by this folder's existence. See
`docs/cloudflare-architecture.md` for the full Phase 1 rationale and
`docs/migration-roadmap.md` for how this folder goes from "designed"
to "live" over future sprints.

## Why Cloudflare, and why now

The static site is already served through Cloudflare (DNS/CDN for
`robayerwealthlab.com`), and Version 1.2 Sprint 1's commerce
architecture (`docs/paystack-integration.md`, `docs/download-security.md`)
identified an unavoidable need for *some* server-side piece — Paystack
transaction verification cannot be done from a browser without exposing
a secret key, and GitHub Pages cannot run server-side code at all.
Standardizing that piece on Cloudflare Workers/D1/R2 means the backend
lives in the same ecosystem already handling this domain, with one
platform to reason about instead of stitching together GitHub Pages
plus an unrelated hosting provider.

## Why this isn't "no backend" anymore, and why that's still safe

Introducing a real backend is a bigger architectural step than
anything Version 1.1 or Sprint 1 did — but it changes *nothing* about
how the static site works today. Cloudflare Workers, D1, and R2 are
called *by* a future frontend feature (a "Buy" button, a newsletter
form) when that feature is built — they do not require converting
`index.html` or any other page into anything other than plain,
GitHub-Pages-servable HTML. The site and the backend are two separate
deployables that happen to share a domain, exactly like a WordPress
site and its database are two separate systems that happen to work
together.

## Folder structure

| Folder | Purpose |
|---|---|
| [`worker/`](worker/README.md) | The single Cloudflare Worker entry point — request routing, environment bindings (D1/R2/KV), top-level error handling |
| [`routes/`](routes/README.md) | One module per resource (orders, payments, newsletter, consultation, downloads, products, admin) — each documents its endpoints; see `docs/worker-api-design.md` for full request/response detail |
| [`middleware/`](middleware/README.md) | Cross-cutting request handling: authentication checks, rate limiting, CORS, input validation — run before a route's own logic |
| [`services/`](services/README.md) | Business logic, independent of HTTP — the layer routes call into, and the layer that calls D1/R2/KV and the Paystack API |
| [`database/`](database/README.md) | The D1 schema (`schema.sql`) and future migrations |
| [`storage/`](storage/README.md) | The R2 bucket/folder structure documentation |
| [`config/`](config/README.md) | Environment variable *names* and `wrangler.toml` planning — never real secret values |
| [`types/`](types/README.md) | Shared TypeScript types: standardized API response contracts and entity shapes mirroring the D1 schema |
| [`utils/`](utils/README.md) | Small, pure, reusable helpers (validation, reference generation) — documented now, implemented when a route needs them |
| [`emails/`](emails/README.md) | Outbound email templates and shared layout — see `docs/email-architecture.md` for the full design (provider, triggers, retry, branding) |

## What is deliberately NOT here

- No Paystack SDK, API keys, or webhook secret.
- No actual Worker deployment config pointed at a real account.
- No route handler contains working logic — `routes/`, `middleware/`,
  `services/`, and `utils/` are documented (what will exist, and why)
  rather than implemented, per this sprint's explicit "no live
  implementation" scope. The two exceptions are `database/schema.sql`
  (a concrete D1 schema — the *design itself*, not a live database)
  and `types/*.ts` (TypeScript type definitions have no runtime
  behavior at all — they are documentation that happens to be
  machine-checkable).
- No admin login page, dashboard, or frontend of any kind.
