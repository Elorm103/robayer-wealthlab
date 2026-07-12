# Version 2.0 — System Architecture

**Grounding:** every decision below builds directly on `docs/v2-platform-audit.md`'s findings — reusing what's real (the Worker, D1, R2, Resend, the design system), extending only where a genuine gap exists (auth, admin routes, upload pipeline, table views). No new hosting, no new framework, no new database.

---

## 1. High-level system diagram

```
┌─────────────────────────────┐         ┌──────────────────────────────────┐
│   Public site (unchanged)    │         │      Admin dashboard (new)        │
│   robayerwealthlab.com       │         │  robayerwealthlab.com/admin/*     │
│   GitHub Pages, static       │         │  Static, same host, same repo     │
└──────────────┬────────────────┘         └────────────────┬───────────────────┘
               │  fetch()                                    │  fetch() + session cookie
               ▼                                              ▼
        ┌──────────────────────────────────────────────────────────────┐
        │        Cloudflare Worker — robayer-wealthlab-api               │
        │  ┌────────────┐  ┌────────────┐  ┌─────────────────────────┐  │
        │  │ Public API │  │ Admin API  │  │  Shared middleware        │  │
        │  │ (existing) │  │ (new,      │  │  CORS · rate-limit ·      │  │
        │  │            │  │  /api/admin│  │  security-headers ·       │  │
        │  │            │  │  /*, auth  │  │  error-handler (existing) │  │
        │  │            │  │  required) │  │  + new: requireAdmin(),   │  │
        │  │            │  │            │  │  CSRF check               │  │
        │  └─────┬──────┘  └─────┬──────┘  └─────────────────────────┘  │
        └────────┼───────────────┼──────────────────────────────────────┘
                 │               │
     ┌───────────┴───┐   ┌───────┴────────┐   ┌────────────────┐
     │ D1 (existing + │   │ R2 (existing,  │   │ Resend / KV     │
     │ new admin      │   │ + admin upload │   │ (existing)      │
     │ tables)        │   │ path)          │   │                 │
     └────────────────┘   └────────────────┘   └────────────────┘
```

**One Worker, not two.** The admin API is a new set of routes on the *same* `robayer-wealthlab-api` Worker, not a separate service — it already has every binding (DB, STORAGE, RATE_LIMIT_KV, RESEND_API_KEY) the admin surface needs. Splitting it into a second Worker would duplicate bindings and secrets for no real benefit at this scale.

**One static site, not two.** `/admin/*` is a new folder in the same GitHub Pages repository, using the same CSS/JS component conventions — not a separate app, not a separate deploy pipeline. This is the same "static frontend + JSON API" pattern already proven for the entire public site.

---

## 2. Folder structure (additions only — nothing existing moves)

```
backend/
├── routes/
│   └── admin/                      # NEW — every admin route lives under here
│       ├── auth.ts                 # login, logout, session check
│       ├── dashboard.ts            # summary KPIs
│       ├── products.ts             # CRUD over content/products/*.json + D1 mirror (see database-expansion doc)
│       ├── blog.ts                 # CMS CRUD
│       ├── resources.ts
│       ├── newsletter.ts           # subscriber list/search/export, campaign send
│       ├── consultations.ts
│       ├── contacts.ts
│       ├── orders.ts               # read-only over purchase_sessions/payment_transactions/deliveries
│       ├── media.ts                # R2 upload/list/delete
│       ├── analytics.ts
│       ├── settings.ts
│       └── users.ts                # admin_users CRUD (super_admin only)
├── services/
│   └── admin/                      # NEW — mirrors routes/admin/ 1:1, same service/route split as today
│       ├── authService.ts
│       ├── sessionService.ts
│       ├── auditService.ts         # the ONE place that ever writes to audit_logs
│       └── ...one per route file, same naming convention as existing services/
├── middleware/
│   ├── requireAuth.ts               # NEW — session validation, attaches the acting admin to the request
│   ├── requireRole.ts               # NEW — role check, used after requireAuth
│   └── csrf.ts                      # NEW
└── database/migrations/
    └── 0006_admin_dashboard.sql     # NEW — see docs/v2-database-expansion.md

admin/                                # NEW — static frontend, sibling to books/, blog/, etc.
├── index.html                       # dashboard home
├── login/index.html
├── products/{index,new,:id}.html    # follows the same folder-per-route convention as checkout/callback/
├── blog/{index,new,:id}.html
├── resources/index.html
├── newsletter/{index,campaigns,subscribers}.html
├── consultations/index.html
├── contacts/index.html
├── orders/index.html
├── media/index.html
├── analytics/index.html
├── settings/index.html
├── users/index.html
└── (a small, new) css/admin.css     # imports the existing 5 token/base/layout/components/utilities files, adds ONLY what a data-dense admin UI needs (table, sidebar-layout, modal) that the public site never needed

js/components/admin/                  # NEW — same [data-x] progressive-enhancement pattern as existing js/components/
├── admin-shell.js                    # sidebar nav, session check on every admin page load
├── data-table.js                     # generic sortable/filterable table — NEW, no equivalent exists today
├── modal.js                          # NEW
├── upload.js                         # drag-drop + progress, wraps the new media API
└── ...one per screen, mirroring the existing calculator-*.js / *-status.js pattern
```

