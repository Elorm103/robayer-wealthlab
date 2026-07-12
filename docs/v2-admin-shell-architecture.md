# Version 2.0 Phase 0.2 — Admin Shell Architecture

**Scope:** the authenticated administration framework every future module reuses — shell layout, navigation, dashboard, empty module pages, reusable component library. Explicitly **not** Product Management or any other module's real functionality — see `docs/v2-development-roadmap.md`'s Phase 1+.

---

## 1. Audit findings (grounded in the real repo, not assumption)

**Frontend has zero build step.** Plain HTML/CSS/JS served by GitHub Pages, no bundler, no package.json at the repo root. Every existing page hand-loads five stylesheets in a fixed order (`tokens.css` → `base.css` → `layout.css` → `components.css` → `utilities.css`) and a fixed script sequence (`includes.js` → component scripts → `content-inject.js` → `main.js`). The admin shell must follow this exact pattern — no new tooling introduced.

**Reusable CSS already covers a meaningful share of what Step 6 asks for**, confirmed by reading `css/components.css` directly rather than assuming: `.btn`/`.btn--primary/--secondary/--accent`, `.card`, `.badge`/`.badge--success/--warning/--error/--info`, `.alert`/`.alert--success/--warning/--error/--info`, `.field`/`.field__label/__input/__select/__textarea/__error/__hint`, `.table` (with alternating rows, `.numeric` alignment), `.breadcrumbs` (defined, unused anywhere yet — the first real consumer is this phase), `.icon` (inline stroke-based SVG, 20px/24px), `.eyebrow`. These are reused as-is, not reinvented.

**Genuinely missing, confirmed by grep across all of `components.css`:** stat cards, data-table chrome beyond the base `<table>` (pagination, toolbar, search), modal, dropdown, confirmation dialog, spinner, skeleton loader, empty-state, and any sidebar/admin-shell layout primitive. These are Step 6's real net-new work.

**JS component convention** (confirmed from `js/includes.js`, `js/components/nav.js`, `js/components/theme-toggle.js`, `js/components/newsletter-form.js`, `js/components/unsubscribe-status.js`): every component self-registers via `document.addEventListener('partials:loaded', initX)` (plus `DOMContentLoaded` for components not inside a partial), guards re-initialization with a `data-bound` attribute, drives visibility through `[data-x-state]`-style hooks toggling `hidden`, and wraps `fetch()` in a small `fetchJson()` helper that throws an `Error` carrying the API's `error.code` for callers to branch on. The admin shell's JS follows this exact convention — no framework, no new pattern invented.

**Partials system**: `partials/header.html` and `partials/footer.html`, injected via `[data-include]` + `includes.js`, firing `partials:loaded`. Two new partials are added the same way: `partials/admin-sidebar.html`, `partials/admin-topbar.html` — reused by every admin page identically, per the "no duplicated navigation" requirement.

**Folder-per-route convention** (confirmed via `checkout/callback/index.html`, `newsletter/unsubscribe/index.html`): a URL segment is a real folder with its own `index.html`. `admin/login/index.html` → `/admin/login/`; `admin/products/index.html` → `/admin/products/`, etc. — exactly what `docs/v2-architecture.md` already specified.

**State-driven page pattern** (confirmed via `checkout/callback/index.html` + `js/components/fulfilment-status.js`): a page ships all of its states (loading/ready/error) as sibling elements marked `hidden`, and JS toggles which one shows based on a real API response — never client-side-only fake states. The dashboard and login page follow this same pattern.

**Backend routes/middleware today** (re-verified against the actual `worker/index.ts` route table): `/api/admin/auth/{login,logout,session}` exist and are deployed to production. `middleware/{requireAuth,requireRole,csrf,rateLimit,cors,securityHeaders,errorHandler}.ts` all exist and are reused unchanged, except for one necessary correction below.

### Critical finding: cross-origin cookie delivery was never actually exercised

