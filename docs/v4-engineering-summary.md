# Version 4 Series — Engineering Summary & Freeze Declaration

**Version 4 is now officially frozen**, effective with the Version 4.9 Production Certificate (`docs/v4.9-production-certificate.md`), commit `2b90e1b`, Worker version `efe28f82-6348-4786-964f-9a31dd36fcdd`.

---

## Freeze scope

No further Version 4 development will occur, with three narrow exceptions:

1. **Critical security fixes** — a vulnerability with real exploit potential.
2. **Critical production bugs** — a defect actively breaking a live customer-facing or revenue-facing flow.
3. **Infrastructure outages** — Cloudflare/Paystack/Resend/D1/R2 incidents requiring an immediate operational response.

Explicitly **not** permitted under the freeze: new features, UI redesigns, or any scope expansion, regardless of how small. Any of the three exceptions above should be scoped as narrowly as possible — a fix, not an opportunity to also improve something adjacent.

---

## Engineering achievements, Version 4.0 → 4.9

### CMS maturity
Full editorial control over products, resources, and blog posts, backed by a proper media library (`media_assets`) with SHA-256 content-hash duplicate detection, broken-media-reference auditing (`getPublishingInventory`'s `brokenMediaReferences` check), and metadata-completeness signals (missing covers, missing SEO fields) surfaced directly on the Executive Dashboard rather than discovered by accident.

### Executive Dashboard
Built from nothing into a genuine business-intelligence surface across Version 4.0's several milestones: headline KPIs, revenue intelligence (best-seller, highest-revenue-day, a real linear-trend forecast that refuses to render with fewer than 3 months of data rather than guess), publishing inventory, financial breakdown, sales charts, customer insights (CLV, repeat-purchase rate, time-to-first-review), operational feeds, and business alerts — all computed live from D1, with an explicit "no placeholder metrics" discipline held throughout: a metric this codebase cannot honestly compute (e.g. Top Referrers, since no referrer field exists) is simply omitted, never faked.

### Analytics
`analytics_events` (Version 4.0 Milestone A) added real, anonymous page-view/CTA-click/traffic-source measurement without ever threading a persistent identifier through the checkout flow — a deliberate privacy-posture choice, not an oversight. This release (4.9) extended classification-awareness across the *entire* dashboard, not just headline revenue, so every metric an admin sees can be scoped to Production-only, Production+Internal, or everything.

### Customer Accounts
Customer identity, sessions, and profiles (Version 3.x groundwork, matured through 4.x), built on the same session-token/CSRF pattern already proven for admin authentication rather than a second, parallel auth system.

### Purchase Lifecycle
Checkout → Paystack-verified payment → order artifacts (order items, licenses, receipts with PDF generation, entitlement-gated deliveries) → download, with coupon support added without altering the core verified-amount semantics, and redemption-limit race conditions handled correctly under concurrent payment attempts (see `couponRaceConditions.test.ts`).

### Email Lifecycle
A complete customer-journey email system: newsletter welcome, free-guide delivery, purchase receipt, secure download, purchase follow-up, review reminder, and newsletter campaigns — every send tracked in `email_log` with per-template diagnostics surfaced in Settings, and a dedicated Email Lifecycle dashboard section (Version 4.0 Milestone C1) answering "is the customer journey's email system actually working" in one place.

### Product Bundles
Added (`products.is_bundle` + `bundle_items`, migration `0027`) as a plain additive column and a new junction table — deliberately not a widened `product_type` CHECK constraint, so the existing product model never had to be restructured to support the new concept.

### Archive Centre *(new this release)*
Filter-based, read-only visibility into every classified business table, an evidence-and-related-records review workflow for ambiguous data, and a promotion action that resolves an `UNKNOWN` record with a mandatory reason — every one of them audit-logged. Built from a single entity registry that is the one place deciding which tables/columns are reachable at all, so a request can never touch an unlisted table or a secret column.

### Production Classification *(new this release, spanning both sessions)*
An explicit, never-guessed four-tier model — PRODUCTION / INTERNAL / DEVELOPMENT / UNKNOWN — applied across 22 tables with a full, documented evidence trail (Paystack's own `test`/`live` domain signal being the single most decisive piece of evidence used). Replaces what had been an unstated assumption that all database rows represented equally real business activity.

### Launch Baseline *(new this release)*
An append-only `production_launch_baselines` table whose immutability is enforced by database triggers, proven — not assumed — by directly attempting and failing an UPDATE and two DELETEs against a real row on production D1 during this milestone's verification pass.

### Security
Session/CSRF discipline held consistently across every new admin surface added in this release (Archive Centre, Analytics Mode preference, Launch Baseline capture) — no shortcuts taken for being "just an internal tool." Secrets (Paystack, Resend) live exclusively in Cloudflare's secret store, never in code or version control. Every classification change and analytics-mode preference change writes through the platform's one existing `auditService.record()` function — no parallel, easier-to-forget logging path was ever introduced.

### Performance
A deliberate, consistently-applied engineering stance: no caching layer or pre-aggregation table has been introduced anywhere in this series where real row counts don't yet justify the added complexity — stated explicitly in `analyticsService.ts` at the start of Version 4, and carried through unchanged into this release's Archive Centre and Launch Baseline services.

---

*This document, together with `docs/v4.9-production-certificate.md`, is the permanent engineering record of the Version 4 series.*