**Why a new `admin.css` instead of extending `components.css` in place:** the public site's CSS has an explicit "every value comes from a token, nothing admin-specific leaks into public pages" discipline. A dashboard needs genuinely new primitives (data tables, a sidebar layout, modals) that no public page will ever use — giving them their own file keeps the public site's CSS bundle unbloated and keeps the two surfaces' concerns separate, while still importing and using every existing token so the visual language is identical, not reinvented.

---

## 3. Navigation hierarchy (admin)

```
Login
└── Dashboard (home)
    ├── Products
    │   ├── List (filter: status, type, category)
    │   ├── New
    │   └── Edit :id (tabs: Details · Pricing · Digital Assets · SEO · Versions)
    ├── Blog
    │   ├── List (filter: status, category, author)
    │   ├── New
    │   └── Edit :id (tabs: Content · SEO · Featured Image · Schedule)
    ├── Resources
    │   └── List (upload/replace/archive inline, no separate edit page — resources are simpler than products/blog)
    ├── Newsletter
    │   ├── Subscribers (search, filter, export)
    │   ├── Campaigns (list, new, history)
    │   └── Unsubscribes (read-only log)
    ├── Consultations
    │   └── List (filter: status, category, assignee) → detail drawer (not a separate page — see UX spec)
    ├── Contacts
    │   └── List → detail drawer
    ├── Orders
    │   └── List (filter: status, product, date range) → detail drawer (purchase + payment + delivery + email history, all read-only + Resend actions)
    ├── Media Library
    │   └── Grid/list toggle, folder filter, search
    ├── Analytics
    │   └── Single page, date-range picker, KPI cards + charts
    ├── Settings
    │   └── Tabs: Business Info · Social · SEO · Brand Assets · Email
    └── Users (super_admin only)
        ├── List
        └── Edit :id (role, active status)
```

## 4. Page hierarchy — URL scheme

Follows the site's own existing convention exactly (folder = route, `index.html` inside it, no query-string routing except where the public site already uses one — e.g. `?token=`): `/admin/`, `/admin/login/`, `/admin/products/`, `/admin/products/new/`, `/admin/products/:id/` (dynamic segment handled client-side via `URLSearchParams`/path parsing, same technique `checkout/callback` already uses for `?ref=`), and so on for every module above.

---

## 5. Security model (summary — full detail in `docs/v2-security-review.md`, `docs/v2-authentication-design.md`, and `docs/v2-same-origin-architecture.md` for the current permanent model)

- **Authentication:** session-cookie based, backed by `admin_users` (already exists) — not JWT, not OAuth. A Worker-issued, HttpOnly, Secure, SameSite=Lax cookie (Lax as of the Version 2.0 Same-Origin Migration — see `docs/v2-same-origin-architecture.md`) referencing a server-side session record (new `admin_sessions` table — see database-expansion doc). Chosen over JWT specifically because sessions can be revoked instantly (log out everywhere, deactivate a user) — a JWT can't be un-issued before it expires.
- **Authorization:** role-based, reusing `admin_users.role`'s existing `super_admin`/`editor`/`support` values — no need to invent a new permission model, the schema already anticipated this.
- **CSRF:** double-submit token pattern (a cookie + a matching header on every mutating request) — no session-storage dependency beyond what already exists.
- **Every admin mutation is audited** via the new `auditService.ts`, writing to the already-existing, already-correctly-shaped `audit_logs` table.
- **Every upload is validated** (content-type allowlist, size limit, filename sanitization) before ever reaching R2 — detailed in the media library spec.

---

## 6. What is explicitly NOT part of this architecture

- No separate admin subdomain (`admin.robayerwealthlab.com`) — adds DNS/cert complexity for zero real benefit at this scale; a path prefix on the existing domain is simpler and just as secure behind proper auth.
- No new database (D1 stays the single source of transactional truth; content stays in `content/*.json` as the source of truth for catalog data — V2.0 extends this pattern, doesn't replace it).
- No GraphQL, no ORM, no new HTTP framework — the existing `URLPattern`-based router already scales to dozens of routes with zero dependency weight; there is no real justification for adding one now.
- No client-side framework (React/Vue/etc.) — the existing progressive-enhancement JS pattern already handles genuinely dynamic UI (Goal Planner, calculators, fulfilment status) at the complexity level this dashboard needs. See `docs/v2-risk-assessment.md` for the one place this judgment call is revisited (the data table component, which is the closest this project has come to needing a framework).
