# Version 2.0 Phase 0.2 — Admin Component Library

Every reusable class added in `css/admin.css`, and every reusable JS
behavior added in `js/components/admin/`. All of it is additive to the
existing design system (`css/tokens.css`/`base.css`/`layout.css`/
`components.css`/`utilities.css`) — no new colors, spacing, radii, or
type sizes were introduced, and every existing public-site component
(`.btn`, `.card`, `.badge`, `.alert`, `.field`, `.table`,
`.breadcrumbs`, `.icon`) is reused unmodified rather than duplicated.

---

## CSS components (`css/admin.css`)

| Component | Classes | Notes |
|---|---|---|
| Admin shell | `.admin-shell`, `.admin-main`, `.admin-content`, `.admin-include` | The sidebar+topbar+content frame every admin page shares. `.admin-include` is a `display: contents` wrapper so the `[data-include]` partial-loader div (`js/includes.js`) doesn't itself become an unwanted flex item |
| Sidebar | `.admin-sidebar`, `.admin-sidebar__brand`, `.admin-sidebar__nav`, `.admin-sidebar__link` (+ `[aria-current="page"]`), `.admin-sidebar__collapse`, `.admin-sidebar-backdrop` | Collapses to an icon rail on desktop (`.admin-shell[data-sidebar-collapsed="true"]`, persisted via `localStorage`); becomes an off-canvas drawer with a backdrop below the `1200px` breakpoint (this project's existing tablet/desktop line) |
| Topbar | `.admin-topbar`, `.admin-topbar__title`, `.admin-topbar__breadcrumbs` (extends the existing `.breadcrumbs`), `.admin-topbar__menu-toggle`, `.admin-topbar__sidebar-toggle` | Page title and breadcrumb are populated from `<title>` by `admin-shell.js`, not hardcoded per page |
| User menu / dropdown | `.dropdown`, `.dropdown__trigger`, `.dropdown__avatar`, `.dropdown__menu`, `.dropdown__item`, `.dropdown__divider` | Generic enough for any future action menu, not just the user menu — reused as-is wherever a later module needs a dropdown |
| Notification area | `.notification-bell`, `.notification-bell__dot` (`[data-has-notifications]`) | Present, honestly empty — no notification-producing module exists yet |
| Stat card | `.stat-card`, `.stat-card__label`, `.stat-card__icon`, `.stat-card__value` (+ `--muted` for "No data yet"), `.stat-card__meta` | Extends `.card`'s visual language (surface/border/radius/shadow) with a KPI-specific layout |
| Recent activity list | `.admin-activity-list`, `.admin-activity-item` | Generic row-list shape any module's "recent X" panel can reuse |
| Admin table | `.admin-table-wrap` (wraps the existing `.table`), `.admin-table-row-actions` | Adds a card-like frame and sticky header around the already-existing table component — doesn't reimplement table styling |
| Toolbar / search | `.toolbar`, `.toolbar__group`, `.search-bar`, `.search-bar__icon`, `.search-bar__input` | For future list-view filter bars (Products, Orders, etc.) |
| Pagination | `.pagination`, `.pagination__controls`, `.pagination__button` | For future paginated list views |
| Modal / confirmation dialog | `.modal-overlay`, `.modal`, `.modal__header`, `.modal__title`, `.modal__close`, `.modal__body`, `.modal__footer` | One modal shape serves both plain dialogs and confirmation dialogs — no separate "confirm" component, since a confirmation dialog is just a modal with two footer buttons |
| Loading spinner | `.spinner` (+ `--sm`) | Respects `prefers-reduced-motion` (animation removed, not just slowed) |
| Skeleton loader | `.skeleton`, `.skeleton--text`, `.skeleton--title`, `.skeleton--block` | Used today for the dashboard's stat-card values while the real fetch is in flight; respects `prefers-reduced-motion` |
| Empty state | `.empty-state` (+ `--compact`), `.empty-state__icon`, `.empty-state__title`, `.empty-state__body` | Powers both every "Coming soon" module page and the dashboard's "No activity yet" panel — one component, two honest uses (a module that doesn't exist yet vs. a real data source with nothing in it yet) |

Success/error messaging deliberately reuses the existing
`.alert--success`/`.alert--error` rather than inventing new classes —
see `login/index.html`'s server-error alert and `admin-dashboard.js`'s
load-error alert for real usage.

---

## JS components (`js/components/admin/`)

| File | Responsibility | Reused by |
|---|---|---|
| `admin-auth.js` | The only file that calls `/api/admin/auth/*`. Exposes `window.AdminAuth`: `adminFetch()` (credentials + CSRF-aware fetch wrapper, unwraps the standard API envelope into a resolved value or a thrown `Error` with `.code`), `requireSession()` (the actual auth gate — redirects to login on 401), `redirectIfAuthenticated()`, `login()`, `logout()` | Every other admin script; every future module script that needs an authenticated API call |
| `admin-shell.js` | Pure UI: sidebar collapse + persistence, mobile off-canvas nav (open/close/backdrop/Escape/resize), user-menu dropdown (open/close/outside-click/Escape), active nav-link marking, page title/breadcrumb population from `<title>`, wires the logout button to `AdminAuth.logout()` | Every protected admin page (loaded identically on all 13) |
| `admin-login.js` | Drives `admin/login/` specifically: bounces an already-authenticated visitor away, handles the real submit, shows inline errors, redirects to `?next=` or `/admin/` on success | `admin/login/index.html` only |
| `admin-dashboard.js` | Drives `admin/` specifically: fetches `GET /api/admin/dashboard/summary`, renders each stat card from real data or "No data yet", renders recent activity, derives System Status from whether the fetch itself succeeded | `admin/index.html` only |

All four follow this codebase's existing JS convention exactly (see
`docs/v2-admin-shell-architecture.md`'s audit findings): a `data-bound`
guard against double-initialization, binding on `partials:loaded`
(and `DOMContentLoaded` where the target markup isn't inside a
partial), and `[data-x]`-attribute hooks rather than ID-based
selectors wired ad hoc.

---

## What's deliberately not built yet

Nothing here does real CRUD, file upload, search/filter execution, or
pagination logic — the toolbar/search-bar/pagination/modal CSS exists
so the next phase's modules don't have to invent their own, but no
module in this phase actually drives them with real data. That's
Product Management and every module after it, not the Admin Shell.
