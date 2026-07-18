# Changelog

All notable work on the Robayer WealthLab website is recorded here. Dates
are in `YYYY-MM-DD`. Entries are grouped by development phase/sprint;
`v1.0.0-production-baseline` is the first tagged checkpoint (see below),
marking the site as production-ready.

## [Unreleased]

**Changed — social media integration**
- Connected the site's official social channels (Facebook, Instagram,
  LinkedIn, YouTube, WhatsApp, TikTok), replacing the `href="#"`
  placeholders in the footer social icon row that had been in place
  since `[v1.0 Sprint N]` below ("ready to wire up once real accounts
  exist"). Updated `assets/config/site.json`'s `social` block (the
  single source of truth the footer reads at runtime) and
  `partials/footer.html`'s static fallback hrefs; added
  `target="_blank" rel="noopener noreferrer"` to each. Removed the
  unused `twitter`/X placeholder — no real account exists for that
  platform yet, so no link is shown rather than a dead one.
- Added a `sameAs` array (the 6 real profile URLs above) to the
  `Organization` JSON-LD block on every page, for correct
  structured-data association between the site and its social
  profiles.

## [Unreleased] — Version 2.1 Phase 3 — Identity & Security — 2026-07-18

Third stage of Version 2.1 (Content & Administration Platform, see `docs/v2.1-architecture-plan.md`). Not yet tagged.

**Added**
- Migration `0013_identity_security.sql` — `admin_users` gains `must_change_password`/`failed_login_attempts`/`locked_until`/`password_updated_at`; new `password_reset_tokens` (single-use, 30-minute TTL) and `login_history` (dedicated, alongside the existing `audit_logs` events) tables.
- Change password (`services/admin/authService.ts`'s `changePassword()`) — requires current-password re-entry, shared `passwordPolicy.ts` strength validation, revokes every other active session on success.
- Forgot/reset password — same no-user-enumeration discipline the login endpoint already established; reset-password forces logout of every session on the account, per explicit requirement. New `password-reset.html` email template.
- Account lockout — 5 consecutive failed logins locks the account for 15 minutes (time-boxed, not permanent), timing-indistinguishable from an ordinary wrong-password attempt. `login_history` distinguishes `failed_locked` from `failed_password`.
- Forced password-change gate — `must_change_password` is enforced centrally in `requireAuth()` (every `/api/admin/*` route rejected except session-check/change-password/logout), not by any individual route.
- `/admin/account/` — new Account & Security page: profile summary, change password, active sessions (view/revoke, IDOR-checked), login history. `/admin/forgot-password/`, `/admin/reset-password/` — standalone pages matching `admin/login/`'s pattern. "My Account" added to the admin topbar user menu.

**Fixed — real defect found during local verification**
- `admin_sessions.last_seen_at` is written in two different timestamp formats depending on the code path (SQL `datetime('now')` at creation vs. `Date.toISOString()` on every subsequent validated request) — the Account page's date formatter assumed only the first, producing "Invalid Date" for the current session's own row. Fixed by normalizing both formats before parsing.

**Verified**
- Full local adversarial pass (lockout threshold/timing, reset-token single-use, IDOR on session revocation, CSRF, SQL injection, the must-change-password gate blocking an unrelated module route) and a real production verification (login, change-password, forgot/reset-password including a real Resend send, all against disposable data — the real production admin account was never touched, confirmed unchanged after cleanup). See `docs/v2.1-phase3-implementation.md`.

## [Unreleased] — Version 2.1 Phase 2 — Blog CMS — 2026-07-18

Second stage of Version 2.1 (Content & Administration Platform, see `docs/v2.1-architecture-plan.md`). Not yet tagged.

**Added**
- Migration `0012_blog_cms.sql` — new `blog_posts` table, D1-direct CMS pattern (mirrors Resources). Two-state lifecycle (draft/published) per the user's own scoped requirement; soft delete already covers "remove from public view."
- `services/blogService.ts`, `routes/admin/blog.ts` — full CRUD, publish/unpublish lifecycle (a post needs real body content before it can publish), real author attribution via `admin_users` FK, derived reading-time estimate, soft delete/restore, duplicate, bulk actions.
- `routes/blog.ts` — public `/blog/*` Workers Route, server-rendered, replacing the static `blog/` pages. Session-gated `?preview=1` lets an admin preview a draft; a logged-out visitor always gets an honest 404.
- `/admin/blog/`, `/admin/blog/new/`, `/admin/blog/edit/` — list + editor admin pages, mirroring Resources' structure (rich text, cover-image picker, author select, SEO fields, live preview, preview link).
- `richTextSanitizer.ts`'s allowlist (server and client) extended with table tags, so the one real, SEO-indexed legacy article ("What Are Treasury Bills in Ghana?") could be migrated with its comparison table intact. Its pull-quote, alert boxes, "Key takeaways" card, sticky TOC, and per-article FAQ were flattened to plain rich-text per the user's approved reduced-fidelity migration choice.

**Fixed — real defect found during local verification**
- `.admin-bulk-bar` had unconditional `display: flex` with no `[hidden]` override, so the bulk-action bar rendered visible even with zero rows selected — affects Resources and Products too, not just Blog. Fixed with `.admin-bulk-bar[hidden] { display: none; }`, following this codebase's existing pattern for the same class of bug elsewhere in `admin.css`.

**Verified**
- Full local adversarial pass (CSRF, SQL injection, XSS, role-boundary/IDOR, publish-without-body, preview-URL gating against a genuinely anonymous request) and a real production verification of the migrated article and admin auth boundary. See `docs/v2.1-phase2-implementation.md`.

## [Unreleased] — Version 2.1 Phase 1 — Resources CMS — 2026-07-18

First stage of Version 2.1 (Content & Administration Platform, see `docs/v2.1-architecture-plan.md`). Not yet tagged — Version 2.1 is tagged only after all 7 planned phases (Resources, Blog, Identity & Security, User Management, Settings, Newsletter Campaigns, Final Audit) are complete.

**Added**
- Migration `0011_resources_module.sql` — new `resources` table, D1-direct CMS pattern (mirrors Products, trimmed: no pricing, no files/gallery/relations join tables — at most one file, one cover).
- `services/resourceService.ts`, `routes/admin/resources.ts` — full CRUD, publish lifecycle (a resource needs a real file before it can publish), soft delete/restore, duplicate, bulk actions. Writes gated to `editor`/`super_admin`; every role reads.
- `routes/resources.ts` — public `/resources/*` Workers Route, server-rendered, replacing the static page's `data-placeholder-action` download stubs with real downloads for the first time. Hero/FAQ/calculators copy preserved verbatim from the original hand-authored page; the resource grid, featured banner, and "Popular resources" list are now genuinely data-driven.
- `/admin/resources/`, `/admin/resources/new/`, `/admin/resources/edit/` — list + editor admin pages, mirroring Products' structure (rich text, Media Library pickers, SEO fields, live preview).

**Fixed — real defect found during local verification**
- The public download route's `Response.redirect()` call threw on every real request (it requires an absolute URL; this app's `filePublicUrl` convention is root-relative) — fixed by constructing the redirect `Response` by hand with a `Location` header.

**Verified**
- Full local + production adversarial pass (CSRF, SQL injection, IDOR, role-boundary) and a real end-to-end production test (create → publish → public render → real download → counter increment) against disposable data, cleaned up immediately after. See `docs/v2.1-phase1-implementation.md`.

## [v2.0-phase3-operational-visibility-complete] — 2026-07-18 — Operational Visibility (Consultation/Contact Manager, Orders, Analytics)

Adds the four remaining "empty shell" admin modules real data and workflows: a support-workflow Consultation Manager and Contact Manager, a read-only Orders view over the existing commerce data, and an Analytics dashboard with real period-over-period KPIs, timeseries charts, and Top Products — plus a Dashboard fix and a full acceptance audit. Full stage-by-stage detail, adversarial-test results, and production deployment reports in `docs/v2.0-phase3-implementation.md`; architecture and rationale in `docs/v2.0-phase3-architecture-plan.md`; this entry is the summary.

**Added — database**
- Migration `0010_operational_visibility.sql` — `consultation_notes`, `contact_notes` tables; `assigned_to` columns (with indexes) on `consultation_requests`/`contact_messages`. Purely additive.