Phase 0.1's verification tested the API directly (`curl` against `robayer-wealthlab-api.robayerwealthlab.workers.dev`) — a same-origin context for cookie purposes. Phase 0.2 introduces the first real **cross-origin** consumer: browser pages served from `robayerwealthlab.com` calling that same API via `fetch()`. `SameSite=Strict` cookies are never attached to a cross-site request, regardless of `credentials: 'include'` — so every authenticated request after login would silently arrive with no session cookie, and `requireAuth` would correctly (but confusingly) reject it every time.

**Fix, applied in this phase:** `SameSite=None` on both admin cookies (already `Secure`, which `SameSite=None` requires) — a standard, well-understood pattern for a legitimately cross-origin authenticated API, used because this project's static site and Worker API are, and were always going to be, two different hosts (`docs/v2-migration-strategy.md`'s "one Worker" already meant one *backend*, not one *origin* — the public site itself already calls the same Worker cross-origin for every other endpoint). The actual CSRF defense was never `SameSite` — it's the double-submit `X-CSRF-Token` header (Phase 0.1's own design, unchanged) — so this loses no real protection. `middleware/cors.ts` gains `Access-Control-Allow-Credentials: true` (required for the browser to expose a credentialed cross-origin response to JS at all) and `X-CSRF-Token` added to `Access-Control-Allow-Headers` (required for the preflight to permit that header). Both changes are additive to a shared file; every existing public, credential-less endpoint is unaffected — verified in regression testing.

---

## 2. Design

### Folder structure (new files only)
```
admin/
├── index.html                    # Dashboard
├── login/index.html
├── products/index.html           # Coming Soon
├── media/index.html              # Coming Soon
├── resources/index.html          # Coming Soon
├── blog/index.html               # Coming Soon
├── newsletter/index.html         # Coming Soon
├── orders/index.html             # Coming Soon
├── consultations/index.html      # Coming Soon
├── contacts/index.html           # Coming Soon
├── analytics/index.html          # Coming Soon
├── settings/index.html           # Coming Soon
└── users/index.html              # Coming Soon

partials/
├── admin-sidebar.html            # NEW — shared sidebar nav
└── admin-topbar.html             # NEW — shared topbar (title/breadcrumbs/user menu)

css/
└── admin.css                     # NEW — loaded after utilities.css; shell + component library

js/components/admin/
├── admin-auth.js                 # adminFetch()/getCsrfToken()/requireAdminSession()/logout() — the only file that calls /api/admin/auth/*
├── admin-shell.js                # sidebar collapse, mobile nav, user-menu dropdown, active-link marking — pure UI, no API calls
├── admin-login.js                # drives admin/login/ specifically
└── admin-dashboard.js            # drives admin/ specifically — fetches + renders real KPIs

backend/
├── routes/admin/dashboard.ts     # NEW — GET /api/admin/dashboard/summary
├── services/admin/dashboardService.ts  # NEW — real D1 aggregate queries only
└── middleware/cors.ts            # MODIFIED — Allow-Credentials + X-CSRF-Token
```

### Routing structure
Every admin URL is a real static folder (GitHub Pages convention, matching `checkout/`/`newsletter/`). No client-side router — each page is its own `index.html`, exactly like the rest of the site.

### CSS architecture
Every admin page loads the same five sitewide stylesheets, in the same order, then `admin.css` last — additive, never a fork. `admin.css` references only existing design tokens (no new colors, spacing, radii, or type sizes) so the shell is visually and structurally part of the same design system, and inherits dark mode for free via the existing `[data-theme="dark"]` overrides.

### JS architecture
`admin-auth.js` loads first on every protected page (before the shell renders anything meaningful) and calls `requireAdminSession()`, which does a real `GET /api/admin/auth/session` — on 401, immediately redirects to `/admin/login/?next=<current path>` before any admin content is shown (no flash of protected content). `admin-shell.js` then wires up sidebar/topbar interaction. `admin-login.js` (login page only) does the reverse: if already authenticated, redirects straight to `/admin/` (or `?next=`) instead of showing the form.

### Authentication flow
```
1. Unauthenticated visit to any /admin/* page except /admin/login/
   → admin-auth.js's session check gets 401 → redirect to /admin/login/?next=<path>
2. /admin/login/ → admin-login.js checks session first;
   if already valid → redirect to ?next= or /admin/
3. Submit login form → POST /api/admin/auth/login (credentials: include)
   → success → redirect to ?next= or /admin/
   → failure → inline error, form stays
4. Every admin page load → GET /api/admin/auth/session (credentials: include)
   confirms the session server-side on every navigation — never trusts a
   cached client-side "logged in" flag
5. Logout (topbar user menu) → POST /api/admin/auth/logout with
   X-CSRF-Token → redirect to /admin/login/
```

### Navigation flow
Sidebar: Dashboard, Products, Media Library, Resources, Blog, Newsletter, Orders, Consultations, Contacts, Analytics, Settings, Users — in that order, matching `docs/v2-architecture.md`'s module list. Topbar: page title (set per-page via a `data-page-title` attribute the shell reads), breadcrumbs (reusing the existing `.breadcrumbs` component), user menu (name/role, Logout), a notification-area placeholder (empty today — no notification-producing module exists yet, honestly empty rather than faked).

### Page hierarchy
Dashboard is the only page with real content this phase. Every other module page is an `.empty-state` "Coming Soon" placeholder inside the identical shell — same sidebar, same topbar, same CSS, zero duplication, per the explicit Step 5 requirement.

---

## 3. What Phase 0.2 does NOT do
No product/blog/media/newsletter-campaign/order/consultation/contact/analytics/settings/user CRUD — every one of those modules is a placeholder. No client-side router, no new build tooling, no component framework. No change to the authentication *logic* from Phase 0.1 (login/logout/session/CSRF/rate-limiting/audit-logging semantics are untouched) — only the cookie/CORS correction required to make that logic reachable from a real browser.

---

## 4. Implementation findings (from real local verification, not assumption)

Two real gaps surfaced only once the shell was actually driven through a browser — both fixed, both worth recording since neither was visible from code review alone:

**Every frontend API call in this codebase hardcodes the production Worker URL** (`robayer-wealthlab-api.robayerwealthlab.workers.dev`), confirmed in `newsletter-form.js`, `buy-button.js`, and every other existing component — there is no environment-detection mechanism anywhere in this project. `js/components/admin/admin-auth.js` follows the same convention. This means local verification of any admin flow requires a temporary local override (pointing `API_BASE` at `http://127.0.0.1:8787`) during testing, reverted before commit — the same manual workflow this project has always used for testing API-calling components locally (see `newsletter-form.js`'s own "Update this after deploying the Worker" comment). Documented here so a future session doesn't mistake the hardcoded production URL for an oversight.

**Admin pages never loaded `theme-toggle.js`.** `admin.css` was written entirely against semantic tokens from the start, so dark mode would have worked correctly the moment `[data-theme="dark"]` was ever applied — but no admin page loaded the script that applies it, and the topbar had no toggle button, so a returning dark-mode visitor got no way to see or set that preference inside the admin area at all. Fixed by adding `theme-toggle.js` to every admin page (including `login/`, so a stored preference still renders correctly there even without a toggle button on that page) and a real toggle button in `partials/admin-topbar.html`, reusing the exact same component/localStorage key as the public site — one shared preference, not a separate admin-only setting. Verified live: toggling dark mode correctly re-themes the topbar/content/cards while the sidebar (intentionally, like the public site's own header) stays a fixed dark navy regardless of site theme.

Both fixes are reflected in the file list in Section 2 and in `docs/v2-admin-component-library.md`.