**Added — backend**
- `services/admin/consultationService.ts` + `routes/admin/consultations.ts`, `services/admin/contactService.ts` + `routes/admin/contacts.ts` — list/detail/update/add-note, open to all three roles including writes (a deliberate divergence from Products' editor-gated pattern — these are support workflows, not a CMS).
- `services/admin/orderService.ts` + `routes/admin/orders.ts` — read-only order list/detail plus two `super_admin`/`editor`-gated actions (resend receipt, resend download email).
- `services/admin/analyticsService.ts` + `routes/admin/analytics.ts` — real D1-aggregate KPI summary (period-over-period, with `deltaPercent: null` rendered "New" rather than a fake `0%`), zero-filled daily timeseries, Top Products ranking joined to live product titles.
- `utils/dateRange.ts` — shared, tested date-range math (`exclusiveEndDate`, `previousPeriod`, `deltaPercent`, `everyDateInRange`).

**Added — admin frontend**
- `/admin/consultations/`, `/admin/contacts/` — filterable/searchable tables with a slide-out drawer (new `.drawer*` CSS in `css/admin.css`) for detail, status, assignment, and notes.
- `/admin/orders/` — table with search/status/date-range filters and a drawer showing payment transactions, deliveries, and email history; resend actions hidden entirely (not just disabled) for the `support` role.
- `/admin/analytics/` — date-range picker, 6 KPI cards with delta badges, 2 dependency-free inline-SVG charts (`js/components/admin/timeseries-chart.js`), Top Products table, and an honest link-out card to Cloudflare Web Analytics for Visitors/Sessions/Traffic Sources (which have no API and are never faked).

**Fixed — real defects found and fixed during implementation**
- Orders' `dateTo` filter used an inclusive bare-date upper bound (`created_at <= '2026-07-18'`) against a full timestamp column — under SQLite's lexicographic TEXT comparison this silently excluded nearly every row from the end date. Fixed with an exclusive-upper-bound pattern, extracted into `utils/dateRange.ts` so Analytics' own date math reuses the corrected logic.
- Dashboard's `productsCount` had been hard-coded to `null` since before the Products Module existed — never wired up when Phase 2 added a real `products` table. Fixed with the same fault-tolerant `try/catch → null` pattern every other Dashboard field uses.
- A CSS specificity bug (`.drawer__footer { display: flex }` unconditionally overriding the browser's default `[hidden]` rule) meant a `support`-role admin could visually see Orders' resend buttons even though the server correctly rejected the action — never an actual security hole (server-side check was always correct), but a confusing UI bug. Fixed with `.drawer__footer:not([hidden])`.

**Fixed — Stage 5 acceptance-audit findings**
- `Cache-Control: no-store` was previously set only on the Dashboard endpoint (via its own local wrapper); every other admin endpoint (Orders, Analytics, Consultations, Contacts, Products, Media Library) sent no caching header at all despite returning sensitive data. Moved into `middleware/securityHeaders.ts`'s shared `securityHeaders()` function, now applied globally to every non-HTML response.
- `handleConsultationGet`/`handleContactGet` were missing the rate limiting every other Phase 3 read endpoint has.
- Unescaped customer email in `mailto:` href construction (both Consultation and Contact drawers) — a mailto-injection-adjacent gap given this codebase's permissive email regex — fixed with `encodeURIComponent()`.
- Stale "Getting started" Dashboard copy claiming Products/Media Library "arrive in later phases" — both had shipped phases earlier.

**Verified**
- All 7 admin modules (Dashboard, Orders, Analytics, Consultations, Contacts, Media Library, Products) exercised together in a real browser against real production-shaped data, zero console errors.
- Full adversarial battery — CSRF (missing/garbage token → 403), SQL injection (parameterized queries return empty safely, tables intact), IDOR (clean 404s, no leak), a live XSS probe via the public consultation form (rendered as literal escaped text everywhere, confirmed via `innerHTML` inspection — no injection), authorization (`support` role blocked server-side from every editor-only write, confirmed via live 403s), authentication (`HttpOnly; Secure; SameSite=Lax` session cookie, generic invalid-credentials message with no user-enumeration signal), cache behavior (before/after `curl` header comparison in production).
- Every real email send in Stage 3 verified against the site owner's own inbox with real Resend provider IDs recorded; every KPI in Stage 4 independently hand-computed via direct SQL before comparing to the API response.
- No test accounts, debug code, or leftover rows created by this phase remain in production; every stage's own disposable test data was created, exercised, and deleted within that same stage, verified via exact before/after row-count matches.

**Known limitation** — a returning admin's browser may serve a stale cached copy of a changed static JS/CSS file for up to its 4-hour `Cache-Control: max-age=14400` lifetime (a pre-existing, site-wide GitHub Pages/Cloudflare default, not introduced by this phase); a hard refresh or the natural cache expiry resolves it. Site-wide cache-busting was judged out of scope for this phase.

## [v2.0-phase2-products-complete] — 2026-07-13 — Products Module (D1-backed catalog)

Replaces the static `content/products/*.json` catalog with a D1-backed CMS: admin CRUD, server-rendered public product pages, and full checkout/entitlement integration on the new catalog. Full architecture, migration, and rollback detail in `docs/products-module-implementation.md` and `docs/v2.0-phase2-release-checkpoint.md` (this entry is the summary).

**Added — database**
- Migration `0008_products_module.sql` — `products`, `product_files`, `product_gallery`, `product_relations` tables (D1 is now the sole source of truth, not a mirror of JSON); drops the empty, never-populated `products`/`customers`/`orders`/`downloads` cluster from Version 1.2 Sprint 1 planning (verified 0 rows, no live references, before dropping).
- Migration `0009_migrate_json_products.sql` — one-time import of the 2 real products from `content/products/*.json`, preserving `product_id`/`asset_id` strings character-for-character so existing `purchase_sessions`/`deliveries` rows keep resolving.

**Added — backend**
- `services/productService.ts` — full CRUD, validation, publish lifecycle (draft/active/coming-soon/archived/hidden/unavailable), soft delete/restore, duplicate, bulk actions; every mutation audit-logged.
- `routes/admin/products.ts` — role-gated (editor/super_admin write, every authenticated role read) admin API.
- `routes/products.ts` — public, unauthenticated read API (`active`/`coming-soon` only, whitelist not blacklist).
- `routes/books.ts` — server-rendered `/books/*` HTML (new Workers Route), replacing GitHub Pages static files for this path space; deliberately self-contained (no origin-proxy fallback) to avoid a Workers Route self-interception risk found during design review.
- `utils/richTextSanitizer.ts` — server-side HTMLRewriter-based sanitizer for the admin's rich-text `description` field (defense in depth alongside client-side sanitization).
- `productCatalogService.ts` updated to read the D1 tables instead of fetching JSON over HTTP — its external contract unchanged, so `commerceService.ts`/`entitlementService.ts`/`fulfilmentService.ts` needed zero changes.

**Added — admin frontend**
- `/admin/products/` (list: search/filter/sort/bulk actions/pagination), `/admin/products/new/` and `/admin/products/edit/` (full editor: pricing, SEO, media picker, rich text, files/gallery/relations, publish lifecycle).

**Changed**
- `js/components/product-loader.js` now reads `/api/products` instead of `content/products/*.json`.
- `middleware/securityHeaders.ts` — CSP now branches on response Content-Type (HTML pages get a real scoped policy; JSON/binary responses keep the original strict `default-src 'none'`), needed once `/books/*` became a genuine HTML-rendering surface.

**Adversarial findings fixed (two independent passes)**
- HTMLRewriter "attributes modified during iteration" crash on a multi-attribute XSS payload (live-iterator bug in the sanitizer).
- Missing `Cache-Control` on `/books/*` HTML (now explicit `no-store` — these pages are now admin-editable).
- Missing `BreadcrumbList`/`FAQPage` JSON-LD and a stale, truncated meta description on `/books/` vs. the original hand-authored pages.
- **Status field silently dropped on update** — the admin edit page's own "Set status" dropdown had no effect due to a missing column in an `UPDATE` statement; the only working status-change path was the list page's bulk actions. Found in the second (final acceptance) audit, fixed, verified against production with a disposable test product.
- Six source comments pointing at a design-doc filename that was never actually written, corrected to the real doc.

**Verified**
- Every non-public product status (draft/hidden/unavailable/archived) 404s on the public detail page and 409s on checkout; role boundaries (support = read-only) confirmed via live 403s; no test accounts/data/debug code/TODOs remain in production; SEO metadata and JSON-LD diffed byte-for-byte against the original static pages.

**Known limitations** — see `docs/v2.0-phase2-release-checkpoint.md`.

## [v1.1 Sprint 6] — 2026-07-05 — Ghana Investment Centre

The sixth production feature of Version 1.1, built on the frozen
architecture — no folders renamed, no components replaced, no design
tokens changed, no framework introduced, no CMS. A pure educational
knowledge hub: 10 real, complete Ghana-focused investment topic pages
plus 3 curated learning paths, organizing existing platform content
rather than duplicating it. Not a news site, not financial advice, no
calculators/booking/authentication added.

**Added — pages**
- `/investment-centre/` — hero, disclaimer, a 10-topic grid with
  difficulty badges, 3 Learning Paths (Beginner Investor, Growing
  Investor, Long-Term Wealth Builder — each recommending topics,
  calculators, services, and goals in a suggested order), FAQ (6
  Q&As), "Keep exploring," newsletter CTA.
- `/investment-centre/{slug}/` &times; 10 — Treasury Bills, Government
  Bonds, Money Market Funds, Mutual Funds, Ghana Stock Exchange (GSE),
  Fixed Deposits, SSNIT & Pension Basics, Real Estate Investing, Gold
  Investing, Emergency Funds. Each: Hero (with a Beginner/Intermediate/
  Advanced difficulty badge), Overview, Why It Matters, Benefits,
  Risks, Who It Suits, FAQ (6 Q&As), Related Calculators/Services/
  Goals/Resources, Consultation CTA, Newsletter CTA. Every topic is
  genuinely complete, honest educational copy — no placeholders, no
  fabricated statistics or rates, no specific product/stock
  recommendations.

**Added — content**
- `content/investment-centre/{slug}.json` &times; 10 — the same "real
  content, no consumer yet" arrangement as `content/services/` and
  `content/calculators/`. Introduces `category`, `difficulty`, and a
  nested `seo` object as new schema fields, and `relatedGoals` as the
  first cross-reference to point *into* the Goal Planner from a
  reading-content page (`/goal-planner/?goal={slug}`, reusing Sprint
  5's query-param pattern).
- `content/investment-centre/README.md`, `content/SCHEMA.md`
  (`Investment Centre Topic` entry), `content/README.md` — documented.

**Changed — cross-links**
- `partials/header.html` — added "Investment Centre" to primary nav
  (9 items; verified no overflow at the existing 1199px breakpoint —
  measured margin was sufficient, no CSS change needed this time).
- `index.html` — the "Investment Insights" card (copy: "treasury
  bills, the GSE, and where money actually grows") retargeted from the
  generic `/blog/` hub (which only has one, unrelated article) to
  `/investment-centre/`, which now genuinely covers both subjects.
- `learn/index.html` — added the Investment Centre to the "Investing"
  topic grid and the "Browse everything" list.
- `services/investment-education/index.html`,
  `services/retirement-planning-guidance/index.html` — added an
  "Investment Centre" entry to each page's "Keep exploring" section,
  linking to the most directly relevant topic guides.
- `sitemap.xml` — 11 new `<url>` entries, `lastmod` 2026-07-05.

**SEO**
- Unique title/meta description/canonical/OG/Twitter tags on all 11
  pages.
- `Organization`, `BreadcrumbList`, `WebPage`, and `FAQPage` JSON-LD on
  every page, matching each page's visible FAQ accordion exactly.

**Accessibility**
- Zero elements with a positive `tabindex`; all interactive elements
  are native `<a>`/`<button>` — no custom widgets, no keyboard traps.
- Heading hierarchy verified on every page: H1 → H2 sections → H3
  "Related" sub-headings, no skipped levels.
- Difficulty badges reuse the existing `.badge` component's semantic
  color variants (success/info/warning), not color alone, to convey
  Beginner/Intermediate/Advanced.

**Verified**
- Zero console errors, zero duplicate IDs, zero missing `alt`
  attributes, zero horizontal overflow (320–1440px, all 38 pages
  including the 11 new ones and the 1199/1200px nav breakpoint
  boundary).
- All 37 unique internal link targets across the 11 new pages resolve
  (200, not 404), including the `/resources/#anchor` fragments
  (confirmed target IDs exist) and the `?goal=`/`?category=`
  deep-links into the Goal Planner and Consultation.
- No external libraries, no backend, no calculators, no booking, no
  authentication — 100% static, GitHub Pages compatible.

**Future search strategy**
- Following the same pattern as `js/components/content-filters.js`,
  a future search/filter pass over the 10 topics would only need
  `data-category`/`data-title` attributes added to the topic grid's
  existing `.resource-card` markup — no restructuring.

## [v1.1 Platform Audit] — 2026-07-05 — Integration Audit (pre-Sprint 6)

A comprehensive, read-first platform-wide audit across navigation,
cross-linking, CTA wording, content integrity, JSON architecture,
component reuse, accessibility, SEO, performance, and documentation —
not a feature sprint. Full findings, rationale, and things deliberately
left unchanged are in the audit report delivered alongside this entry.

**Fixed**
- `partials/footer.html` — the "Learn" column linked Blog/Books/Resources
  but never `/learn/` itself; the "Services" column pointed to
  `/resources/`, `/blog/`, `/books/`, and `/contact/` under service-like
  labels instead of any real `/services/{slug}/` page (predates Sprint 1
  ever shipping real service pages). Corrected both columns to real,
  accurately-labeled destinations, and added `/consultation/` to the
  Company column — previously reachable only via inline CTAs, with zero
  presence in primary nav or footer.
- `index.html` — two homepage cards pointed away from what their own
  copy promised: "Financial Tools" ("Calculators and eBooks…") linked
  only to `/books/`, now `/calculators/`; "Treasury bills 101" linked to
  the generic `/resources/` hub when the real, matching article
  (`/blog/what-are-treasury-bills-in-ghana/`) already exists.
- 18× "Book a Consultation" CTA → "Request a Consultation" (6 service
  pages ×2, services hub ×2, 3 calculator pages ×1, calculators hub ×1)
  plus the matching `ctaLabel` field in 9 JSON files and `SCHEMA.md`.
  The Consultation page itself has always deliberately avoided
  "booking" language (Sprint 3: "not an automatic booking system"); the
  18 upstream CTAs pointing to it were repointed in Sprint 3 but never
  reworded, leaving a direct contradiction of that page's own stated
  policy.
- `content/services/retirement-planning-guidance.json` — `relatedResources`
  pointed to `/resources/#calculators-heading`, a section anchor,
  inconsistent with every sibling file's item-level anchors; changed to
  the generic `/resources/` (no specific real, live retirement resource
  exists yet).
- Documentation staleness: `content/README.md`, `content/services/README.md`,
  and `content/calculators/README.md` each still anticipated the Goal
  Planner (Sprint 4) or Learning Hub (Sprint 5) as a *future* consumer
  of `content/services/`/`content/calculators/` JSON. Both shipped since
  and made the opposite architectural choice (small hardcoded lookup
  tables, matching the Consultation Module's own precedent) — corrected
  to state this plainly, mirroring the self-correction already present
  for the Consultation Module in the same files.
- `content/SCHEMA.md` — the `Service` schema example still showed
  `"relatedCalculators": []` with a note that "no calculator exists on
  the site yet," stale since Sprint 2. Updated to a real example
  matching the live `financial-education.json` data.

**Verified, left unchanged (with reasoning)**
- Sitemap, robots.txt, all 27 canonical URLs, all 27 page titles/meta
  descriptions (unique, no duplicates), breadcrumb trail accuracy, hub
  page detail-page linking, JSON schema field-set consistency across
  all 18 content files, all `questionId`/slug cross-references in
  Goal Planner JSON, script-tag loadout per page, `dev-showcase.css`/
  `components.html` isolation, image alt text, heading hierarchy.
- Three anchors that looked fabricated at first glance
  (`/blog/#budgeting-for-your-first-salary`, `#how-to-build-an-emergency-fund`,
  `#beginners-guide-to-the-ghana-stock-exchange`) were confirmed to
  resolve to real, honest "Coming soon" blog-card placeholders already
  on `/blog/index.html` — not broken links, left as-is.
- A JSON-LD `logo` field format difference between the sitewide
  `Organization` block (plain URL string) and the Blog Article's
  `Article.publisher.logo` (an `ImageObject`) is not a bug — Google's
  Article structured-data guidelines require the `ImageObject` form
  specifically for `publisher.logo`.
- `.service-card` vs `.resource-card` — already-documented, intentional
  distinction (explicit CTA button vs. whole-card link), not accidental
  duplication.

**Technical debt identified, not fixed this sprint**
- An identical `validateField()` DOM-validation helper (~8 lines) is
  duplicated across 5 form-handling scripts (`contact-form.js`,
  `consultation-form.js`, and all 3 `calculator-*.js` files). This now
  meets the same "genuine, current, multi-consumer duplication"
  threshold that justified extracting `calculator-utils.js` in Sprint
  2 — but consolidating it means touching 5+ JS files and their
  `<script>` tags across 9+ pages for a pure-hygiene change with no
  user-facing benefit, which this audit-only sprint's "do not rewrite
  components" scope excludes. Recommended as a small, dedicated,
  low-risk extraction in a future sprint.
- Hub-level pages (`/books/`, `/blog/`, `/calculators/`, `/services/`,
  `/resources/`, `/about/`) have no breadcrumb, while other top-level
  nav destinations added since Sprint 3 (`/consultation/`,
  `/goal-planner/`, `/learn/`) do. Not fixed — low UX value for
  restating "Home → X" on a primary nav destination, and retrofitting
  6 pages with a new UI element reads as feature work, not a fix.

## [v1.1 Sprint 5] — 2026-07-05 — Learning Hub

The fifth production feature of Version 1.1, built on the frozen
architecture — no folders renamed, no components replaced, no design
tokens changed, no framework introduced. A pure discovery/directory
page: it organizes every book, article, calculator, resource, service,
Goal Planner goal, and consultation link already on the site by topic
and by learning path — it adds zero new educational content of its
own.

**Added — page**
- `/learn/` — hero, an intro line stating the page organizes rather
  than duplicates content, "Featured Learning Paths" (5 paths — Start
  Investing, Build an Emergency Fund, Become Debt Free, Plan for
  Retirement, Build Business Capital — each recommending only the
  categories with a genuine match; "Become Debt Free" has no article
  or calculator today, so those categories are simply omitted rather
  than forced), 6 topic sections (Financial Basics, Investing,
  Business Finance, Retirement, Emergency Funds, Goal Planning), a
  "Browse everything" list guaranteeing all 7 required content
  categories are reachable regardless of path/topic coverage, FAQ (6
  Q&As), newsletter CTA.
- Reuses `.resource-card` (topic-section cards, exactly as built for
  `/calculators/`, `/consultation/`'s categories, and the Goal
  Planner's goal grid), `.toc` (path recommendation lists, exactly as
  built for every page's "Keep exploring" section), and `.badge`
  (content-type labels, exactly as built for `/resources/`). **Zero new
  CSS, zero new JavaScript** — the page is fully static HTML.

**Added — reusable enhancement**
- `js/components/goal-planner.js` — now reads `?goal=<slug>` from the
  URL and jumps straight to that goal's questions on load, mirroring
  `consultation-form.js`'s existing `?category=` support. This is what
  makes the Learning Hub's Goal Planner recommendations land on the
  right goal instead of the generic selection screen.

**Changed — cross-links**
- `partials/header.html` — added "Learn" to primary nav (8 items).
- `sitemap.xml` — 1 new `<url>` entry, `lastmod` 2026-07-05.

**Fixed — nav breakpoint**
- `css/components.css` / `js/components/nav.js` — the mobile-nav
  breakpoint widened from 999px to 1199px (both files, kept in sync as
  established in Sprint 2). With 8 nav items the desktop bar's measured
  natural width is ~1099px, no longer fitting the 1000–1199px range;
  1199px reuses the breakpoint value already defined for
  `.grid--2`/`.grid--3` rather than introducing a new one. Verified: no
  overflow and correct hamburger/desktop-nav switch at 1000, 1199,
  1200, 1280, 1366px.

**SEO**
- Unique title/meta description/canonical/OG/Twitter tags.
- `Organization`, `BreadcrumbList` (Home → Learning Hub), `WebPage`,
  and `FAQPage` (6 Q&As matching the visible accordion exactly)
  JSON-LD.

**Future search strategy**
- Every topic-section `.resource-card` already carries `data-category`
  and `data-title` — the exact attribute contract
  `js/components/content-filters.js` (built in Sprint 5 of the
  original site, reused unmodified across Books/Blog/Resources) reads.
  Adding search/filtering later means adding the filter-pill toolbar
  and a `[data-filter-search]` input to the markup, wrapping the
  existing cards in a `[data-filter-grid]` container, and including
  the already-existing script — no restructuring, no new JS logic.

**Verified**
- Zero console errors, zero duplicate IDs, zero horizontal overflow
  (320–1440px, all 27 pages including this one and the new 1199/1200px
  breakpoint boundary).
- All 23 unique internal link targets on the page resolve (200, not
  404), including the 5 `/resources/#anchor` fragments (confirmed the
  target IDs exist).
- `?goal=` deep-linking from a Learning Path recommendation verified
  live (lands directly on the correct goal's questions).
- No external libraries, no backend, no new JavaScript beyond the
  2-line `?goal=` addition — 100% static, GitHub Pages compatible.

## [v1.1 Sprint 4] — 2026-07-05 — Financial Goal Planner

The fourth production feature of Version 1.1, built on the frozen
architecture — no folders renamed, no components replaced, no design
tokens changed, no framework introduced. An educational recommendation
engine, not artificial intelligence and not financial advice: a
visitor picks one of 8 goals, answers 3–5 structured questions, and
gets a suggested monthly savings figure plus the calculator(s),
service(s), article, and resources relevant to that goal.

**Added — page**
- `/goal-planner/` — a single page with 3 progressive steps (goal
  selection, structured questions, recommendation), all client-side —
  only `[data-step]` visibility changes, no page navigation, matching
  the site's existing routing. Supports Emergency Fund, Buy a Car, Buy
  Land, Build a House, Children's Education, Retirement, First
  Investment, and Business Capital.

**Added — content**
- `content/goal-planner/{slug}.json` × 8 — one config file per goal:
  its question set, how to derive a target amount and timeframe from
  the answers (`"direct"` or a small closed set of `"computed"`
  operations — `multiply` for Emergency Fund, `subtract` for
  Retirement — never a formula string or `eval()`), and which
  calculator(s)/service(s)/article to recommend. This is the site's
  **second genuine live `fetch()` consumer** after
  `content/founder/bio.json` — every other content type either has no
  consumer yet (`content/services/`, `content/calculators/`) or writes
  its real content directly in HTML. See `content/goal-planner/README.md`
  for why this one is different.
- `content/goal-planner/README.md`, `content/SCHEMA.md` (`Goal Planner
  Config` entry), `content/README.md` — documented.

**Added — script**
- `js/components/goal-planner.js` — a single, generic, data-driven
  engine: renders each goal's question form from its JSON, resolves
  `targetAmount`/`years` via the structured-operation rules above, then
  calls `window.RobayerCalc.requiredContribution()` — the exact
  function `js/components/calculator-savings-goal.js` already uses —
  for the suggested monthly figure. **No formula is duplicated.**
  Handles the "already on track" case (reusing the same honest-message
  pattern as the Savings Goal calculator) and a cross-field validation
  error (e.g. Retirement's target age must exceed current age),
  focusing the error for screen readers. Relevant calculator/service
  titles and hrefs are resolved via a small hardcoded lookup table
  (mirroring `consultation-form.js`'s category `<select>`), not a
  second fetch of `content/services/`/`content/calculators/`.
- `js/components/consultation-form.js` — now reads `?category=` from
  the URL and pre-selects the matching category option if present, so
  a Goal Planner recommendation's consultation link arrives with the
  right category already chosen.

**Added — CSS**
- `css/components.css` — `button.resource-card` (native button-chrome
  reset so the 8 goal-selection cards can reuse `.resource-card`'s
  exact box styling as an in-page action, not navigation),
  `.resource-card[aria-pressed="true"]` (selected-goal indicator),
  `.goal-planner__questions` (2-column question grid on wider
  screens).

**Changed — cross-links**
- `partials/header.html` — added "Goal Planner" to primary nav
  (7 items; re-verified no overflow at the existing 999px breakpoint).
- `resources/index.html` — one sentence pointing readers unsure which
  calculator fits toward the Goal Planner.
- `sitemap.xml` — 1 new `<url>` entry, `lastmod` 2026-07-05.

**SEO**
- Unique title/meta description/canonical/OG/Twitter tags.
- `Organization`, `BreadcrumbList` (Home → Goal Planner), `WebPage`,
  and `FAQPage` (8 Q&As matching the visible accordion exactly)
  JSON-LD.

**Accessibility**
- All 8 goal cards are native `<button>` elements (keyboard-operable
  by default, `aria-pressed` reflects selection).
- All question fields use the existing `.field`/`.field__error`
  pattern; invalid submit moves focus to the first invalid field.
- Step transitions move focus to the new step's heading (or the first
  goal button when returning to selection) so screen reader users
  aren't left on a stale, hidden element.
- Heading hierarchy verified: H1 → H2 "Plan your goal" → H3 per step,
  no skipped levels.

**Verified**
- All 8 goal paths tested: 3 walked end-to-end through the full UI
  (Emergency Fund's `multiply` computation, Retirement's `subtract`
  computation plus its invalid-age edge case, Buy a Car's "already on
  track" case), the remaining 5 verified via their fetched JSON
  matching the same, already-proven `"direct"` code path.
- Formula reuse confirmed: every goal's suggested monthly figure calls
  `RobayerCalc.requiredContribution()`, never a reimplementation.
- Fetch-failure fallback shows an honest error, not fake data.
- Zero console errors, zero horizontal overflow (320–1440px, all 26
  pages including this one), zero duplicate IDs, zero missing `alt`
  attributes, dark mode checked visually.
- No external libraries, no backend, no AI, no APIs — 100%
  client-side, GitHub Pages compatible.

## [v1.1 Sprint 3] — 2026-07-05 — Consultation Platform

The third production feature of Version 1.1, built on the frozen
architecture — no folders renamed, no components replaced, no design
tokens changed. This sprint deliberately does not implement the
Financial Goal Planner, booking/scheduling, or authentication — see
"Recommendations for Sprint 4" in this sprint's delivery notes.

**Added — page**
- `/consultation/` — a single consolidated page (not a hub + detail
  pattern, since there's one request workflow, not multiple sub-pages):
  hero, "What happens during a consultation" (reuses `.toc`), "Who
  should book," "Available consultation categories" (the same 6
  services, same icons/titles — not a second, drifting copy of them),
  "Expected preparation," FAQ, a professional disclaimer, the
  consultation request form, and the standard "Keep exploring" +
  newsletter-CTA closing pattern every other page uses.

**Added — form**
- `js/components/consultation-form.js` — client-side validation for
  Name, Email, Country, Category, Description, Preferred Contact
  Method, and Consent (Phone is optional, matching the existing
  `contact-form.js` convention). On valid submit, swaps the form for an
  honest confirmation — explicitly **not** a booking confirmation:
  states plainly that requests are reviewed manually, there is no live
  calendar, and a response should be expected within 2–3 business days.
  Reuses the exact `[data-content-href="contact.emails.general.href"]`
  fallback-email pattern already established by `contact-form.js`,
  rather than a second hardcoded email address.
- A new `.field--checkbox` variant (added in Sprint 2 for the
  Investment Growth calculator's inflation toggle) is reused here for
  the required consent checkbox — no new CSS needed.

**Changed — repointed CTAs**
- Every existing "Book a Consultation" button — 2 each on the 6
  service detail pages and the Services hub, 1 each on the 3 calculator
  pages and the Calculators hub (18 links total) — now points to
  `/consultation/` instead of `/contact/`. These were always meant to
  land here eventually; Sprint 1's own CHANGELOG entry said so
  explicitly ("the CTA links to the existing contact page" as a
  temporary measure "for now").
- `content/services/*.json` and `content/calculators/*.json` —
  `ctaHref` updated from `/contact/` to `/consultation/` in all 9
  files, keeping the structured record accurate. `content/SCHEMA.md`'s
  two documentation examples updated to match.
- `content/services/README.md` and `content/README.md` — corrected: an
  earlier note speculated the Consultation Module would fetch
  `content/services/*.json` for its category dropdown. In practice the
  dropdown is hardcoded directly in the consultation page's HTML,
  consistent with how every other page on this site works, so that
  speculative fetch never happened — the docs now say so plainly
  rather than leaving a stale prediction in place.
- `contact/index.html` — added a one-line cross-link near the top
  pointing consultation-seekers to `/consultation/`, so the general
  contact form and the dedicated consultation request form aren't
  confused with each other.
- `sitemap.xml` — 1 new `<url>` entry, `lastmod` 2026-07-05.

**SEO**
- `Organization`, `BreadcrumbList` (Home → Consultation), `WebPage`,
  `Service` (`serviceType: "Financial Consultation"`), and `FAQPage`
  JSON-LD, matching the visible page content exactly.

**Accessibility**
- All fields use the existing `.field`/`.field__error` pattern; an
  invalid submit moves focus to the first invalid field, including the
  consent checkbox.
- The consent checkbox uses `.field--checkbox` (native
  `<input type="checkbox">`, already keyboard-operable and covered by
  the global `:focus-visible` rule).
- Heading hierarchy verified: single H1 → H2 sections, no skipped
  levels.

**Fixed**
- `css/components.css` — `.field` (the grid item wrapping each form
  control) now has `min-width: 0`. Without it, a sitewide overflow
  sweep found the consultation form's "Preferred consultation category"
  `<select>` (long option text like "Financial Literacy Workshops")
  forced its parent grid track to 276px on a 320px viewport — a
  five-pixel horizontal overflow. A `<select>`'s native minimum-width
  is driven by its longest option text and isn't reduced by
  text-wrapping CSS the way plain text is; the real fix is on the grid
  item itself (`.field`), not the `<select>` (`.field__select`), since
  a CSS Grid item's automatic minimum size is based on its own
  min-content unless overridden. This benefits every current and
  future 2-column form field, not just this one select.

**Verified**
- Zero console errors, zero broken links, zero duplicate IDs, zero
  missing `alt` attributes, zero horizontal overflow at
  320/375/768/1024/1280/1440px across all 25 pages (re-swept after the
  `.field` fix above to confirm no regression elsewhere).
- Consent checkbox validation and the manual-review confirmation
  message verified live in-browser (invalid submit → focus moves to
  first invalid field; valid submit → form replaced with the honest,
  non-booking confirmation).
- All 5 JSON-LD blocks (`Organization`, `BreadcrumbList`, `WebPage`,
  `Service`, `FAQPage`) re-validated as parseable JSON after the
  consent-field HTML restructure.
- No external libraries, no backend, no booking system, no calendar
  integration, no authentication — the confirmation state is 100%
  client-side, matching `contact-form.js`'s and `newsletter-form.js`'s
  existing honesty-first pattern exactly.

## [v1.1 Sprint 2] — 2026-07-05 — Financial Calculators Platform

The second production feature of Version 1.1, built on the frozen
architecture — no folders renamed, no components replaced, no design
tokens changed. Sprint 3 will cover the Financial Goal Planner;
consultation booking and authentication remain explicitly out of scope
(see the Version 1.1 PRD).

**Added — pages**
- `/calculators/` — new landing page listing all three calculators.
- `/calculators/compound-interest/`, `/calculators/savings-goal/`,
  `/calculators/investment-growth/` — three new calculator pages,
  each with: interactive calculator, educational explanation, formula
  explanation, interpretation of results, common mistakes, FAQ,
  related resources/services/articles, consultation CTA, newsletter
  CTA. Deliberately **not** placed under `/resources/` — a dedicated
  top-level section per this sprint's explicit requirement.

**Added — shared math (no formula duplication)**
- `js/components/calculator-utils.js` — pure functions
  (`futureValueWithContributions`, `requiredContribution`,
  `realValue`, `yearlyBreakdown`, `formatCurrency`,
  `parseNumberInput`), exposed as `window.RobayerCalc`. Extracted
  because Compound Interest, Savings Goal, and Investment Growth all
  genuinely share the same future-value-of-a-lump-sum-plus-annuity
  formula (Savings Goal solves it for the contribution instead of the
  future value) — a real, present duplication risk across 3
  simultaneous consumers, not a speculative one. Every formula was
  numerically verified against independent reference values before
  any calculator was built (see "Formula validation" in this sprint's
  delivery notes).
- `js/components/calculator-compound-interest.js`,
  `calculator-savings-goal.js`, `calculator-investment-growth.js` —
  one script per calculator, each independently reusable (none
  references another calculator's script), each depending only on the
  shared `calculator-utils.js`. Explicit "Calculate" submit rather than
  live-as-you-type, so the `aria-live` result region announces once
  per deliberate calculation instead of on every keystroke.

**Added — content architecture**
- `content/calculators/README.md` + one `{slug}.json` per calculator —
  metadata and educational copy only (title, summary, explanations,
  common mistakes, FAQ, cross-links). **No formula or calculation
  logic lives in these files** — see the README for why (formulas are
  executable logic, not content; putting them in JSON would either
  duplicate them or require `eval()`-ing a string, neither of which
  this project has reason to do).
- `content/SCHEMA.md` — new `Calculator` entry.

**Added — CSS**
- `.calculator-panel`, `.calculator-result` (+ `__label`, `__figure`,
  `__row`), `.calculator-table`, and a `.field--checkbox` variant (for
  the Investment Growth inflation toggle) in `css/components.css` —
  all built from existing tokens, no new colors/radii/shadows.

**Changed**
- `partials/header.html` — added a "Calculators" link to the primary
  nav (Books, Blog, Resources, **Calculators**, Services, About).
- `css/components.css` / `js/components/nav.js` — the mobile-nav
  breakpoint widened from `max-width: 767px` to `999px` (both the CSS
  media query and the matching JS resize-listener constant). With 6
  nav items plus the theme toggle and CTA button, the horizontal nav
  measured ~940–990px at its natural width and genuinely no longer fit
  in the 768–999px tablet range — verified by measuring, not guessing.
  Desktop nav still shows correctly at 1000px+; hamburger now covers
  0–999px instead of 0–767px.
- `resources/index.html` — the "Financial calculators" section's intro
  copy updated to honestly reflect that Compound Interest, Savings
  Goal, and Investment Growth are now live at `/calculators/`, while
  its own 3 distinct "coming soon" cards (Treasury Bills, Net Worth,
  Retirement Planning Guide — none of which duplicate the 3 built this
  sprint) remain honestly upcoming.
- `index.html` — the homepage's "Savings goal" resource card (already
  labeled with a "Calculator" badge) now links to
  `/calculators/savings-goal/` instead of the generic `/resources/`.
- All 6 `/services/{slug}/` pages and their `content/services/*.json`
  — the "Related > Calculators" subsection, previously an honest
  "in development" placeholder (Sprint 1), now links to whichever of
  the 3 real calculators is topically relevant; `relatedCalculators`
  arrays updated from `[]` to real slugs — exactly the update Sprint
  1's CHANGELOG entry already flagged as due once calculators shipped.
- `sitemap.xml` — 4 new `<url>` entries, `lastmod` 2026-07-05.

**SEO**
- Every calculator page: unique title/description/canonical/OG/
  Twitter, `Organization` JSON-LD, `BreadcrumbList` JSON-LD,
  `SoftwareApplication` JSON-LD (`applicationCategory: FinanceApplication`,
  `offers.price: "0"` — schema.org has no literal "Calculator" type),
  and a matching `FAQPage` JSON-LD block.

**Accessibility**
- Results render in a `role="status" aria-live="polite"` region,
  updated only on explicit form submit (not on every keystroke) to
  avoid announcement spam.
- All form controls are native `<input>`/`<select>`/`<button>`/
  `<input type="checkbox">` — no custom widgets, so keyboard operation
  and focus states are correct by construction.
- Client-side validation reuses the existing `.field`/`.field__error`
  pattern; an invalid submit moves focus to the first invalid field.

**Verified**
- Every formula numerically checked against independent reference
  values, including a well-known textbook figure ($100/month, 30
  years, 7% → $121,997) and hand-computed edge cases (zero rate, zero
  years, an "already on track" negative-contribution case).
- Zero console errors, zero broken links, zero duplicate IDs, zero
  missing `alt` attributes, across all 24 real pages.
- Zero horizontal overflow at 320/375/768/1000/1024/1366/1440/1920px
  across all 24 pages (the nav breakpoint fix above was required to
  achieve this at 768–999px).
- No external libraries, no backend, no API calls — every calculation
  runs entirely client-side.

## [v1.1 Sprint 1] — 2026-07-05 — Services Platform

The first production feature of Version 1.1 (see the Version 1.1 PRD
and its 1.1.1 addendum), built entirely on the frozen v1.0.1
architecture — no folders renamed, no components replaced, no design
tokens changed, no framework introduced. Sprint 2 will cover Financial
Calculators; this sprint does not touch calculators, consultations
booking, or pricing.

**Added — pages**
- `/services/` — new landing page listing all six services as
  `.service-card` entries (icon, title, summary, audience, "Learn
  More"), reusing the existing `.resource-card`-style shadow/radius
  language via a new sibling component.
- `/services/{slug}/` — six new detail pages (Financial Education,
  Investment Education, Personal Financial Coaching, Business
  Financial Advisory, Retirement Planning Guidance, Financial Literacy
  Workshops), each following the exact section pattern already
  established by `books/starting-to-invest-with-gh100/index.html`:
  breadcrumb, hero, overview, who-it's-for, what-you'll-learn,
  how-it-works (reusing `.toc`, already documented as reusable for any
  staged sequence), FAQ, related content, consultation CTA, newsletter
  CTA.
- Every service page includes a compliance-note `alert` stating
  Robayer WealthLab provides financial education/coaching, not
  licensed investment, tax, legal, or accounting advice — worded per
  service, matching the disclaimer language already used on Book
  Detail and the Disclaimer page rather than inventing new legal text.

**Added — content architecture**
- `content/services/README.md` + one `{slug}.json` per service (6
  files) — the structured record of each service's overview, audience,
  process, FAQ, and cross-links. Not fetched by any page this sprint
  (the six pages render their real content directly in HTML, matching
  every other real page on the site); exists now because the future
  Consultation Module's service-select dropdown needs exactly this
  data, per the Version 1.1 PRD's Data Architecture section.
- `content/SCHEMA.md` — new `Service` entry documenting the schema.
- Every service's `pricing` field is `{ "display": "Contact for
  pricing", "amount": null }` — no price is stated or implied anywhere
  in this sprint, on any page or JSON-LD block.
- `relatedCalculators` is an empty array in every service record — no
  calculator exists yet (Sprint 2). Pages link honestly to the
  Resources page's existing "Coming soon" calculators section instead
  of a fabricated or dead link.

**Added — CSS**
- `.service-card` (+ `__icon`, `__title`, `__summary`, `__audience`,
  `__audience-label`, `__cta`) in `css/components.css` — same
  `shadow-1` → `shadow-2` rest/hover pattern as `.card`/`.testimonial`/
  `.book-card`/`.resource-card`, same tokens, no new colors or radii.

**Changed**
- `partials/header.html` — added a "Services" link to the primary nav
  (Books, Blog, Resources, **Services**, About), the same list-item
  markup as every existing link. Verified no overflow at 768/1366/
  1440px.
- `index.html` — the homepage's existing "Financial Education" and
  "Business Advisory" teaser cards (Sprint 14) now link to
  `/services/financial-education/` and
  `/services/business-financial-advisory/` respectively, instead of
  the generic `/resources/` and `/contact/` they pointed at before a
  real destination existed. The other four teaser cards are unchanged
  — their topics don't map 1:1 onto a new service page, and pointing
  them at one would misrepresent what the card is about.
- `sitemap.xml` — 7 new `<url>` entries (`/services/` + six detail
  pages), `lastmod` 2026-07-05.

**SEO**
- Every page: unique `<title>`/meta description/canonical/Open Graph/
  Twitter Card, `Organization` JSON-LD (site-wide standard),
  `BreadcrumbList` JSON-LD (first real, visible breadcrumb usage on
  the site beyond Book Detail), a `Service` JSON-LD block per detail
  page, and a matching `FAQPage` JSON-LD block per page's visible FAQ
  accordion.

**Accessibility**
- Breadcrumb nav uses the existing `.breadcrumbs` component and
  `aria-label="Breadcrumb"` pattern already defined in `components.css`.
- FAQ accordions reuse the native `<details>`/`<summary>` `.faq__item`
  pattern (keyboard-operable, no ARIA required).
- Heading hierarchy on every new page: single H1 → H2 sections → H3
  subsections (Overview/Who it's for/etc., and the "Keep exploring"
  sub-blocks) — verified with no skipped levels.

**Verified**
- Zero console errors, zero broken internal links, zero duplicate IDs,
  zero missing `alt` attributes, across all 7 new pages plus the two
  homepage cards changed.
- Responsive at 320/375/768/1024/1366/1440/1920px — no overflow.
- No new libraries, no new render-blocking assets — same font/script
  payload as v1.0.1.

## [v1.0.1] — 2026-07-05 — Launch Polish Release

A UI/UX refinement pass on top of the frozen `v1.0.0-production-baseline`
architecture — no new pages, no restructuring, no new frameworks, no
routing/navigation changes. Every change below is copy or CSS on top of
existing markup and existing design tokens.

**Hero copy (`index.html`)**
- Headline changed from the generic "Build Wealth With Confidence" to
  "Practical Financial Education. Real Wealth, Honestly Built." — names
  financial education and wealth-building explicitly, and signals trust
  through "honestly" rather than an unverifiable claim, consistent with
  the site's existing "no hype" positioning (Trust section, founder bio).
- Subtitle rewritten to "Clear, honest guidance on saving, investing,
  and growing money — no hype, no jargon, just practical steps for
  wherever you're starting from," echoing language already established
  in the Trust section ("No hype, ever") and the site-wide pull-quote
  ("wherever you're starting from, we'll meet you there") rather than
  inventing new brand language.
- CTA labels changed from generic "Get Started"/"Contact Us" to
  "Explore Free Resources"/"Get in Touch" — same `href`s
  (`/resources/`, `/contact/`), wording only. "Explore Free Resources"
  states the actual destination and leads with "Free," a true,
  concrete conversion lever already accurate today.
- This is page copy only, not wired to `assets/config/site.json` (the
  hero subtitle never was) — no config/data-content architecture
  touched.

**Portrait presentation (`css/components.css`, `index.html`)**
- New `.portrait-frame` class (additive — layered on the existing
  `rounded-lg`/`aspect-4-5`/`img-cover` utility classes, nothing
  removed) adds a thin Sika Gold hairline plus `--shadow-3` to both the
  hero portrait and the "Meet the Founder" portrait, giving the real
  founder photo (unchanged, not replaced) a more deliberate, premium
  frame instead of sitting flush against the page background.

**Buttons (`css/components.css`)**
- `.btn:hover` now lifts 1px with a `--shadow-2` elevation, in addition
  to the existing background-color change — a subtle, motion-respecting
  micro-interaction (still subject to the site's global
  `prefers-reduced-motion` rule in `base.css`).
- `.btn:focus-visible` gets a soft color-matched glow (`.btn--accent`
  gets its own gold-tinted version) layered on top of — not replacing —
  the existing global `:focus-visible` outline from `base.css`, so
  keyboard focus stays at least as visible as before.
- `.btn:disabled`/`.btn--disabled` explicitly reset `transform`/
  `box-shadow` so the new hover/active motion never applies to a
  disabled button.

**Cards and testimonials (`css/components.css`)**
- `.resource-card` (already an `<a>` link) keeps and is joined by a new
  `.resource-card__icon` hover scale (1.08×) — reinforces that these
  cards are clickable.
- Considered adding the same hover "lift" to `.card` and `.testimonial`,
  but both are used site-wide as static, non-interactive containers
  (contact-method cards, community values, testimonial quotes — none
  wrapped in `<a>`). A lift affordance on a non-clickable element is a
  known UX anti-pattern (implies interactivity that isn't there), so
  only a shadow-depth change was added to `.testimonial` (matching
  `.card`'s pre-existing shadow-only hover) — no transform on either.

**Trust section** — reviewed against the brief's suggested card set
("Practical Financial Education," "Ghana-Focused Insights," etc.), but
the existing Trust section (Founder-led / No hype, ever / Ghana-first /
Free to start) already covers the same credibility ground in the site's
own established voice, immediately above a Services section with
near-identical grid styling. Adding a third, near-duplicate card grid
between them would add clutter rather than calm, so the existing
section was left structurally as-is.

**Verified after the above changes**
- Zero console errors, zero failed network requests, zero duplicate
  IDs, zero missing `alt` attributes, zero horizontal overflow at
  320/375/768/1024/1440/1920px on the homepage.
- Heading hierarchy unchanged and valid (single H1 → H2 sections → H3
  Trust-card headings).
- No new fonts, scripts, or libraries added — same font/script payload
  as the baseline.

### UI Polish Pass (closes out v1.0.1) — 2026-07-05

A sitewide visual-consistency audit on top of the changes above — no new
sections, no layout changes, no routing changes. Read every real page's
CSS/HTML looking specifically for shadow/radius/spacing/icon
inconsistencies; changed only the handful that were genuinely
inconsistent, left everything else untouched (most of the existing
design system was already consistent — see "audited, no change needed"
below).

**Navigation (`css/components.css`)**
- `.nav__list a[aria-current="page"]` previously signaled the active
  page with color alone (green text + green underline) — a WCAG 1.4.1
  ("use of color") gap, since two dark, similarly-saturated colors
  (ink navy vs. growth green) are hard to tell apart for some users.
  Added `font-weight: var(--weight-semibold)`, so the active link is
  now distinguishable by weight and underline, not color alone.
- `.nav__list a` padding-bottom increased from 2px to `var(--space-2)`
  (8px) so the active-page underline sits with proper breathing room
  below the text instead of crowding it. Verified this doesn't change
  `.site-header`'s fixed 88px height (nav content is flex-centered
  within it) and doesn't affect the separate mobile-menu override,
  which already sets its own padding.

**Card shadow consistency (`css/components.css`)**
- `.resource-card` (used for the Home Services/Free-Resources sections
  and the Resources page) had no `box-shadow` at rest — every sibling
  card component (`.card`, `.testimonial`, `.book-card`) already used
  a `--shadow-1` (rest) → `--shadow-2` (hover) pattern. Added
  `box-shadow: var(--shadow-1)` to `.resource-card` so all card-like
  components now share one consistent shadow language; its extra hover
  lift/icon-scale stays, since unlike `.card`/`.testimonial` it's
  always an `<a>` link.

**Heading spacing (`index.html`)**
- The Home Trust section's `<h2 id="trust-heading">` was missing the
  `mt-2` top margin that every other section heading on the site uses
  after its eyebrow label (confirmed by checking all ~25 section
  headings across every page — this was the one outlier). Added
  `mt-2` to match.

**Audited, no change needed** (confirmed rather than assumed):
- Section vertical rhythm — every Home section already uses the same
  64px top/bottom padding via `.section`, with only the hero (96px,
  intentionally larger) and the newsletter band (`.section--tight`,
  32px, intentionally smaller) differing — both deliberate, not
  oversights.
- Hover-transition timing — already `--duration-base` (200ms)
  everywhere across buttons, cards, nav, filter pills, footer icons;
  `--duration-fast` (150ms) is reserved for the button press-down
  scale and `--duration-slow` (300ms) for scroll-reveal — a considered
  system, not an inconsistency.
- `scroll-behavior: smooth` (already in `base.css`, already correctly
  disabled under `prefers-reduced-motion`) — the "smooth scroll" ask
  was already implemented; confirmed rather than re-added.
- Icon sizing — `.icon`/`.icon--lg` (20px/24px) used consistently for
  every card/list icon sitewide, including the newer resource-card
  icons; `.check-item__icon` alignment already has a deliberate 2px
  top-nudge to match text baselines.
- Focus treatment — the global `:focus-visible` outline in `base.css`
  already applies uniformly to every interactive element (nav, forms,
  buttons, filter pills, footer/social links); no element was found
  bypassing it.
- Considered a JS-driven image fade-in-on-load ("image loading
  transitions"). Every real `<img>` already has explicit `width`/
  `height` (no layout shift) and appropriate `loading="eager"`/`"lazy"`
  plus `decoding="async"`. Adding a fade requires new JS (a load-event
  listener), which is more than a CSS/copy polish pass should introduce
  for a cosmetic-only gain — left out, noted here rather than silently
  skipped.
- Dark mode — spot-checked the nav and card changes above under
  `[data-theme="dark"]`; both degrade correctly (the active-nav-link
  font-weight signal still works even where a pre-existing, unrelated
  cascade rule already overrides active-link color to white in dark
  mode — a pre-existing quirk, not something this pass introduced or
  worsened).

**Verified after this pass**
- Zero console errors, zero failed network requests, zero duplicate
  IDs, zero missing `alt`/broken images, zero horizontal overflow —
  across all 13 real pages at 1366px and 1440px (the two most common
  laptop widths) in addition to the mobile/tablet/desktop/ultrawide
  breakpoints already checked for v1.0.1 above.
- No new HTTP requests, fonts, scripts, or libraries — this pass only
  edited existing `css/components.css` rules and one `index.html`
  class attribute, so Lighthouse Performance exposure is unchanged.

## [v1.0.0-production-baseline] — 2026-07-05

Closes out Phases 1–18. Everything below this heading (Sprint 1 through
Sprint 18) is the full, unmodified history that makes up this baseline
— nothing was rewritten to produce it. This entry itself only records
the finalization pass done on top of Sprint 18's audit before tagging:

- **Working tree review:** every uncommitted change from Phases 15–18
  reviewed file-by-file against this changelog's own sprint history;
  confirmed all of it intentional (no accidental edits, no leftover
  debug code, no stray temp/test files). The `console.error(error)`
  calls in `js/content-inject.js` and `js/components/founder-bio.js`
  are deliberate fetch-failure logging, not debug leftovers — left in
  place.
- **Sitemap consistency:** `sitemap.xml` `<lastmod>` brought to
  `2026-07-05` uniformly across all 12 real routes, since every page
  received at least a script-tag or JSON-LD change during Phases 15–18
  (previously a mix of 07-01–07-05 depending on when each page was last
  touched).
- **Stale changelog note closed out:** Sprint 1.5's "Known issue" about
  the newsletter form's error message showing on page load was
  re-tested and confirmed already fixed (a `.field__error[hidden]`
  override exists in `components.css`) — annotated in place rather than
  deleted, so the history stays honest about when it was actually
  fixed.
- **Final verification, re-run clean:** zero console errors, zero
  failed network requests, zero broken internal links (12/12 resolve),
  zero missing assets (25/25 referenced images/scripts/stylesheets/JSON
  resolve), zero duplicate IDs, zero missing `alt` attributes — across
  all 13 real pages. Confirmed no `package.json`/build tooling/
  server-side includes exist; `CNAME` and `robots.txt` both point at
  the correct production domain.
- **No functional or visual changes in this entry** — this is a
  checkpoint/tagging pass on top of Sprint 18's audit, not new work.

### Sprint 18 — Production Readiness Audit — 2026-07-05

A full sitewide audit across branding, SEO, accessibility, performance,
responsiveness, contact consistency, forms, links, images, dead code,
and GitHub Pages compatibility — no visual redesign, no new features,
fixes only for genuine issues found. See the full Production Readiness
Report in the project record for the complete findings/fixes/remaining-
recommendations breakdown; summary below.

**Fixed — stale references from prior phases**
- `books/starting-to-invest-with-gh100/index.html`,
  `blog/what-are-treasury-bills-in-ghana/index.html`: `Book`/`Article`
  JSON-LD `image` fields (and the article's publisher `logo` field)
  still pointed at the old placeholder paths retired in Sprint 17's
  sitewide OG-image migration — missed because they're schema
  sub-fields, not the top-level `Organization` block. Updated to the
  real `assets/branding/` asset paths.
- `legal/terms-of-use/`, `legal/privacy-policy/`, `legal/disclaimer/`:
  the "reach us at hello@robayerwealthlab.com" sentence in each was
  still hardcoded instead of wired to `assets/config/site.json` like
  every other contact reference sitewide — added the matching
  `data-content`/`data-content-href` attributes.
- `js/components/contact-form.js`: the post-submit confirmation
  message hardcoded the support email instead of reading the
  already-populated `[data-content-href="contact.emails.general.href"]`
  element, so it would have silently gone stale the next time the
  contact email changed. Now reads it from the DOM at submit time.

**Fixed — fabricated content presented as real**
- `blog/index.html` (7 cards), `books/index.html` +
  `books/starting-to-invest-with-gh100/index.html` (1 card each),
  `blog/what-are-treasury-bills-in-ghana/index.html`'s "Related
  articles" (3 cards): these linked to blog articles/a book that don't
  exist yet, with fabricated publish dates, reading times, and a fake
  price — inconsistent with the site's honesty-first tone. Converted
  all 9 instances to the existing `.resource-card--upcoming` "Coming
  soon" convention, extended with new `.blog-card--upcoming` /
  `.book-card--upcoming` CSS, linking to `/newsletter/` instead of a
  dead page.

**Fixed — SEO**
- `index.html`: homepage meta description trimmed from 175 to 159
  characters (was truncating in search results); `og:description`/
  `twitter:description` were already correctly sized and untouched.
- `sitemap.xml`: `<lastmod>` bumped to 2026-07-05 for every page whose
  content this sprint actually changed (`/books/`,
  `/books/starting-to-invest-with-gh100/`, `/blog/`,
  `/blog/what-are-treasury-bills-in-ghana/`, all three `/legal/*`
  pages) — previously dated 07-01–07-04, no longer accurate.

**Fixed — responsive/CSS bugs**
- `css/components.css` `.check-item__text`: `overflow-wrap: break-word`
  doesn't reduce an element's min-content size (per spec, it's a
  last-resort break excluded from intrinsic sizing) — with no spaces
  in an email address, this forced the flex row's, then the card's,
  then the single-column mobile grid's min-content width to ~354px,
  overflowing the 320px viewport by 50px on `/contact/`. Changed to
  `overflow-wrap: anywhere`, which does participate in min-content
  sizing. Verified via automated overflow scan: zero horizontal
  overflow across all 13 real pages at 320/375/768/1024/1440px.
- `.nav__cta`: added `white-space: normal` on mobile so the button
  text wraps instead of forcing nav width.
- `.footer__grid`: added a 768–1199px tablet breakpoint (3 columns)
  instead of jumping straight from 1-column mobile to unconditional
  5-column, which cramped text at iPad-portrait width.

**Removed — dead code**
- `js/content-loader.js` (zero consumers — an earlier abandoned
  attempt at a shared content-fetch utility; `js/components/
  founder-bio.js`'s self-contained-fetch pattern is the reference
  implementation going forward).
- `assets/images/og-default.jpg`, `assets/images/logo/logo.svg` —
  orphaned once the JSON-LD fixes above removed their last references.
  `assets/images/logo/README.md` rewritten to document the retirement.
- Documentation (`content/README.md`, `content/founder/README.md`,
  `content/company/README.md`, `assets/branding/books/README.md`, main
  `README.md`) updated to stop referencing the deleted loader and point
  at `founder-bio.js`'s pattern instead.

**Verified clean (no changes needed)**
- Accessibility: zero duplicate IDs within any page, zero `<img>` tags
  missing an `alt` attribute, across all 13 real pages.
- Internal links: all 12 unique internal paths resolve with no 404s.
- Forms: contact form and newsletter signup both submit and render
  their confirmation state correctly.
- Console/network: zero console errors, zero failed network requests
  across every page tested.
- GitHub Pages compatibility: no `package.json`, no build tooling, no
  server-side includes — confirmed still a pure static site with a
  `CNAME` file for the custom domain.
- Two audit-agent findings were investigated and found to be false
  positives (title-tag lengths reported as 64–67 characters were
  actually 50–53 when measured directly) — not changed.

### Sprint 17 — Real Branding Integration (Logo, Founder Portrait) — 2026-07-05

Introduces the site's first real brand assets — a real logo and a real
founder portrait, both supplied this phase — using the centralized
branding architecture built in Sprint 16. No design-system, IA, or
accessibility change; every existing token/component/route is
untouched. This is **not** a "pixel-identical" phase like 15–16 — the
whole point is that the founder image slots and the header/footer
logo mark now show real photography/artwork instead of coded
placeholders. "Zero regression" here means nothing broke, not that
nothing changed.

**Added — real assets**
- `assets/branding/founder/founder-portrait.jpg` — Robert Loh Kobla's
  supplied headshot, center-cropped from its original 4:3 to the site's
  established 4:5 portrait ratio, visually verified before use (648×810,
  46KB).
- `assets/branding/logo/logo-mark.png`, `logo.png`, `logo-with-tagline.png`
  — cropped from the supplied production logo artwork (a transparent
  PNG, confirmed via pixel-alpha inspection, not a design mockup with a
  baked-in background as it first appeared to be): icon-only mark for
  nav use, full mark+wordmark lockup for JSON-LD/larger contexts, and
  the full lockup with tagline used to compose the OG image below. No
  vector source was supplied, so no `.svg` exists yet — documented as a
  known gap in `assets/branding/logo/README.md`, not silently assumed.
- `assets/branding/social/og-image.jpg` — composed by centering the
  real logo (with tagline) on the site's own Warm Paper background at
  the standard 1200×630 OG size, rather than reusing a generic
  placeholder.
- `content/founder/bio.json` — the founder's real, already-approved
  biography (short + long form), moved here verbatim from
  `about/index.html`/`index.html`'s existing hand-written copy — not
  rewritten or fabricated.

**Changed — integration**
- `partials/header.html`/`partials/footer.html`: `.nav__logo-mark`'s
  coded inline `<svg>` (three gold bars) replaced with an `<img>`
  pointing at the real `logo-mark.png` — `alt=""` (decorative; the
  adjacent `<span>` company-name text already conveys the meaning,
  matching WCAG guidance against redundant image descriptions),
  explicit `width`/`height` matching the file's real dimensions,
  `loading="eager"` in the header (always above the fold) vs.
  `loading="lazy"` in the footer (always below the fold).
- `index.html` (hero + "Meet the Founder") and `about/index.html`
  (hero): the three `<!-- Founder Image Placeholder -->` `<div>`s
  replaced with `<img>`s pointing at the real portrait — descriptive
  `alt="Robert Loh Kobla, Founder & CEO of Robayer WealthLab"`,
  explicit `width`/`height`, `loading="eager"` on the two above-the-fold
  hero placements and `loading="lazy"` on the below-the-fold "Meet the
  Founder" placement.
- `js/components/founder-bio.js` (new) — fetches
  `content/founder/bio.json` and renders `shortBio`/`longBio` into
  `[data-founder-bio="short"/"long"]` elements on `index.html`/
  `about/index.html`, with the existing hand-written text as the
  fallback if the fetch fails. Founder *name*/*title* stay owned by
  `assets/config/site.json` via `js/content-inject.js` — deliberately
  not duplicated into this file, so each fact has exactly one source.
- `assets/config/site.json`'s `branding.logo`/`branding.ogImage`/
  `seo.defaultOgImage` updated to the real asset paths; every page's
  `Organization` JSON-LD `logo` field and `og:image` meta tag updated
  to match (same identical diff applied across all ~15 pages, per the
  established pattern from Sprint 15).
- `css/utilities.css`: new `.img-cover` utility
  (`display:block; width:100%; height:100%; object-fit:cover`) so the
  new `<img>`s fill their existing `.aspect-4-5` box the same way the
  placeholder `<div>`s did, without distortion.
- `css/components.css`: `.nav__logo-mark` changed from a forced
  `24×24px` square to `width:24px; height:auto`, since the real mark's
  proportions aren't square (the old coded mark was designed to be).

**Documentation kept honest**
- `assets/branding/logo/README.md`, `founder/README.md`,
  `social/README.md` rewritten from "here's what to do when a real
  file arrives" to "here's what's actually live now, and what's still
  missing" (the SVG gap) — not left describing a step that already
  happened.
- `content/founder/README.md` and the top-level `content/README.md`
  updated to reflect that this one content type now has a real
  consumer, while every other content type remains scaffolding-only.

**Verified**
- Local static server, fresh session: zero console errors, zero failed
  network requests, on `/`, `/about/`.
- Confirmed via computed `naturalWidth`/`naturalHeight`/`complete` on
  every `<img>` that all four images (2× logo mark, 2× founder
  portrait instances checked) load successfully with no broken images.
- Confirmed `loading="lazy"` images (footer logo, homepage "Meet the
  Founder" portrait) report `complete: false` before being scrolled
  into view, confirming lazy-loading is actually deferring the request,
  not just present as a no-op attribute.
- Zero duplicate `id` attributes on `/` (14 ids) and `/about/`.
- Screenshot comparison confirms clean rendering of the real photo/logo
  at both hero and "Meet the Founder" placements, both light and (from
  Sprint 14) dark mode.
- Diagnosed and resolved a false alarm during testing: the local dev
  preview session had a stale/poisoned cache entry for one script URL
  from early, broken iterations of this same file — confirmed via a
  fresh-filename test that the final code executes correctly; not an
  issue for real visitors, who fetch the file fresh on first visit.

### Sprint 16 — Brand Asset & Content Architecture Foundation — 2026-07-05

A documentation/scaffolding-only phase — **no page HTML, CSS, or JS
behavior changed; verified pixel-identical, zero console errors, zero
duplicate IDs, zero broken links**. Builds directly on Sprint 15's
configuration layer: where that phase centralized simple facts
(company/founder/contact/social), this phase prepares the structure for
richer future content (books, articles, resources, testimonials, FAQ,
etc.) and formalizes where brand assets will eventually live — without
migrating anything or wiring any of it into a live page yet.

**Added — Brand asset management**
- `assets/branding/logo/`, `founder/`, `favicons/`, `social/`, `books/`,
  `resources/`, `team/` (new subfolders, each with its own README
  documenting expected filenames, recommended dimensions/formats/
  optimization, and current fallback behavior). No image files added
  anywhere — documentation only.
- `assets/branding/README.md` rewritten as an overview/index linking to
  each subfolder, keeping the existing "live-wired vs. static per page"
  explanation from Sprint 15 intact.
- Audited every page's `og:image` and favicon `<link>` tags — confirmed
  zero drift (100% identical across all pages), so the existing
  `assets/config/site.json` `branding` section remains the single
  accurate reference value; no code change was needed to achieve
  "one location, no duplicate paths" since nothing had drifted.

**Added — Content architecture (scaffold only, no real content)**
- `content/` — new top-level directory with `company/`, `founder/`,
  `books/`, `blog/`, `resources/`, `legal/`, `newsletter/`, `community/`,
  `events/`, `testimonials/`, `faq/` subdirectories, each with a README
  covering that content type's purpose, future file structure, and how
  content would be added once wired up. No sample/fake content files
  anywhere.
- `content/SCHEMA.md` — recommended JSON schema for Book, Blog Article,
  Resource, Team Member, Testimonial, FAQ, Newsletter Issue, and
  Community Event, each shaped to match how that content already
  looks/behaves on the live site (e.g. Blog Article's `body` field is a
  reference to the existing page, not inlined prose — long-form
  writing stays hand-written, only its repeated metadata centralizes).
- `js/content-loader.js` (new) — reusable `fetchContent`/
  `fetchContentList`/`renderInto`/`renderList` helpers with graceful
  fallback (resolve to `null`/no-op on any failure, never throw).
  **Not included via `<script>` tag on any page** — confirmed via
  search, matching the "do not implement dynamic rendering" instruction
  this phase was scoped under.

**Added — Documentation**
- `README.md`: new "Architecture overview" (the four layers: design
  system → configuration → branding → content), "Brand asset
  architecture," "Content architecture," "Future roadmap" (what a
  future local editor, Git-backed CMS, upload workflow, automated asset
  optimization, and build-time head-tag sync script would each need —
  none built), and "Developer onboarding" (a where-does-X-live table)
  sections. Renamed the existing "Configuration" section to
  "Configuration architecture" for naming consistency with the new
  sections; its content is unchanged. Folder-structure tree updated
  with the two new entries (`content/`, `js/content-loader.js`).

**Not changed, by design**
- Every page's real content, every existing page link, every design
  token, every component, the founder name, and the information
  architecture — untouched, per explicit instruction. This phase is
  additive documentation and empty-of-content scaffolding only.
- No build step was introduced. `content/` and `js/content-loader.js`
  work the same way `assets/config/site.json`/`js/content-inject.js`
  already do (plain static JSON, fetched same-origin) — GitHub Pages
  compatibility is unaffected.

**Verified**
- Local static server: zero console errors, zero failed network
  requests, homepage screenshot pixel-identical to the pre-phase state.
- Zero duplicate `id` attributes checked on `/` (10 ids) and `/contact/`
  (15 ids).
- Confirmed `js/content-loader.js` is not referenced by any page's
  `<script>` tag (grepped across the whole repo).
- Confirmed `og:image`/favicon paths remain identical across every page
  (no accidental drift introduced by this phase).

### Sprint 15 — Centralized Business-Info Configuration — 2026-07-05

A pure architecture/maintainability refactor — **no visual or content
change, verified pixel-for-pixel identical before/after**. Explicit scope
boundary for this sprint: don't touch the design system, IA, or founder
name (all reaffirmed as correct in the request that started this sprint);
instead give recurring business facts (company/founder/contact/social/
branding) a single source of truth so a future admin panel or Git-backed
CMS could edit them without touching HTML.

**Added**
- `assets/config/site.json` (new) — the single source of truth for
  company name/tagline/URL, founder name/title, the 3 contact emails,
  phone, location, and social links. `branding`/`seo` sections hold
  reference-only values for the static per-page tags (see "Not changed"
  below).
- `js/content-inject.js` (new) — fetches `site.json` once per page load
  (same fetch pattern as `js/includes.js`, same `partials:loaded`-driven
  timing as `js/components/nav.js`) and populates any
  `[data-content="dot.path"]` (textContent) or
  `[data-content-href="dot.path"]` (href) element. Fails silently on any
  fetch error — the page's existing static text is the fallback, not a
  placeholder waiting to be filled.
- `assets/branding/` (new folder + README) — where real logo/founder-
  portrait/favicon/OG-image files go once produced, with exact expected
  filenames and dimensions, and an explicit explanation of which fields
  are live-wired vs. which remain static per page and why.
- `data-content`/`data-content-href` bindings added to: `partials/header.html`
  and `partials/footer.html` (wordmark, tagline, 4 social hrefs,
  copyright company name + disclaimer, bottom-bar phone/location/
  website — covers all ~15 pages from these two shared-partial edits
  alone), `index.html`/`about/index.html` (founder name + title only —
  the surrounding biography stays as page copy, not config), and
  `contact/index.html` (the 3 email cards + the phone/website/location
  "direct details" block).
- `<script src="/js/content-inject.js"></script>` added to all ~15 pages
  plus `templates/page-template.html`, so future pages scaffolded from
  the template pick this up automatically.
- New "Configuration" section in `README.md` documenting `site.json` as
  the source of truth and pointing at `assets/branding/README.md` for
  the static-tag caveat.

**Not changed, by design**
- `<title>`, meta description, canonical URL, Open Graph/Twitter tags,
  favicon `<link>`s, and the `Organization` JSON-LD block on every page
  — these stay exactly as they were, hardcoded per page. Centralizing
  them via runtime JS would be a functional regression, not a
  maintainability win: social-share crawlers (Facebook/Twitter/
  LinkedIn link-unfurling bots) and favicon-fetching logic read the raw
  HTML response before any JavaScript executes, so a JS-injected value
  would never reach them. `site.json`'s `branding`/`seo` sections still
  document the canonical values; `assets/branding/README.md` spells out
  the manual-sync step this requires today, and notes a future
  build-time sync script (not built) as the way to remove that
  limitation entirely.
- Design tokens, component library, page structure/IA, and the founder
  name ("Robert Loh Kobla") — untouched, per explicit instruction.
  Existing `assets/icons/`/`assets/images/` files were left in place
  rather than moved into the new `assets/branding/` folder, since moving
  them would touch every page's `<head>` for no benefit.

**Verified**
- Local static server; confirmed `assets/config/site.json` fetches
  successfully and every `[data-content]`/`[data-content-href]` element
  resolves to the exact pre-existing text/href on `/`, `/contact/`, and
  `/blog/` (whose footer is only touched via the shared partial) — a
  screenshot comparison against the pre-refactor state showed zero
  visual difference.
- Temporarily changed the phone number in `site.json`, confirmed it
  updated on both the homepage/`/blog/` footer and the Contact page's
  two phone references with no HTML edits, then reverted it.
- Temporarily renamed `site.json` to simulate a fetch failure — pages
  kept showing their correct static fallback text, no `"undefined"`
  anywhere, no console error thrown — then restored the file and
  confirmed it re-fetches cleanly (200 OK).
- No console errors or failed requests on any page checked.

### Sprint 14 — Site Polish (Nav, Hero, Founder, Services, Contact, Footer, SEO, Dark Mode) — 2026-07-05

A broad polish pass across the homepage, Contact page, and shared header/
footer partials. Scope was deliberately kept inside the existing
architecture: no new pages, no palette replacement, no framework — every
addition reuses an existing component pattern (`.resource-card`,
`.hero--split`, `.field`/`.btn`, the site's placeholder convention) or
extends the semantic design-token system already in place.

**Added**
- Dark mode, sitewide: `[data-theme="dark"]` token overrides in
  `css/tokens.css`, a toggle button in `partials/header.html`, and
  `js/components/theme-toggle.js` (persists the choice to
  `localStorage`, applied on every page). Known trade-off: since there's
  no shared `<head>` partial, the stored preference is applied by JS
  after page scripts load rather than via a head-blocking inline
  script, so a returning dark-mode visitor may see a brief light-mode
  flash on navigation.
- Homepage Services section — 6 cards (Financial Education, Investment
  Insights, Budget Planning, Business Advisory, Market Research,
  Financial Tools), each linking to the closest existing destination
  page. Built on the existing `.resource-card` pattern, not a new
  component.
- Homepage hero rewrite — new headline/subhead copy, relabeled CTAs
  (Get Started / Contact Us), a `<!-- Founder Image Placeholder -->`
  block, and a decorative `.hero--gradient` background with slow-drift
  floating shapes (CSS-only, `aria-hidden`, neutralized automatically
  by the site's existing `prefers-reduced-motion` rule).
- Contact page: a real contact form (Name/Email/Phone/Message) with
  `js/components/contact-form.js` — client-side validation mirroring
  `newsletter-form.js`'s pattern, honest "not connected to a backend
  yet" confirmation on success (same honesty convention as
  `placeholder-action.js`). Also added phone/website display and a
  `<!-- Google Maps Placeholder -->` block.
- `js/components/scroll-reveal.js` + `[data-reveal]`/`.is-visible` CSS —
  a small IntersectionObserver-based fade-in, skipped entirely (content
  shown immediately) under `prefers-reduced-motion: reduce`.
- Footer: logo + one-line description band, a Services column, phone/
  website added to the bottom bar, and an explicitly-labeled social
  icon row (`<!-- Social Placeholder -->`, `href="#"`) ready to wire up
  once real accounts exist.
- `telephone` + `address` (`PostalAddress`, Accra, Ghana) fields added
  to the `Organization` JSON-LD block already repeated across all ~15
  pages — same small diff applied uniformly.

**Changed**
- Homepage "About Teaser" upgraded to "Meet the Founder" — name,
  "Founder & CEO" title, condensed bio, "Read More" button. Same
  section, same placeholder-image slot, just fuller content. The
  "Founder & CEO" label was also added next to the founder-story
  heading on `/about/` for consistency.
- Nav: added a hover color transition on nav links (there was
  previously only a static color and an active-page state, no hover
  treatment at all), and a scroll-triggered `.site-header--scrolled`
  shadow class via a small listener in `js/components/nav.js` (the
  header previously only had a static bottom border).

**Fixed**
- `.bg-paper`/`.bg-sand` utility classes (`css/utilities.css`) were
  pointing at raw palette colors instead of the semantic `--color-bg`/
  `--color-bg-alt` tokens, so dark mode initially left every section
  using them (hero, services, and others) stuck in light-mode colors
  while the rest of the page went dark. Repointed both to the semantic
  tokens — visually identical in light mode, correct in dark mode.
  `.bg-navy`/`.bg-charcoal` were left untouched since those are used
  for sections that are deliberately dark regardless of site theme.
- The mobile-nav hamburger icon's stroke color was hardcoded as
  `#16233D` inline in `partials/header.html`, so it wouldn't have
  flipped color in dark mode. Changed to `stroke="currentColor"`.

**Not changed (kept deliberately)**
- Color palette (Growth Green / Ink Navy / Sika Gold / Warm Paper) —
  kept as-is rather than replacing with the brief's literal "Deep Blue/
  White/Gold," since Ink Navy already reads as a deep blue against
  white surfaces and gold accents, and a sitewide token swap would
  re-trigger every prior contrast audit for no visual-direction change.
- Multi-page structure — new content became homepage sections/teasers
  linking to the existing, fully-built `/about/` and `/contact/` pages
  rather than replacing them.
- Founder name — "Robert Loh Kobla" kept everywhere it already
  appears (JSON-LD `founder.name`, page copy); "Founder & CEO" was
  added as a title alongside it, not a replacement.

**Verified**
- Local static-file server; clicked through homepage (hero, founder
  teaser, services, nav hover/scroll-shadow, dark-mode toggle across a
  reload) and `/contact/` (empty submit, invalid email, valid submit;
  phone/map display).
- Dark-mode background/text/border colors checked via computed styles
  after toggling, both immediately and after a page reload
  (`localStorage` persistence confirmed).
- Contact form: confirmed per-field error visibility toggling, focus
  moves to the first invalid field, and the honest confirmation message
  replaces the form on a valid submission.
- Scroll-reveal: confirmed above-the-fold content is visible
  immediately, below-the-fold content becomes visible on scroll, and a
  mocked `prefers-reduced-motion: reduce` match immediately marks
  content visible with no animation.
- JSON-LD sampled on two pages (`/` and `/about/`) — both parse as
  valid JSON and include the new `telephone` field.
- No console errors and no failed network requests on `/`, `/contact/`,
  or `/about/`.

### Sprint 13 — Disclaimer — 2026-07-04

`legal/disclaimer/index.html`, serving `/legal/disclaimer/` — the
third and final Legal page. With this sprint, **every URL currently
listed in `sitemap.xml` now resolves to a real page** (all 13 entries
have a `<lastmod>`, confirmed via `grep`). Built by directly mirroring
Privacy Policy and Terms of Use, as instructed. **Zero new CSS was
needed**; `css/` is byte-for-byte unchanged from Sprint 12.

**Added**
- `legal/disclaimer/index.html` — breadcrumb, hero (with effective/
  last-updated dates), sticky-on-desktop TOC + disclaimer body
  (Educational Purpose, No Financial Advice, Investment Risk,
  Accuracy of Information, External Links, Affiliate & Commercial
  Relationships, Limitation of Responsibility, Contact), Related
  Documents, newsletter CTA, shared footer.
- `Organization`, `WebPage`, and `BreadcrumbList` JSON-LD — same
  pattern as the other two Legal pages, no `FAQPage`.
- `<lastmod>2026-07-04</lastmod>` added to the existing
  `/legal/disclaimer/` sitemap entry — the last sitemap entry that
  didn't have one.

**Reused, not duplicated**
- The entire Privacy Policy / Terms of Use shell — `.article-layout` +
  `.article-body` + `.toc` (sticky sidebar, reading progress via
  `js/components/article-reading.js`, zero code changes),
  breadcrumbs, Related Documents' arrow-icon link pattern, newsletter
  band, and footer.
- `.alert--info` for two callouts (Accuracy of Information's "verify
  independently," Affiliate & Commercial Relationships' "we'll always
  disclose it") — same component, same honest-disclosure pattern as
  the other two Legal pages.
- Plain `<ul>` inside `.article-body` for Investment Risk's three
  points, matching Privacy Policy's approach for informational (not
  compare/contrast) enumerations — `.check-item`'s check/x split was
  intentionally *not* reused here, since this section has no "allowed
  vs. not allowed" structure the way Terms of Use's Permitted Use did.

**Content approach**
- States plainly that Robayer WealthLab is not a licensed financial
  advisory service, that investing involves risk, and that past
  performance doesn't guarantee future performance — directly
  addressing this sprint's instructions.
- Affiliate & Commercial Relationships is honest about the current
  state (no affiliate deals exist today) while committing to disclose
  any that start, consistent with how the other two Legal pages
  handle not-yet-active things.

**Verified**
- Reading-progress bar and TOC active-highlighting confirmed via
  computed style at a specific scroll position (43% progress, "No
  financial advice" correctly active).
- Sticky sidebar confirmed via computed style (`position: sticky`,
  `top: 112px`) at desktop width (1280px); single-column stacking
  confirmed at tablet (768px) and mobile (375px), with both
  `alert--info` callouts remaining fully readable at 375px.
- **All three Legal pages now cross-link correctly in every
  direction** — confirmed by clicking Disclaimer → Privacy Policy →
  Terms of Use → (implicitly) back — the first time this trio's
  Related Documents links have been fully non-broken.
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, no skipped levels.
- Zero console errors, zero failed network requests, zero duplicate
  IDs, zero inline styles, zero new/changed CSS.

### Sprint 12 — Terms of Use — 2026-07-04

`legal/terms-of-use/index.html`, serving `/legal/terms-of-use/` — the
second Legal page. Built by directly mirroring the Privacy Policy's
structure, as instructed. **Zero new CSS was needed**; `css/` is
byte-for-byte unchanged from Sprint 11.

**Added**
- `legal/terms-of-use/index.html` — breadcrumb, hero (with effective/
  last-updated dates), sticky-on-desktop TOC + terms body (Acceptance
  of Terms, Educational Purpose, Intellectual Property, Permitted Use,
  Purchases, External Links, Limitation of Liability, Changes to These
  Terms, Contact), Related Documents, newsletter CTA, shared footer.
- `Organization`, `WebPage`, and `BreadcrumbList` JSON-LD — same
  pattern as Privacy Policy, no `FAQPage` since this page has no FAQ
  section either.
- `<lastmod>2026-07-04</lastmod>` added to the existing
  `/legal/terms-of-use/` sitemap entry.

**Reused, not duplicated**
- The entire Privacy Policy shell — `.article-layout` + `.article-body`
  + `.toc` (sticky sidebar, reading progress via
  `js/components/article-reading.js` with zero code changes),
  breadcrumbs, Related Documents' arrow-icon link pattern, newsletter
  band, and footer — copied structurally, not just conceptually.
- `.check-item` (check icon + x icon, two-column `.grid--2`) for
  Permitted Use's "You may" / "You may not" split — the exact same
  pattern as Book Detail's "Who This Book Is For," applied to
  copyright/redistribution rules instead of reader fit.
- `.alert--info` for two callouts (Purchases' "not live yet," 
  Limitation of Liability's "as is" disclaimer) — consistent with how
  Privacy Policy and Book Detail both used the same component for
  in-body callouts.

**Content approach**
- States plainly that Robayer WealthLab is not a licensed financial
  advisor and that content here is educational only, per instruction.
- Purchases section is explicit that checkout isn't live yet and that
  full terms will be added once SkillsPad (or an equivalent) is
  actually wired up — consistent with how Privacy Policy handles
  not-yet-active third-party services, and with `placeholder-action.js`'s
  honest-not-a-dead-link pattern used elsewhere on the site.

**Verified**
- Reading-progress bar and TOC active-highlighting confirmed via
  computed style at a specific scroll position (44% progress,
  "Intellectual property" correctly active).
- Sticky sidebar confirmed via computed style (`position: sticky`,
  `top: 112px`) at desktop width (1280px); single-column stacking
  confirmed at tablet (768px); the "You may" / "You may not" two-column
  checklist confirmed collapsing to one column and remaining fully
  readable at mobile (375px).
- Cross-link between the two Legal pages confirmed working **both
  ways** — Terms of Use → Privacy Policy → Terms of Use — now that
  both exist; previously this was a one-sided forward-reference.
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, H3s correctly nested under "Permitted use."
- Zero console errors, zero failed network requests, zero duplicate
  IDs, zero inline styles, zero new/changed CSS.

**Testing note:** a keyboard-focus check in this session reported
`:focus-visible` as false on a simple `.focus()` call, even
immediately after a fresh page reload — traced to the automated
browser's keyboard/mouse modality tracking in this particular preview
session, not a regression: `base.css`'s focus rules are byte-identical
to the version already verified working in Sprint 11 (confirmed via
`git diff`/`grep`, zero CSS changes this sprint).

### Sprint 11 — Privacy Policy — 2026-07-04

`legal/privacy-policy/index.html`, serving `/legal/privacy-policy/` —
the first Legal page, and the first of the three "still missing" pages
flagged by the Sprint 10.5 audit to actually ship. Built entirely from
the existing design system. **Zero new CSS was needed**; `css/` is
byte-for-byte unchanged from Sprint 10.6. No architecture changed, so
`README.md` was left untouched per this sprint's own instruction.

**Added**
- `legal/privacy-policy/index.html` — breadcrumb, hero (with effective/
  last-updated dates), a sticky-on-desktop table of contents alongside
  the policy body (Information We Collect, How We Use Information,
  Cookies, Third-Party Services, Data Security, Your Rights, Contact),
  Related Documents, newsletter CTA, and the shared footer.
- `Organization`, `WebPage`, and `BreadcrumbList` JSON-LD. No
  `FAQPage` this time — this page genuinely has no FAQ section, unlike
  every other page that's carried one so far.
- `<lastmod>2026-07-04</lastmod>` added to the existing
  `/legal/privacy-policy/` sitemap entry.

**Reused, not duplicated**
- `.article-layout` + `.article-body` + `.toc` (Sprint 3/6) for the
  sticky-sidebar-TOC-plus-content shell — the exact same pattern built
  for the Blog Article template turns out to fit a legal document just
  as well, since both are "long content with named sections." This is
  the `.toc` component's **eighth** distinct reuse context.
- `js/components/article-reading.js` reused as-is for the reading-
  progress bar and TOC active-section highlighting — both verified
  working here with zero code changes, since the module was already
  written generically against `[data-article-body]`/`[data-toc]`
  rather than anything Blog-specific.
- `.table` for the cookie-type breakdown (Essential/Analytics/
  Marketing) — the same component used for Book Detail's tenor/rate
  comparison, applied to genuinely different content.
- `.alert--info` reused twice as in-policy callouts (Third-Party
  Services' "nothing is active yet," Data Security's "no guarantee of
  absolute security") — consistent with how Book Detail used the same
  component for its own callouts.
- The arrow-icon "link row" pattern from `blog-card`'s "Read article"
  links, reused for Related Documents — three simple links, not a
  second copy of any card component.
- `.newsletter-band`, shared footer, breadcrumbs (matching Book
  Detail/Blog Article/Community's precedent for one-level-deep pages).

**Content approach**
- Written to honestly reflect the site's actual current state rather
  than describing infrastructure that doesn't exist yet: cookies,
  analytics, and third-party services (SkillsPad, an email platform,
  Google Analytics) are explicitly described as not yet active, with a
  commitment to update the policy when any of them turn on — directly
  addressing this sprint's instruction to explain that users will be
  notified. Data Security avoids overstating guarantees, per
  instruction, stating plainly that no online storage/transmission is
  completely secure.
- Effective date and Last updated both use today's date (July 4,
  2026) rather than literal placeholder text, consistent with how
  every other dated page on the site presents real dates.

**Verified**
- Reading-progress bar and TOC active-highlighting confirmed via
  computed style at a specific scroll position (57% progress, "Cookies"
  correctly active).
- Sticky sidebar confirmed via computed style (`position: sticky`,
  correct `top` offset) at desktop width (1280px); single-column
  stacking confirmed at tablet (768px) and mobile (375px), with the
  cookies table remaining fully readable and non-overflowing at 375px.
- Breadcrumb, all Related Documents links (including the two that
  correctly 404 — Terms of Use and Disclaimer aren't built yet — and
  the two that resolve — Contact and the `mailto:` link) confirmed.
- Keyboard focus confirmed on a TOC link via computed style (2px
  Growth Green outline, matching the site-wide standard).
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, no skipped levels.
- Zero console errors, zero unexpected failed network requests, zero
  duplicate IDs, zero inline styles, zero new/changed CSS.

### Sprint 10.6 — Launch Readiness Fixes — 2026-07-04

Three targeted fixes from the Sprint 10.5 Production Readiness Audit,
no new pages, no visual regressions.

**Fixed**
- The newsletter form's validation-error message was visible on every
  page by default, before any interaction — confirmed via computed
  style during the Sprint 10.5 audit (`hidden` attribute present,
  computed `display: flex`, genuinely visible to the user). Root
  cause: `.field__error { display: flex; }` in `components.css` always
  wins over the native `[hidden]` behavior, since author-stylesheet
  rules beat the UA stylesheet regardless of specificity. Added
  `.field__error[hidden] { display: none; }`, which has higher
  specificity than the base rule and correctly restores the intended
  hidden-until-invalid behavior. `newsletter-form.js` already toggled
  the `hidden` property correctly on every page — only the missing CSS
  override was ever the problem, so no JS changes were needed.
  Confirmed `components.html`'s intentional error-state demo (which
  has no `hidden` attribute at all) is unaffected and still displays
  as designed.
- `partials/footer.html`'s Community link read "Community (coming
  soon)" since Phase 5.1, unchanged through Sprint 9 shipping it as a
  real page. Now reads "Community" — fixed once, in the shared
  partial, so it's corrected on all 10 pages simultaneously.
- `README.md`'s sprint table, last updated in Sprint 6.5, now includes
  Sprints 7–10.6, the folder structure diagram includes `about/`,
  `contact/`, `community/`, and `newsletter/`, and the "Open items" /
  "What comes next" sections reflect what the Sprint 10.5 audit
  actually found still missing (three Legal pages, remaining Blog
  articles, the second Book) rather than the now-resolved "About/
  Contact/Community/Newsletter not built yet" framing.

**Verified**
- Computed-style check confirms the error message is hidden
  (`display: none`) by default on Home, Books, and Newsletter; an
  actual invalid submission (`not-an-email`) correctly reveals it with
  the existing error-state border/focus styling; a subsequent valid
  submission correctly replaces the form with the confirmation
  message, exactly as before.
- Footer "Community" text confirmed corrected on Home, Books, and
  About via direct DOM inspection (proving the partial-based fix
  propagated, not just the one file edited).
- Mobile (375px) spot-check on About confirms no layout regression in
  either the newsletter band or the footer.
- Zero console errors, zero failed network requests, zero inline
  styles, CSS brace-balanced.

### Sprint 10 — Newsletter Page — 2026-07-04

`newsletter/index.html`, serving `/newsletter/` — the single
most-referenced forward link on the entire site (every page's header
CTA, and dozens of in-page links since Phase 5.1, have pointed here).
Built entirely from the existing design system. **Zero new CSS was
needed**; `css/` is byte-for-byte unchanged from Sprint 9.

**Added**
- `newsletter/index.html` — hero, Why Subscribe, What You'll Receive,
  Newsletter Archive Preview, Subscriber Journey, FAQ, a final CTA,
  the newsletter signup itself, and the shared footer.
- `WebPage` JSON-LD (no dedicated "Newsletter" type exists in
  schema.org's vocabulary, so `WebPage` — the same choice made for
  Community — is the appropriate fit here too), alongside the
  established Organization and FAQPage schema.
- `<lastmod>2026-07-04</lastmod>` added to the existing `/newsletter/`
  sitemap entry.

**Reused, not duplicated**
- `.hero` (centered, matching Books/Resources/Blog's content-hub
  pattern rather than About/Contact/Community's `.hero--split`, since
  there's no founder/company-photo concept here).
- `.card` in a `.grid--4` for Why Subscribe.
- `.check-item` in a `.grid--2` for What You'll Receive.
- `.blog-card` reused for the Newsletter Archive Preview (`.grid--3`,
  three sample issues) — deliberately **without** the "Read article"
  link every other use of this component has had, since there's no
  real archive page yet to send readers to; adding one would have been
  a dead link. Designed so real issues can drop in as plain
  `.blog-card` entries later with no structural changes.
- `.toc` reused a **seventh** distinct way — a linear subscriber
  journey (Subscribe → Confirmation → Weekly lessons → Resources →
  Community → Courses) — after book chapters, popular resources,
  popular articles/beginner's path, in-page article navigation,
  About's company timeline, and Community's rollout roadmap.
- `.faq`, `.feature-banner__eyebrow`/`__title`/`__copy` reused
  standalone (fifth use, after Resources/About/Contact/Community) for
  the final CTA, `.newsletter-band`, shared footer.

**Verified**
- Full pass at mobile (375px), tablet (768px), and desktop (1280px):
  hero, the Why-Subscribe `.grid--4` and What-You'll-Receive `.grid--2`
  collapses, and the three-card `.grid--3` archive preview all
  confirmed correct.
- FAQ accordion verified via direct DOM inspection
  (`hasAttribute('open')`) on a specific item, confirming exactly one
  opens per click.
- Both `#newsletter-signup` anchor links (hero and final CTA) and the
  newsletter form (fill → submit → confirmation message) tested
  end-to-end.
- Confirmed, for the first time, that the header's "Get one better
  money tip" `.nav__cta` button correctly receives
  `aria-current="page"` when its own `/newsletter/` link matches the
  current page — and confirmed via computed style that this causes no
  unwanted visual change, since the `.nav__list a[aria-current="page"]`
  CSS rule is scoped to list links and doesn't match `.nav__cta`
  (a sibling element, not a list item).
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, H3s correctly nested under the four Why-Subscribe
  cards.
- Zero console errors, zero failed network requests, zero duplicate
  IDs, zero inline styles, zero new/changed CSS. One transient
  screenshot-tool timeout during testing resolved on retry with no
  underlying page issue (page `readyState` was already `"complete"`
  and all network requests had returned 200 before the retry).

### Sprint 9 — Community Page — 2026-07-04

`community/index.html`, serving `/community/` — built entirely from
the existing design system. **Zero new CSS was needed**; `css/` is
byte-for-byte unchanged from Sprint 8.

**Added**
- `community/index.html` — hero, Why Community Matters, What You'll
  Receive, Community Roadmap, Community Principles, Success Stories,
  FAQ, Community Invitation, newsletter CTA, and the shared footer.
- `WebPage` and `BreadcrumbList` JSON-LD, per this sprint's explicit
  request, alongside the established Organization and FAQPage schema.
  Added a visible "Home / Community" `.breadcrumbs` trail to match the
  `BreadcrumbList` data exactly — Community isn't a detail/sub-page
  like Book Detail or Blog Article (the only two prior pages with
  breadcrumbs), but since structured data must match visible content,
  a page that declares `BreadcrumbList` needs a visible breadcrumb to
  back it up.
- `<lastmod>2026-07-04</lastmod>` added to the existing `/community/`
  sitemap entry.

**Reused, not duplicated**
- `.hero--split` for the hero — third real use (after About, Contact).
- `.card` + `.check-item` combined for Why Community Matters (a
  `.grid--4` of cards, each containing a single check-item row instead
  of a separate title+body) — a new composition of two existing
  components, not a new component.
- `.card` + `.badge` for What You'll Receive (`.grid--3`, six cards) —
  `badge--success "Ongoing"` for the four available items and
  `badge--warning "Coming soon"` for the two not yet built, which
  cross-references the roadmap section directly below.
- `.toc` (Sprint 3) reused a **sixth** distinct way — a staged rollout
  timeline (Today → Soon → Later → Future → Long-term) — after book
  chapters, popular resources, popular articles/beginner's path,
  in-page article navigation, and About's company timeline. No new
  timeline component was needed, as instructed.
- `.check-item` again (single-column `.stack`, not a grid — five items
  don't split evenly into two columns) for Community Principles.
- The same three established testimonials (Ama, Kwame, Efua) for
  Success Stories — no new people invented, per this sprint's explicit
  instruction.
- `.faq`, `.feature-banner__eyebrow`/`__title`/`__copy` reused
  standalone (fourth use, after Resources/About/Contact) for the
  Community Invitation, `.newsletter-band`, shared footer.

**Caught and fixed one inline style before it shipped**
- Repeated the exact same mistake from Sprint 7: copied
  `style="display:block"` onto an eyebrow span out of old habit while
  drafting Success Stories. Caught immediately in the zero-inline-
  styles check and removed — `.eyebrow` has been `display: block` by
  default since Phase 1.

**Verified**
- Full pass at mobile (375px), tablet (768px), and desktop (1280px):
  hero--split, the Why-Community-Matters `.grid--4` (4→2→1) and
  What-You'll-Receive `.grid--3` (3→2→1) collapses all confirmed
  correct.
- FAQ accordion verified via direct DOM inspection
  (`hasAttribute('open')`) on a specific item (not just the first),
  confirming exactly one item opens per click; the FAQ answer's
  `/contact/` link confirmed present.
- Both anchor links (`#newsletter-signup` from the Community
  Invitation CTA) and the newsletter form (fill → submit → confirmation
  message) tested end-to-end.
- Confirmed Community intentionally has no header-nav `aria-current`
  target, consistent with Contact (both are footer-only links; Books/
  Blog/Resources/About are the four header-nav items).
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, H3s correctly nested under the six What-You'll-
  Receive cards.
- Zero console errors, zero failed network requests, zero duplicate
  IDs, zero inline styles, zero new/changed CSS.

### Sprint 8 — Contact Page — 2026-07-04

`contact/index.html`, serving `/contact/` — built entirely from the
existing design system. **Zero new CSS was needed**; `css/` is
byte-for-byte unchanged from Sprint 7.

**Added**
- `contact/index.html` — hero, Contact Methods (three cards), Before
  You Email Us checklist, FAQ, Community Invitation, newsletter CTA,
  and the shared footer.
- `ContactPage` JSON-LD (`mainEntity` → Organization with the General
  enquiries email), alongside the existing Organization and FAQPage
  schema.
- `<lastmod>2026-07-04</lastmod>` added to the existing `/contact/`
  sitemap entry.

**Reused, not duplicated**
- `.hero--split` for the hero — its second real use (after About),
  now with a "Browse our guides" / "Join the newsletter" action pair
  instead of a single CTA.
- `.card` in a `.grid--3`, `.badge` (info/success/warning, one per
  card), and `.check-item` for each Contact Method — the mail icon +
  email pattern reuses the same icon already shown in `components.html`
  and used on About's Core Values, this time as a real `mailto:` link
  rather than decoration.
- `.check-item` again (in a `.grid--2`, matching About's Promises
  layout) for Before You Email Us, with three of its four items linking
  to `/resources/`, `#faq` (this page), and `#newsletter-signup` (this
  page) — genuinely actionable, not just decorative bullets.
- `.faq` for the FAQ section.
- `.feature-banner__eyebrow` / `__title` / `__copy` reused standalone
  for the Community Invitation — third use of this pattern after
  Resources and About, following the same "no natural cover image"
  reasoning.
- `.newsletter-band`, partials/footer.html — no new one-off styles.

**Verified**
- Full pass at mobile (375px), tablet (768px), and desktop (1280px):
  hero--split layout, the `.grid--3` card grid's 3→2→1 collapse, and
  the Before-You-Email-Us checklist's 2→1 collapse all confirmed
  correct.
- FAQ accordion confirmed via direct DOM inspection (`hasAttribute
  ('open')`), not just visually — one screenshot during testing showed
  what looked like two items open at once, traced to a rendering/
  timing artifact in the screenshot capture tool itself, not a real
  state bug (`.faq` is native `<details>` with zero custom JS, so
  there's no code path for spurious multi-open behavior; direct DOM
  inspection confirmed only the single clicked item was actually open).
- All contact page links verified individually: three `mailto:` links,
  `/resources/`, `#faq`, `#newsletter-signup`, `/books/`, `/newsletter/`.
- Newsletter form tested end-to-end (valid email → confirmation
  message swap).
- Confirmed Contact intentionally has no header-nav `aria-current`
  target — it's a footer-only link (Books/Blog/Resources/About are the
  four header-nav items), consistent with the existing site structure,
  not a gap introduced here.
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, H3s correctly nested under the three Contact Method
  cards.
- Zero console errors, zero duplicate IDs, zero inline styles, zero
  new/changed CSS. The only failed network requests seen during
  testing were pre-existing, expected 404s for `/legal/terms-of-use/`
  and `/legal/disclaimer/` (unbuilt in every prior sprint, listed as
  such in `sitemap.xml`) — unrelated to anything added this sprint.

### Sprint 7 — About Page — 2026-07-04

`about/index.html`, serving `/about/` — built entirely from the
existing design system. **Zero new CSS was needed for this page**;
`css/` is byte-for-byte unchanged from Sprint 6.5.

**Added**
- `about/index.html` — hero, Why Robayer WealthLab Exists, Founder
  story, Mission & Vision, Core values, Brand manifesto highlights, Our
  promises to readers, Why trust Robayer WealthLab (testimonials),
  Timeline & roadmap, FAQ, newsletter CTA, and the shared footer.
- `<lastmod>2026-07-04</lastmod>` added to the existing `/about/`
  sitemap entry.

**Reused, not duplicated**
- `.hero--split` — demoed in `components.html` since Phase 1 with this
  exact "About Robayer / Someone slightly ahead on the journey" copy,
  and never actually used on a real page until now.
- `.feature-banner__eyebrow` / `__title` / `__copy` reused standalone
  (no image side) for "Why Robayer WealthLab Exists" — same pattern as
  Resources' featured-resource section.
- `.article-body` (Sprint 6) for the founder story's multi-paragraph
  prose — first use of it for narrative biography rather than an
  instructional article.
- `.card` in a `.grid--2` for Mission & Vision — two cards, no new
  variant needed.
- The exact icon+heading+description pattern from Home's trust section
  (Sprint 1) for Core Values — same structure, different (and
  deliberately non-duplicate) content: Home covers founder-led/no-hype/
  Ghana-first/free-to-start; About goes deeper into honesty, meeting
  readers where they are, plain language, and Ghana-first specifically
  in the guides.
- `.pull-quote` + `.check-item` for the manifesto section, and
  `.check-item` again (in a `.grid--2`) for the promises section — same
  component, two different tones (belief statements vs. concrete
  commitments).
- The same three established testimonials (Ama, Kwame, Efua) for "Why
  trust Robayer WealthLab" rather than inventing new ones — reused
  exactly as they appear on Home and Book Detail.
- `.toc` (Sprint 3) reused for a **fifth** distinct purpose: a
  sequential company timeline, after book chapters, popular resources,
  popular articles/beginner's path, and in-page article navigation —
  further confirmation the component is genuinely generic.
- `.faq`, `.newsletter-band`, partials/footer.html — no new one-off
  page styles anywhere.

**Content note**
- The founder biography expands the facts already established
  elsewhere on the site (founder-led, simplifies financial education
  for ordinary Ghanaians, honest guidance one step at a time) into a
  fuller narrative, without introducing new unverifiable biographical
  claims (no invented employer history, credentials, or dates) —
  consistent with the brand's "no hype, ever" principle.

**Caught and fixed one inline style before it shipped**
- Copied an old pattern (`style="display:block"` on an eyebrow span)
  out of habit while drafting the "Why trust us" section — caught
  immediately in the zero-inline-styles check. `.eyebrow` has been
  `display: block` by default since Phase 1, so the span was removed
  entirely rather than fixed, same resolution as the identical issue
  found and fixed on Home back in Sprint 1.5.

**Verified**
- Full regression-style pass: mobile (375px), tablet (768px), and
  desktop (1280px) — hero--split side-by-side layout, Mission/Vision
  and Core Values grid collapse (2→1 and 4→2→1), testimonials grid,
  and the founder-story prose measure all confirmed correct at each
  width.
- FAQ accordion, the hero's `#founder-story` anchor link, and nav
  `aria-current="page"` on the About link all confirmed working.
- Heading hierarchy confirmed via a full heading dump: single H1, one
  H2 per section, correctly nested H3s under Mission/Vision and Core
  Values, and a `sr-only` H2 giving the combined Mission/Vision section
  a proper accessible name without a redundant visible heading.
- Zero console errors, zero failed network requests, zero duplicate
  IDs, zero inline styles, zero new/changed CSS.

### Sprint 6.5 — Architecture Refinement — 2026-07-04

A pure technical-improvement sprint following Architecture Review 2 —
no new pages or user-facing features. Every item below was scoped,
prioritized, and approved in the review before work began.

**Priority 1 — Accessibility (critical)**
- Fixed the `--color-text-secondary` WCAG AA contrast failure
  identified in the review (computed ~2.76:1 on Warm Paper, ~2.98:1 on
  white — both well under the 4.5:1 requirement for normal text).
  Added a new `--color-slate` token (`#6B675E`) and repointed
  `--color-text-secondary` to it — now ~5.2:1 on Warm Paper and ~5.6:1
  on white, comfortably passing AA on both. `--color-stone-grey`
  itself is unchanged (still used for `--color-border-strong` and the
  disabled-button background, both non-text uses with no contrast
  requirement to fix), so no border or disabled-state appearance
  changed — only text got darker.
- Found and fixed one place this token change wouldn't have reached
  on its own: `.blog-card__meta` (article date + reading time)
  referenced `--color-stone-grey` directly instead of through
  `--color-text-secondary`. Repointed it, since it's unambiguously
  secondary body text. Checked every other usage of both tokens across
  `components.css` and confirmed no other text-color usage was missed.
- Deliberately left `dev-showcase.css`'s `.showcase-label` (a
  `components.html`-only caption label) on `--color-stone-grey` —
  it's dev tooling, not real body text on a real page, so it's out of
  the stated scope ("all normal body text").

**Priority 2**
- Consolidated `buy-button.js` into `placeholder-action.js` and
  deleted the former, closing the duplication flagged (and left
  unresolved) in both the Sprint 4 and Sprint 5 CHANGELOGs. The Book
  Detail buy button now uses `data-placeholder-action` with an
  explicit `data-message` reproducing the original wording exactly
  ("Checkout is launching soon — subscribe to know the moment it
  opens.") — verified byte-for-byte after the swap, not just visually.
- Rewrote `README.md` to describe the project's actual current state:
  a sprint-by-sprint table (5.1 through 6.5), the real folder structure
  (`books/`, `blog/`, `resources/`, all `js/components/` files), what's
  still unbuilt (About/Newsletter/Contact/Community/Legal), and an
  accurate open-items list (production domain confirmed; placeholder
  favicons already in place; final art and font self-hosting still
  open). Removed every "Phase 5.2 onward" reference — that framing was
  frozen at Phase 5.1 and hadn't been touched since, despite 6 shipped
  sprints since then.
- Brought `components.html` — the project's living style guide — back
  in sync. It hadn't been updated since Phase 1 and was missing every
  component introduced from Sprint 1.5 through Sprint 6. Added 8 new
  numbered sections (20–27): Feature Banner, Pull Quote, Filter Bar,
  Table of Contents, Check Items, Breadcrumbs, Article Body & Layout,
  and Reading Progress Bar — plus the new color tokens (Slate, the four
  semantic tints, the two hover-darken shades) added to the Color
  Palette section, and a new Z-index Scale table appended to the
  Spacing section.

**Priority 3**
- Moved the last 8 hardcoded hex values out of `components.css` and
  `dev-showcase.css` into new `tokens.css` custom properties:
  `--color-growth-green-dark` / `--color-sika-gold-dark` (button hover
  states) and `--color-success-tint` / `--color-warning-tint` /
  `--color-error-tint` / `--color-info-tint` (badge/alert backgrounds).
  `grep` confirms zero hardcoded hex values remain outside
  `tokens.css`.
- Added a semantic z-index scale to `tokens.css` — `--z-sticky` (100),
  `--z-overlay` (200), `--z-skip-link` (1000) — and wired the three
  existing raw z-index values (`.site-header`, `.reading-progress`,
  `.skip-link`) to them. Values are unchanged, so layering behavior is
  identical; only future additions now have a scale to fit into
  instead of picking another ad hoc number.
- Added the missing `favicon-32.png` `<link>` to `index.html` (Home
  was the one page, dating to Phase 5.1, that never had it).
- Set `font-weight: var(--weight-medium)` explicitly on `.pull-quote`
  and `.testimonial__quote` (the latter wasn't named in the sprint
  brief but has the identical issue) — Fraunces only loads one italic
  weight (500), and both components were rendering italic text at an
  inherited weight the font set doesn't actually include.

**Explicitly not done**
- The newsletter-band partial extraction was intentionally deferred,
  per instruction — the block is still duplicated verbatim across all
  6 pages. Revisit once the remaining pages are built, if the
  duplication still looks worth solving at that point.

**Verified — full regression pass, not just the changed areas**
- Contrast fix confirmed via computed style (`rgb(107, 103, 94)` =
  `#6B675E`) on Home, and visually on every other page's card
  descriptions, testimonial context, blog-card meta, and FAQ answers.
- `buy-button.js` → `placeholder-action.js` swap confirmed via the
  exact rendered message text on Book Detail, plus a network-tab check
  that the deleted file produces no 404 anywhere.
- Books' category filter and Resources' combined category+search
  filter re-tested and still correct after the token/CSS changes (they
  don't touch color, but this was a full regression pass, not a
  targeted one).
- Blog Article's reading-progress bar and TOC active-highlighting
  re-verified at three distinct scroll positions (0%, ~45%, ~94%) with
  the correct section active at each — this actually caught a
  methodology bug in my own testing (see note below), not a site bug.
- z-index values confirmed identical before/after tokenization via
  computed style (100/200/1000).
- `components.html`'s 8 new sections and updated color palette
  rendered and visually checked one by one; confirmed the two new
  demo-only classes needed for the Reading Progress Bar section
  (`.showcase-progress-track`/`.showcase-progress-demo`, added to
  `dev-showcase.css`) since the real `.reading-progress` component is
  `position: fixed` and can't be shown in-flow.
- Mobile (375px) spot-check on Blog Article (the most structurally
  complex page) — layout intact, contrast fix legible, no regressions.
- Zero console errors, zero failed network requests, zero inline
  styles anywhere in production pages; `components.html`'s inline-style
  count is 26, all pre-existing or newly-documented exceptions (unique
  per-swatch/per-bar values), consistent with the rule established in
  Sprint 1.5.

**Testing note:** while re-verifying the reading-progress bar, I hit
inconsistent readings that turned out to be caused by my own test
methodology, not the site: `html { scroll-behavior: smooth }` (global,
from `base.css`) makes `window.scrollTo()` animate asynchronously, so
checking computed styles synchronously right after a scroll call read
a stale, mid-animation position. Switching to
`window.scrollTo({top, behavior: 'instant'})` in verification fixed it
immediately and confirmed the underlying feature was never broken.

### Sprint 6 — Blog Article Template — 2026-07-04

`blog/what-are-treasury-bills-in-ghana/index.html` — the first real
article, and the canonical template every future article will be
built from. Four small, genuinely reusable additions to the design
system; everything else composes existing components in new ways.

**Added**
- `blog/what-are-treasury-bills-in-ghana/index.html` — breadcrumbs,
  hero (category, title, subtitle, author byline with publish/update
  dates and reading time), a sticky-on-desktop table of contents, a
  fully-written article body (pull quote, two info/warning callouts, a
  comparison table, numbered and bulleted lists, a "Key takeaways"
  box), FAQ, related articles, newsletter CTA, disclaimer, and the
  shared footer.
- `js/components/article-reading.js` — one scroll listener driving two
  related affordances: a fixed reading-progress bar and active-section
  highlighting in the table of contents. Both are optional per-page
  (each checks its own markup exists before doing anything), so a
  future short article can skip either without touching this file.
- Four new CSS additions in `css/components.css`, each checked against
  the existing system first and each reusable by every future article:
  - `.article-layout` / `.article-layout__sidebar` — a sticky
    sidebar-TOC + content grid (260px + 1fr, ≥1200px only; single
    column below that). Nothing existing provided an asymmetric
    2-column layout — `.grid--2` is equal-width, `.hero--split` isn't
    sticky and isn't meant for this.
  - `.article-body` — restores real `disc`/`decimal` list markers and
    heading/paragraph vertical rhythm for long-form prose, scoped so
    it doesn't touch the site-wide `list-style: none` reset that every
    other (non-prose) list on the site correctly relies on.
  - `.toc__title a[aria-current="location"]` — active-link styling for
    the table of contents, set by `article-reading.js`.
  - `.reading-progress` — the fixed progress bar. Its width is driven
    by a `--reading-progress` custom property set from JS, not an
    inline `style` attribute, keeping the "zero inline styles" rule
    intact even for a continuously-variable runtime value.
- `Article`, `BreadcrumbList`, and `FAQPage` JSON-LD, plus `og:type:
  article` with `article:published_time` / `article:modified_time` /
  `article:author` / `article:section` — the first page on the site to
  use Open Graph's article type, appropriately, since it's the first
  page that actually is one.
- Two new sitemap entries with `<lastmod>` dates: `/blog/` (today) and
  `/blog/what-are-treasury-bills-in-ghana/` (2026-07-01, the article's
  own stated update date, not the sprint's build date).

**Reused, not duplicated**
- `.breadcrumbs` (Sprint 3) for wayfinding.
- `.testimonial__attribution` / `__avatar` / `__name` / `__context`
  reused standalone (no `.testimonial` card wrapper) for the author
  byline — same "reuse the color/layout classes outside their original
  component" pattern as `.feature-banner__*` in Sprints 4–5.
- `.pull-quote` (Sprint 1.5) for the mid-article pull quote — first
  use inside actual long-form body copy rather than a marketing
  section.
- `.alert--info` / `.alert--warning` (Phase 1) reused as in-article
  information and caution callout boxes — no new "callout" component
  needed, the existing alert styling already fit.
- `.table` (Phase 1, only ever shown in the `components.html` style
  guide) gets its first real use, for the tenor/rate comparison.
- `.card` + `.check-item` (Sprint 3) combined for the "Key takeaways"
  box — zero new CSS for a component that looks purpose-built.
- `.toc` (Sprint 3) used for real in-page navigation this time (with
  working anchor links and JS-driven active state), its fourth
  distinct context after book chapters, popular resources, and popular
  articles/beginner's path.
- `.faq`, `.blog-card` (Related Articles), `.newsletter-band` — no new
  one-off page styles anywhere.

**Honesty in financial content**
- The tenor/rate comparison table is explicitly labeled "Illustrative
  rate" with a callout immediately below stating the numbers are for
  teaching the tenor/rate relationship only, not a current-rate claim,
  and pointing readers to confirm real rates with their bank or the
  Bank of Ghana — consistent with the brand's established "no hype,
  ever" principle rather than presenting invented figures as fact.

**Verified**
- Reading-progress bar and TOC active-highlighting both checked via
  direct property/attribute inspection at multiple scroll positions
  (not just visually) — confirmed correct percentage and correct
  active link at each position tested.
- Sticky sidebar confirmed via computed style (`position: sticky`,
  correct `top` offset) at desktop width (1280px); single-column
  stacking confirmed at tablet (768px) and mobile (375px), with the
  comparison table and callouts remaining fully readable at 375px.
- FAQ accordion, TOC anchor navigation, and the Related Articles /
  breadcrumb links all confirmed working.
- Caught and fixed a local-verification-only issue: the ad-hoc static
  server used for manual testing didn't resolve directory-style URLs
  (e.g. `/blog/…/`) the way GitHub Pages does in production, which
  initially made a same-site link check look inconclusive. Patched the
  throwaway dev server (not part of the project) to resolve
  `index.html` for any directory, then re-verified every cross-page
  link (Home → Books → Book Detail → Blog → Article → back via
  breadcrumb) resolves correctly.
- Heading hierarchy (single H1, one H2 per section/subsection, no
  skipped levels) confirmed via a full heading dump.
- Zero console errors, zero failed network requests, zero inline
  styles.

### Sprint 5 — Blog Index — 2026-07-04

`blog/index.html`, serving `/blog/` — the destination the "Blog" nav
link and footer link have pointed to since Phase 5.1. Built entirely
from the existing design system: **no new CSS was added this
sprint** — the only structural change is a JavaScript consolidation
that removes duplication instead of adding to it.

**Added**
- `blog/index.html` — hero, Featured Article spotlight, a
  search+category-filterable "Latest articles" grid (8 articles),
  Popular Articles, a Beginner's Path reading order, newsletter CTA,
  FAQ, and the shared footer (per the section order requested for this
  sprint, Newsletter comes before FAQ here, unlike Sprints 2–4).
- `js/components/content-filters.js` — see "engineering decision"
  below.
- `FAQPage` JSON-LD, alongside the existing Organization schema.
  Individual `BlogPosting` schema is deferred to Sprint 6's article
  pages, where it belongs, not the index.
- `<lastmod>2026-07-04</lastmod>` added to the existing `/blog/`
  sitemap entry.

**Engineering decision: generalized the filter script instead of
writing a third copy**
- By this sprint there would have been three near-identical filter
  scripts: `book-filters.js` (Sprint 2, category-only),
  `resource-filters.js` (Sprint 4, category + search), and a
  hypothetical `blog-filters.js`. Per this sprint's explicit
  instruction not to duplicate JavaScript that can be generalized,
  replaced both existing scripts with one `content-filters.js`,
  driven by generic data attributes (`[data-filter-grid]`,
  `[data-filter-controls]`, `[data-filter-search]`,
  `[data-filter-empty]`) instead of page-specific ones. `book-filters.js`
  and `resource-filters.js` are deleted; `books/index.html` and
  `resources/index.html` were updated to the generic attribute names
  and now include `content-filters.js` — a pure rename with no
  behavior change, re-verified below. (This is a deliberate exception
  to the general rule of not touching already-shipped sprints without
  being asked — justified here because the instruction for this
  sprint explicitly called for it, and the change is mechanical and
  low-risk.)

**Reused, not duplicated**
- `.blog-card` (defined since Phase 1, only ever shown in the
  `components.html` style guide until now) gets its first full real
  use — category via `.eyebrow`, reading time + publication date via
  `.blog-card__meta` (with a semantic `<time datetime>` element), and
  a "Read article" link using the existing arrow icon, alongside the
  already-linked title. No new fields needed new CSS.
- `.feature-banner__eyebrow` / `__title` / `__copy` for the Featured
  Article, this time with the full flex `.feature-banner` layout
  (image + text side by side) since `.blog-card__image` (16:9) works
  as a "cover" the way it didn't for Sprint 4's resources.
- `.filter-bar` / `.filter-pill` (Sprint 2) for the Saving / Investing
  / Budgeting category pills.
- `.toc` (Sprint 3) reused for a **third** distinct purpose: a
  ranked "Popular articles" list and a sequential "Beginner's path"
  reading order — different content, same component, on the same
  page, which is the clearest evidence yet that the component is
  genuinely generic rather than book-specific.
- `.alert--info` (empty state), `.faq`, `.newsletter-band` — no new
  one-off page styles anywhere.

**Prepared for Sprint 6**
- All eight articles use the `/blog/<slug>/` URL convention (matching
  Books' `/books/<slug>/` pattern from Sprint 3) in the title link,
  the "Read article" link, and the Featured Article CTA — Sprint 6 can
  build each detail page at its already-referenced address with no
  link changes needed here.
- Category taxonomy (Saving/Investing/Budgeting) is consistent with
  Resources' taxonomy so a future cross-page "related content" feature
  wouldn't need a mapping layer.

**Verified**
- Confirmed **zero new CSS was needed** — checked the existing system
  first, per this sprint's explicit instruction, before writing any
  markup.
- Regression-tested Books and Resources after the `content-filters.js`
  migration: Books' category filter and Resources' combined
  category+search filter both still work correctly, confirmed via
  direct DOM inspection, not just visually.
- Blog's own search, category filter, and combined use tested the same
  way; empty-state message and its subscribe link confirmed.
- Every Popular Articles / Beginner's Path anchor link jumps to the
  correct card.
- FAQ accordion, nav `aria-current="page"` on the Blog link, and
  heading hierarchy (single H1, one H2 per section) all verified.
- Local static-server pass at mobile (375px), tablet (768px), and
  desktop (1280px).
- Zero console errors, zero failed network requests, zero inline
  styles.

### Sprint 4 — Resources page — 2026-07-04

`resources/index.html`, serving `/resources/` — the destination the
resource-card links on Home have pointed to since Phase 5.1. Built as
a filterable/searchable free-resource library, reusing the design
system throughout; only two genuinely new, generic pieces were added.

**Added**
- `resources/index.html` — hero (with a "Browse resources" anchor
  action), a Featured Free Resource spotlight, a searchable/filterable
  "Templates & checklists" grid (5 resources), a "Financial
  calculators" coming-soon section (3 resources), a "Popular
  resources" ranked list, FAQ, newsletter CTA, and the shared footer.
- `js/components/resource-filters.js` — combines category-pill
  filtering with live text search over the same grid in one module
  (deliberately not two separate scripts — see "engineering decision"
  below).
- `js/components/placeholder-action.js` — a **generalized** version of
  Sprint 3's `buy-button.js` pattern: any element with
  `[data-placeholder-action]` gets an honest "not connected yet" note
  on click instead of behaving like a dead link, with the message
  configurable via `[data-message]`. Used here for the resource
  download buttons, since no real files exist yet. `buy-button.js`
  itself was left untouched (still working, still in use on the Book
  Detail page) — consolidating the two is a reasonable follow-up but
  wasn't done here to avoid touching already-shipped Sprint 3 code
  without being asked.
- Two new, genuinely reusable additions to the design system (checked
  the existing system first; everything else on this page reuses
  Sprints 1–3 components as-is):
  - `css/utilities.css`: `.flex-1` (lets a flex child, like the search
    input, fill its row) and `.mx-auto` (centers a max-width block —
    needed once I'd reused `.feature-banner__copy` outside its
    original flex layout; see bug note below).
  - `css/components.css`: `.resource-card--upcoming` (dashed border,
    reduced opacity) for the three "coming soon" calculator cards —
    reusable for any future "not built yet" card, on any page.
- `FAQPage` JSON-LD, matching the visible FAQ content, alongside the
  existing Organization schema. No `ItemList`/`Product` schema added,
  consistent with the Books listing page's precedent of reserving that
  for actual product/detail pages, not listing pages.
- `<lastmod>2026-07-04</lastmod>` added to the existing `/resources/`
  sitemap entry now that the page is real.

**Reused, not duplicated**
- `.filter-bar` / `.filter-pill` (Sprint 2) for the category pills —
  taxonomy here is Budgeting/Saving/Debt/Investing, distinct from
  Books' own categories, same component.
- `.feature-banner__eyebrow` / `__title` / `__copy` (Sprint 1.5/2) for
  the Featured Free Resource's color treatment — reused standalone
  without the `.feature-banner` flex wrapper, since a resource has no
  natural "cover" image the way a book does.
- `.toc` / `.toc__item` (Sprint 3, originally built for a book's table
  of contents) repurposed as the Popular Resources ranked list —
  proof the component is genuinely generic, not book-specific. Its
  entries are real anchor links to the cards above, not a second copy
  of them.
- `.resource-card`, `.badge`, `.grid--3`, `.alert--info` (empty state),
  `.faq`, `.newsletter-band`, `.content-column` — no new one-off page
  styles.
- Nav `aria-current="page"` on the Resources link required **no code
  change** — `nav.js`'s pathname-matching logic (Phase 5.1) already
  handles any page generically. Verified rather than reimplemented.

**Engineering decision: one filter module, not two**
- Initially considered a separate search script alongside category
  filtering (mirroring `book-filters.js` exactly), but category and
  search both need to narrow the *same* grid at the *same* time — two
  independent scripts toggling the same `.hidden` class would fight
  each other (e.g. typing a search term could undo the active
  category). `resource-filters.js` keeps one `activeCategory` state
  and a single `applyFilters()` that checks both conditions together.

**Caught and fixed two bugs before shipping**
- Wrote `style="margin-inline:auto"` inline while reusing
  `.feature-banner__copy` outside its flex context, then caught it
  immediately in the zero-inline-styles check — replaced with the new
  `.mx-auto` utility instead of leaving the inline style in.
- No repeat of Sprint 2/3's `hidden`-attribute-vs-`display` cascade bug:
  `resource-filters.js` toggles the `.hidden` utility class from the
  start, not the native attribute.

**Accessibility**
- Search input has a visible placeholder plus an associated `.sr-only`
  `<label>` (accessible name independent of placeholder text).
- Filter pills remain a `role="group"` labelled by visible text, each
  toggling `aria-pressed`, exactly as established in Sprint 2.
- Empty-state result message uses `aria-live="polite"`.
- Placeholder-action notes use `role="status"`.
- Single H1, one H2 per section, verified via a heading-tag dump
  during testing (see below) — no skipped levels.

**Verified**
- Local static-server pass at mobile (375px), tablet (768px), and true
  desktop (1280px).
- Search alone, category filter alone, and both **combined**
  (Budgeting + "tracker" correctly narrows to just Monthly Expense
  Tracker) — confirmed via direct DOM inspection, not just visually.
- Empty-state message appears only when a combination truly matches
  nothing, and its subscribe link works.
- Every "Popular resources" link jumps to the correct card via its
  anchor id.
- Placeholder-action download note appears correctly and only once
  per click (no duplicate notes on repeated clicks).
- FAQ accordion opens/closes correctly.
- Confirmed `aria-current="page"` is set on the Resources nav link on
  both desktop and the mobile menu.
- Confirmed heading hierarchy (H1 then one H2 per section) via a
  console dump of all headings.
- No console errors, no failed network requests.

### Sprint 3 — Book Detail page — 2026-07-04

First detail page: `books/starting-to-invest-with-gh100/index.html`,
serving `/books/starting-to-invest-with-gh100/` — the destination the
"Get the guide" links on Home and the Books page have pointed to since
Sprint 2. Built as a focused sales/trust page for the one published
book, from existing components wherever one already fit.

**Added**
- `books/starting-to-invest-with-gh100/index.html` — breadcrumb, hero
  (cover/title/subtitle/price/buy button), What You'll Learn, Table of
  Contents, Who This Book Is For, About the Author, an inline
  testimonial, FAQ, Related Books, a financial-education disclaimer,
  newsletter CTA, and the shared footer.
- `js/components/buy-button.js` — the buy button is a temporary
  placeholder (no SkillsPad checkout integration yet). Clicking it
  doesn't behave like a dead link: it reveals an honest "Checkout is
  launching soon — subscribe to know the moment it opens" note next to
  the button, same progressive-enhancement pattern as
  `newsletter-form.js`.
- `css/components.css`: `.toc`/`.toc__item`/`.toc__number`/
  `.toc__title` (chapter list, reusable for any future book) and
  `.check-item`/`.check-item__icon`/`.check-item__text` (icon + body
  copy list rows that need to wrap correctly — see the fix below).
- `Book` (with a nested `Offer`, price GH₵39/GHS, `InStock`),
  `BreadcrumbList`, and `FAQPage` JSON-LD, alongside the existing
  Organization schema — matches the visible breadcrumb and FAQ content
  exactly, per Google's structured-data guidance.
- `/books/starting-to-invest-with-gh100/` added to `sitemap.xml`.

**Reused, not duplicated**
- `.breadcrumbs` — the component Sprint 1.5 documented as "reserved for
  the detail pages that need it" now has its first real use.
- `.hero--split` (previously only demoed in `components.html`) for the
  cover/title/subtitle/price/CTA hero — no new hero variant needed.
- `.book-card__cover`, `.book-card__cover--green`, `.grid--3` for
  Related Books — the exact same pattern as the Books page grid.
- `.testimonial--inline` — used exactly where its own code comment
  says it's meant to go ("used on Book Detail immediately before a
  CTA"), reusing Ama's existing treasury-bills testimonial rather than
  writing a new one, since it's a direct topical match for this book.
- `.faq` (Sprint 2), `.content-column`, `.alert--warning` (disclaimer),
  `.newsletter-band`, the About-teaser `grid--2` + `.aspect-4-5`
  pattern for the author bio — no new one-off page styles anywhere on
  the page.

**Caught and fixed a bug before it shipped**
- The icon + text checklist rows (What You'll Learn, Who This Book Is
  For) initially reused `.cluster`, which sets `flex-wrap: wrap` — on
  narrow viewports this moved the whole text item to a new flex line
  below the icon instead of letting the text wrap next to a
  fixed-position icon. Caught during the mobile visual-verification
  pass. Fixed by adding the `.check-item` component instead of patching
  `.cluster` (which is used too widely elsewhere to safely change its
  behavior).

**Accessibility**
- Breadcrumb is a `<nav aria-label="Breadcrumb">` with the current page
  marked via a plain `aria-current="page"` span, separators hidden from
  assistive tech.
- Single H1 (book title) in the hero; every subsequent section has
  exactly one H2, matching the rest of the site's heading discipline.
- "Who This Book Is For" pairs check/x icons with `aria-hidden="true"`
  and relies on the visible text for meaning, not color/icon shape
  alone.
- Buy button placeholder note uses `role="status"` so screen reader
  users hear it appear without needing to find it manually.

**Verified**
- Local static-server pass at mobile (375px), tablet (768px), and true
  desktop (1280px, wide enough to exercise `.hero--split`'s side-by-side
  layout for the first time with real content — previously only ever
  seen in the `components.html` demo).
- Clicked the buy button (placeholder note appears correctly) and every
  FAQ item (native accordion opens/closes, icon flips from + to −).
- No console errors, no failed network requests.
- Confirmed the two "Get the guide" links pointing here (Home's
  featured banner, the Books page grid) now resolve.

### Sprint 2 — Books page — 2026-07-04

First real content page beyond Home: `books/index.html`, serving the
clean URL `/books/`. Built entirely from the existing architecture —
no new page-level styles, all markup composed from tokens/base/layout/
components/utilities in the established load order.

**Added**
- `books/index.html` — Hero, featured-eBook spotlight, filterable book
  grid, "Coming soon" teaser, FAQ, newsletter CTA, shared footer.
- `js/components/book-filters.js` — category-pill filtering for the
  book grid, self-initializing on `DOMContentLoaded` like the other
  page-level component scripts. Reads `[data-category]` off whatever
  book-cards exist in the grid, so adding the 3rd, 10th, or 50th book
  needs no changes to this file.
- `css/components.css`: `.filter-bar` / `.filter-pill` (category
  filter pills, reusable for Blog/Resources later) and `.faq`/
  `.faq__item`/`.faq__question`/`.faq__icon`/`.faq__answer` (accordion
  built on native `<details>/<summary>` — keyboard-operable and
  exposes expanded state to assistive tech with no ARIA needed).
- `FAQPage` JSON-LD added alongside the existing Organization schema,
  per the README's Phase 1 SEO requirement to add per-page Article/FAQ
  structured data as content pages are built.
- `<lastmod>2026-07-04</lastmod>` added to the `/books/` entry in
  `sitemap.xml` now that the page is real.

**Reused, not duplicated**
- `.hero` / `.hero__content` (Home's centered hero pattern)
- `.feature-banner` (built in Sprint 1.5 for exactly this) for the
  featured-eBook spotlight
- `.book-card` / `.book-card--featured` / `.book-card__cover--green`
  for the grid — same two books already established in
  `components.html`'s style-guide demo (Starting to Invest with
  GH₵100; The MoMo Savings Playbook)
- `.grid.grid--3`, `.content-column`, `.badge`, `.btn`, `.eyebrow`,
  `.newsletter-band` (+ `newsletter-form.js`) — no new one-off markup
  patterns introduced for any of these

**Accessibility**
- Filter pills are real `<button>`s in a `role="group"` labelled by a
  visible "Filter by topic:" text (not just an `aria-label`), each
  toggling `aria-pressed`; keyboard- and screen-reader-operable with
  no custom ARIA widget code.
- The empty-filter-result message uses `aria-live="polite"` so screen
  reader users hear it when a category has no guides yet.
- FAQ accordion uses native `<details>/<summary>` rather than a custom
  JS disclosure, so expand/collapse, keyboard operation, and state
  exposure are all handled by the browser.
- Verified 44px-minimum touch targets on filter pills and FAQ summaries,
  visible focus states via the existing global `:focus-visible` rule,
  and correct heading hierarchy (single H1 in the hero, H2 per section).

**Fixed a bug before it shipped**
- The filter/empty-state show-hide logic deliberately toggles the
  `.hidden` utility class rather than the native `hidden` attribute.
  `.book-card` and `.alert` both set `display` in `components.css`,
  which — same as the pre-existing `.field__error` bug flagged in
  Sprint 1.5 — would silently override a bare `[hidden]` attribute.
  Toggling `.hidden` instead works correctly because `utilities.css`
  loads after `components.css`, so it wins the cascade tie. Verified
  interactively (see verification notes below).

**Verified**
- Local static-server pass across desktop, tablet (768px), and mobile
  (375px): hero, featured banner, grid (3→2→1 collapse), filter pills,
  FAQ accordion, newsletter band, and footer all render correctly with
  no layout breakage.
- Filter interaction tested directly: clicking "Saving"/"Investing"/
  "Entrepreneurship" correctly shows/hides the matching book-cards,
  toggles `aria-pressed`, and the "no guides in this category yet"
  message appears only when a category is genuinely empty
  (Entrepreneurship, today).
- No console errors, no failed network requests (all script/asset
  references resolve, including the placeholder assets added in
  Sprint 1.5).
- Confirmed the Home and footer/nav links to `/books/` — previously
  dead links, flagged in the original project audit — now resolve.

### Sprint 1.5 — Technical cleanup — 2026-07-04

Housekeeping pass ahead of Sprint 2 (Books page). No design or
functional changes — output should look and behave identically to
before this sprint.

**Added**
- Git repository initialized for the project (previously untracked).
- Placeholder production assets so no referenced file 404s:
  `assets/icons/favicon-32.png`, `assets/icons/apple-touch-icon.png`,
  `assets/images/og-default.jpg`, `assets/images/logo/logo.svg`. All
  four reuse the existing coded Sika step-mark approximation and brand
  colors — each is explicitly marked as a placeholder (in its folder's
  README) pending final production artwork.
- New reusable classes to replace page-level inline styles:
  - `css/utilities.css`: `.font-body`, `.font-medium`, `.text-body-lg`,
    `.text-small`, `.text-lg`, `.aspect-4-5`.
  - `css/components.css`: `.eyebrow--gold`, `.pull-quote`,
    `.feature-banner` (+ `__eyebrow`/`__title`/`__copy`),
    `.book-card__cover--compact`, `.book-card__cover--green`,
    `a.resource-card`, `.newsletter-band__input`,
    `.newsletter-band .field__error`.
  - `css/dev-showcase.css` (dev-only): `.showcase-item--wide`,
    `.showcase-item--narrow`, `.showcase-frame`,
    `.showcase-nav-preview`, `.showcase-label--block`,
    `.showcase-code--label`, `.showcase-section--last`.

**Changed**
- Removed every page-level inline `style=""` attribute from
  `index.html`, `components.html`, and `partials/footer.html`, replacing
  each with one of the classes above. Visual output is unchanged.
- `assets/icons/README.md` and `assets/images/logo/README.md` updated to
  note which files are now placeholders vs. still missing.

**Documented**
- `.breadcrumbs` (in `css/components.css`) confirmed unused on any
  current page; annotated in place as intentionally reserved for the
  detail pages (Blog Article, Book Detail, Resource Detail) planned in
  Sprint 2+, rather than removed.
- The color-palette swatches and spacing-scale bars in
  `components.html` intentionally keep inline `style=""` — each value
  shown *is* the unique datum being documented, not a repeated pattern.
  Noted in `css/dev-showcase.css`.

**Verified**
- All asset references across `index.html`, `templates/page-template.html`,
  `robots.txt`, and `sitemap.xml` resolve to real files.
- Production domain (`robayerwealthlab.com`) confirmed consistent across
  canonical URLs, Open Graph tags, JSON-LD, `robots.txt`, and
  `sitemap.xml` — no changes needed.
- Home page and the component showcase visually verified against a
  local static server after every change; no layout or color
  regressions.

**Known issue (pre-existing, not touched this sprint)**
- The newsletter form's `.field__error` span is marked `hidden` in
  markup, but `.field__error { display: flex; }` in `components.css`
  overrides the browser's default `[hidden]` behavior, so the error
  message is visible on page load instead of only after a failed
  validation. This predates this cleanup sprint and is left as-is per
  the "no functionality changes" scope — worth a follow-up fix.
  **Resolved as of the Sprint 18/Production Baseline audit:** a
  `.field__error[hidden] { display: none; }` override now exists in
  `components.css` and the error span was verified hidden on page load
  — closing this out, no further action needed.

## Phase 5.1 — Foundation

Initial scalable foundation: design tokens, base reset, layout system,
global components (header/nav/footer/buttons/cards/forms/testimonials),
utilities, vanilla-JS partial-include system, accessibility groundwork
(skip link, focus states, reduced motion, touch targets, mobile menu
a11y), and SEO groundwork (meta tags, Open Graph, Twitter Card,
Organization JSON-LD, `robots.txt`, `sitemap.xml`). Delivered the Home
page (`index.html`) and the internal component showcase
(`components.html`, dev-only). No other real pages yet — see README for
the full open-items list before Sprint 5.2.
