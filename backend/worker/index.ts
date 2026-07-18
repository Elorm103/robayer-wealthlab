/**
 * Robayer WealthLab — Cloudflare Worker entry point (Version 1.2 Sprint 3,
 * extended Sprint 2.3 with checkout session creation, extended Sprint 2.4
 * with Paystack webhook verification, extended Sprint 2.5 with digital
 * fulfilment).
 *
 * Routes every incoming request via the Workers-native `URLPattern`
 * API (no router dependency — worker/README.md's stated preference),
 * generates one requestId per request (threaded through the logger
 * passed to every route/service, per docs/monitoring-and-alerting.md),
 * and guarantees every response — success, a known error, an unmatched
 * route, or an unhandled exception — comes back through the same
 * standardized envelope (backend/types/api-contracts.ts), never a raw
 * stack trace. The one exception is `GET /api/download/:token`'s
 * success case, which returns the file itself — see routes/downloads.ts.
 *
 * Updated Version 1.2 Sprint 2.5: dispatch now uses `URLPattern.exec()`
 * instead of `.test()`, so routes with dynamic segments (`:reference`,
 * `:token`) can extract them. `RouteHandler` gained a fourth `params`
 * argument; every pre-existing handler (newsletter/contact/consultation/
 * checkout/webhooks) still satisfies the type without any change to
 * those files — TypeScript allows assigning a function with fewer
 * parameters to a type expecting more, since JavaScript itself ignores
 * extra arguments a function doesn't declare.
 *
 * Updated — Version 1.0 Launch Readiness pass: every response now also
 * passes through `withSecurityHeaders()` — see
 * middleware/securityHeaders.ts and docs/launch-readiness.md for the
 * full per-header reasoning.
 *
 * Updated — Version 2.0 Same-Origin Migration: CORS handling (the
 * former middleware/cors.ts) removed entirely. The frontend and this
 * Worker are now served from the same origin (robayerwealthlab.com,
 * via the Cloudflare Workers Route in wrangler.jsonc's `routes`) —
 * same-origin fetch() requests never trigger CORS in the browser at
 * all, confirmed live (zero preflight OPTIONS requests observed — see
 * docs/v2-same-origin-migration-audit.md). The one caller that was
 * ever genuinely cross-origin (Paystack's webhook POST) is a
 * server-to-server request, never subject to browser CORS enforcement
 * in the first place — its access control has always been signature
 * verification (utils/webhookSignature.ts), unrelated to this.
 */

import type { Env } from './env';
import { generateRequestId } from '../utils/requestId';
import { createLogger, type Logger } from '../utils/logger';
import { jsonError } from '../utils/responses';
import { withSecurityHeaders } from '../middleware/securityHeaders';
import { withErrorHandling } from '../middleware/errorHandler';
import { checkMaintenanceMode } from '../middleware/maintenanceMode';
import { handleNewsletter } from '../routes/newsletter';
import { handleContact } from '../routes/contact';
import { handleConsultation } from '../routes/consultation';
import { handleCreateCheckoutSession } from '../routes/checkout';
import { handlePaystackWebhook } from '../routes/webhooks';
import { handleGetPurchaseStatus, handleRequestDownload } from '../routes/purchases';
import { handleDownload } from '../routes/downloads';
import { handleUnsubscribeStatus, handleUnsubscribeConfirm } from '../routes/unsubscribe';
import {
  handleAdminLogin,
  handleAdminLogout,
  handleAdminSession,
  handleChangePassword,
  handleForgotPassword,
  handleResetPassword,
  handleListSessions,
  handleRevokeSession,
  handleLoginHistory,
} from '../routes/admin/auth';
import {
  handleListAdmins,
  handleGetAdmin,
  handleInviteAdmin,
  handleResendInvite,
  handleCancelInvite,
  handleEditAdmin,
  handleDisableAdmin,
  handleReactivateAdmin,
  handleDeleteAdmin,
  handleForcePasswordReset,
  handleForcePasswordChange,
  handleForceLogout,
  handleUnlockAdmin,
  handleValidateInvite,
  handleAcceptInvite,
} from '../routes/admin/users';
import { handleGetSettings, handleUpdateSettings, handleSettingsStatus } from '../routes/admin/settings';
import { handleAdminDashboardSummary } from '../routes/admin/dashboard';
import { handleHealth } from '../routes/health';
import {
  handleMediaUpload,
  handleMediaList,
  handleMediaGet,
  handleMediaUpdate,
  handleMediaReplace,
  handleMediaDelete,
  handleMediaRestore,
} from '../routes/admin/media';
import { handleMediaFile } from '../routes/media';
import {
  handleProductsMeta,
  handleProductsList,
  handleProductGet,
  handleProductCreate,
  handleProductUpdate,
  handleProductStatusTransition,
  handleProductDuplicate,
  handleProductDelete,
  handleProductRestore,
  handleProductFilesUpdate,
  handleProductGalleryUpdate,
  handleProductRelationsUpdate,
  handleProductsBulkAction,
} from '../routes/admin/products';
import { handlePublicProductsList, handlePublicProductGet } from '../routes/products';
import { handleBooksIndex, handleBookDetail, handleBookRedirect } from '../routes/books';
import {
  handleConsultationsMeta,
  handleConsultationsList,
  handleConsultationGet,
  handleConsultationUpdate,
  handleConsultationAddNote,
} from '../routes/admin/consultations';
import {
  handleContactsMeta,
  handleContactsList,
  handleContactGet,
  handleContactUpdate,
  handleContactAddNote,
} from '../routes/admin/contacts';
import {
  handleOrdersMeta,
  handleOrdersList,
  handleOrderGet,
  handleOrderResendReceipt,
  handleOrderResendDownload,
} from '../routes/admin/orders';
import {
  handleAnalyticsSummary,
  handleAnalyticsTimeseries,
  handleAnalyticsTopProducts,
} from '../routes/admin/analytics';
import {
  handleResourcesMeta,
  handleResourcesList,
  handleResourceGet,
  handleResourceCreate,
  handleResourceUpdate,
  handleResourceStatusTransition,
  handleResourceDuplicate,
  handleResourceDelete,
  handleResourceRestore,
  handleResourcesBulkAction,
} from '../routes/admin/resources';
import { handleResourcesIndex, handleResourceDownloadRoute } from '../routes/resources';
import {
  handleBlogMeta,
  handleBlogList,
  handleBlogGet,
  handleBlogCreate,
  handleBlogUpdate,
  handleBlogStatusTransition,
  handleBlogDuplicate,
  handleBlogDelete,
  handleBlogRestore,
  handleBlogBulkAction,
} from '../routes/admin/blog';
import { handleBlogIndex, handleBlogDetail, handleBlogRedirect } from '../routes/blog';

export type { Env };

export type RouteParams = Record<string, string | undefined>;

type RouteHandler = (request: Request, env: Env, logger: Logger, params: RouteParams) => Promise<Response>;

interface Route {
  pattern: URLPattern;
  method: string;
  handler: RouteHandler;
}

const ROUTES: Route[] = [
  { pattern: new URLPattern({ pathname: '/api/newsletter' }), method: 'POST', handler: handleNewsletter },
  { pattern: new URLPattern({ pathname: '/api/contact' }), method: 'POST', handler: handleContact },
  { pattern: new URLPattern({ pathname: '/api/consultation' }), method: 'POST', handler: handleConsultation },
  { pattern: new URLPattern({ pathname: '/api/checkout/sessions' }), method: 'POST', handler: handleCreateCheckoutSession },
  // Deliberately NOT rate-limited like the form/checkout endpoints —
  // signature verification (routes/webhooks.ts) is this endpoint's
  // access control; Paystack's own delivery can legitimately be
  // bursty (many events in quick succession during a sale), and a
  // per-IP rate limit would risk dropping genuine webhook deliveries.
  // See docs/payment-verification.md's "Webhook security."
  { pattern: new URLPattern({ pathname: '/api/webhooks/paystack' }), method: 'POST', handler: handlePaystackWebhook },
  // Added Version 1.2 Sprint 2.5 (Digital Fulfilment Platform) — see
  // docs/digital-fulfilment.md.
  { pattern: new URLPattern({ pathname: '/api/purchases/:reference' }), method: 'GET', handler: handleGetPurchaseStatus },
  { pattern: new URLPattern({ pathname: '/api/purchases/:reference/downloads' }), method: 'POST', handler: handleRequestDownload },
  { pattern: new URLPattern({ pathname: '/api/download/:token' }), method: 'GET', handler: handleDownload },
  // Added for newsletter compliance — docs/newsletter-unsubscribe-design.md.
  // GET is a safe, non-mutating status check; POST is the actual
  // confirm action (also what Resend's List-Unsubscribe-Post header
  // points mail clients' native one-click button at).
  { pattern: new URLPattern({ pathname: '/api/newsletter/unsubscribe/:token' }), method: 'GET', handler: handleUnsubscribeStatus },
  { pattern: new URLPattern({ pathname: '/api/newsletter/unsubscribe/:token' }), method: 'POST', handler: handleUnsubscribeConfirm },
  // Added Version 2.0 Phase 0.1 (Authentication Foundation) — see
  // docs/v2-authentication-design.md. The only /api/admin/* routes that
  // exist so far; every other admin module remains out of scope until
  // its own phase.
  { pattern: new URLPattern({ pathname: '/api/admin/auth/login' }), method: 'POST', handler: handleAdminLogin },
  { pattern: new URLPattern({ pathname: '/api/admin/auth/logout' }), method: 'POST', handler: handleAdminLogout },
  { pattern: new URLPattern({ pathname: '/api/admin/auth/session' }), method: 'GET', handler: handleAdminSession },
  // Added Version 2.1 Phase 3 (Identity & Security) — see
  // docs/v2.1-architecture-plan.md Section 6 and
  // docs/v2.1-phase3-implementation.md.
  { pattern: new URLPattern({ pathname: '/api/admin/auth/change-password' }), method: 'POST', handler: handleChangePassword },
  { pattern: new URLPattern({ pathname: '/api/admin/auth/forgot-password' }), method: 'POST', handler: handleForgotPassword },
  { pattern: new URLPattern({ pathname: '/api/admin/auth/reset-password' }), method: 'POST', handler: handleResetPassword },
  { pattern: new URLPattern({ pathname: '/api/admin/auth/sessions' }), method: 'GET', handler: handleListSessions },
  { pattern: new URLPattern({ pathname: '/api/admin/auth/sessions/:id/revoke' }), method: 'POST', handler: handleRevokeSession },
  { pattern: new URLPattern({ pathname: '/api/admin/auth/login-history' }), method: 'GET', handler: handleLoginHistory },
  // Public, unauthenticated — Version 2.1 Phase 4 (User Management).
  // Grouped with the other public admin-auth flows (forgot/reset-
  // password) since an invitee has no session yet; handlers live in
  // routes/admin/users.ts to keep every user-management concern in one
  // file. See docs/v2.1-phase4-design.md.
  { pattern: new URLPattern({ pathname: '/api/admin/auth/accept-invite' }), method: 'GET', handler: handleValidateInvite },
  { pattern: new URLPattern({ pathname: '/api/admin/auth/accept-invite' }), method: 'POST', handler: handleAcceptInvite },
  // Added Version 2.0 Phase 0.2 (Admin Shell) — see
  // docs/v2-admin-shell-architecture.md. The dashboard's only real data
  // source; every other admin module route remains out of scope until
  // its own phase.
  { pattern: new URLPattern({ pathname: '/api/admin/dashboard/summary' }), method: 'GET', handler: handleAdminDashboardSummary },
  // Same-Origin Routing Proof of Concept (docs/v2-same-origin-routing-poc.md)
  // — the first thing verified through the new robayerwealthlab.com/api/*
  // Workers Route, before anything that touches real state.
  { pattern: new URLPattern({ pathname: '/api/health' }), method: 'GET', handler: handleHealth },
  // Added Version 2.0 Phase 1 (Media Library) — see
  // docs/v2-media-library-spec.md. Ordered before the public file
  // route below so a future collision between an admin sub-path and a
  // storage key can never happen (they're disjoint prefixes anyway,
  // but explicit order removes any doubt).
  { pattern: new URLPattern({ pathname: '/api/admin/media' }), method: 'POST', handler: handleMediaUpload },
  { pattern: new URLPattern({ pathname: '/api/admin/media' }), method: 'GET', handler: handleMediaList },
  { pattern: new URLPattern({ pathname: '/api/admin/media/:id' }), method: 'GET', handler: handleMediaGet },
  { pattern: new URLPattern({ pathname: '/api/admin/media/:id' }), method: 'PATCH', handler: handleMediaUpdate },
  { pattern: new URLPattern({ pathname: '/api/admin/media/:id/replace' }), method: 'POST', handler: handleMediaReplace },
  { pattern: new URLPattern({ pathname: '/api/admin/media/:id' }), method: 'DELETE', handler: handleMediaDelete },
  { pattern: new URLPattern({ pathname: '/api/admin/media/:id/restore' }), method: 'POST', handler: handleMediaRestore },
  // Public — no auth, matching assets/covers/*.png's existing trust
  // model. `:key(.*)` captures the full remaining path including
  // slashes, since a real storage key is itself a path
  // (media/images/books/<uuid>.jpg) — see routes/media.ts.
  { pattern: new URLPattern({ pathname: '/api/media/file/:key(.*)' }), method: 'GET', handler: handleMediaFile },
  // Added Version 2.0 Phase 2 (Products Module) — see
  // docs/products-module-implementation.md. `/api/admin/products/meta` and
  // `/api/admin/products/bulk` are ordered before `/api/admin/products/:id`
  // so their literal path never gets swallowed as an `:id` value by the
  // dynamic route below (first-match-wins array order).
  { pattern: new URLPattern({ pathname: '/api/admin/products/meta' }), method: 'GET', handler: handleProductsMeta },
  { pattern: new URLPattern({ pathname: '/api/admin/products/bulk' }), method: 'POST', handler: handleProductsBulkAction },
  { pattern: new URLPattern({ pathname: '/api/admin/products' }), method: 'GET', handler: handleProductsList },
  { pattern: new URLPattern({ pathname: '/api/admin/products' }), method: 'POST', handler: handleProductCreate },
  { pattern: new URLPattern({ pathname: '/api/admin/products/:id' }), method: 'GET', handler: handleProductGet },
  { pattern: new URLPattern({ pathname: '/api/admin/products/:id' }), method: 'PATCH', handler: handleProductUpdate },
  { pattern: new URLPattern({ pathname: '/api/admin/products/:id' }), method: 'DELETE', handler: handleProductDelete },
  { pattern: new URLPattern({ pathname: '/api/admin/products/:id/restore' }), method: 'POST', handler: handleProductRestore },
  { pattern: new URLPattern({ pathname: '/api/admin/products/:id/duplicate' }), method: 'POST', handler: handleProductDuplicate },
  { pattern: new URLPattern({ pathname: '/api/admin/products/:id/status' }), method: 'POST', handler: handleProductStatusTransition },
  { pattern: new URLPattern({ pathname: '/api/admin/products/:id/files' }), method: 'PUT', handler: handleProductFilesUpdate },
  { pattern: new URLPattern({ pathname: '/api/admin/products/:id/gallery' }), method: 'PUT', handler: handleProductGalleryUpdate },
  { pattern: new URLPattern({ pathname: '/api/admin/products/:id/relations' }), method: 'PUT', handler: handleProductRelationsUpdate },
  // Public — no auth, only publicly-listed statuses. Ordered after the
  // admin routes above for readability; no collision risk since the
  // path prefixes are disjoint (`/api/admin/products` vs `/api/products`).
  { pattern: new URLPattern({ pathname: '/api/products' }), method: 'GET', handler: handlePublicProductsList },
  { pattern: new URLPattern({ pathname: '/api/products/:slug' }), method: 'GET', handler: handlePublicProductGet },
  // Added Version 2.0 Phase 3 (Operational Visibility — Consultation
  // Manager) — see docs/v2.0-phase3-architecture-plan.md. Every route
  // here is open to all three authenticated roles (including `support`)
  // for both reads and writes — see routes/admin/consultations.ts's
  // header comment for why this deliberately differs from Products'
  // editor-only-writes convention.
  // /meta ordered before /:id so the literal path never gets swallowed
  // as an :id value by the dynamic route below (first-match-wins array
  // order) — same discipline as Products' own /meta and /bulk routes.
  { pattern: new URLPattern({ pathname: '/api/admin/consultations/meta' }), method: 'GET', handler: handleConsultationsMeta },
  { pattern: new URLPattern({ pathname: '/api/admin/consultations' }), method: 'GET', handler: handleConsultationsList },
  { pattern: new URLPattern({ pathname: '/api/admin/consultations/:id' }), method: 'GET', handler: handleConsultationGet },
  { pattern: new URLPattern({ pathname: '/api/admin/consultations/:id' }), method: 'PATCH', handler: handleConsultationUpdate },
  { pattern: new URLPattern({ pathname: '/api/admin/consultations/:id/notes' }), method: 'POST', handler: handleConsultationAddNote },

  { pattern: new URLPattern({ pathname: '/api/admin/contacts/meta' }), method: 'GET', handler: handleContactsMeta },
  { pattern: new URLPattern({ pathname: '/api/admin/contacts' }), method: 'GET', handler: handleContactsList },
  { pattern: new URLPattern({ pathname: '/api/admin/contacts/:id' }), method: 'GET', handler: handleContactGet },
  { pattern: new URLPattern({ pathname: '/api/admin/contacts/:id' }), method: 'PATCH', handler: handleContactUpdate },
  { pattern: new URLPattern({ pathname: '/api/admin/contacts/:id/notes' }), method: 'POST', handler: handleContactAddNote },
  // Orders (Phase 3 Stage 3) — `/meta` ordered before `/:reference`,
  // same reasoning as consultations/contacts above.
  { pattern: new URLPattern({ pathname: '/api/admin/orders/meta' }), method: 'GET', handler: handleOrdersMeta },
  { pattern: new URLPattern({ pathname: '/api/admin/orders' }), method: 'GET', handler: handleOrdersList },
  { pattern: new URLPattern({ pathname: '/api/admin/orders/:reference' }), method: 'GET', handler: handleOrderGet },
  { pattern: new URLPattern({ pathname: '/api/admin/orders/:reference/resend-receipt' }), method: 'POST', handler: handleOrderResendReceipt },
  { pattern: new URLPattern({ pathname: '/api/admin/orders/:reference/resend-download' }), method: 'POST', handler: handleOrderResendDownload },
  // Analytics (Phase 3 Stage 4) — read-only, no role gate beyond auth.
  { pattern: new URLPattern({ pathname: '/api/admin/analytics/summary' }), method: 'GET', handler: handleAnalyticsSummary },
  { pattern: new URLPattern({ pathname: '/api/admin/analytics/timeseries' }), method: 'GET', handler: handleAnalyticsTimeseries },
  { pattern: new URLPattern({ pathname: '/api/admin/analytics/top-products' }), method: 'GET', handler: handleAnalyticsTopProducts },
  // Added Version 2.1 Phase 1 (Resources CMS) — see
  // docs/v2.1-architecture-plan.md Section 3. Mirrors Products' exact
  // admin route shape (editor/super_admin writes, every role reads);
  // `/meta` and `/bulk` ordered before `/:id`, same discipline as
  // Products/Orders/Consultations above.
  { pattern: new URLPattern({ pathname: '/api/admin/resources/meta' }), method: 'GET', handler: handleResourcesMeta },
  { pattern: new URLPattern({ pathname: '/api/admin/resources/bulk' }), method: 'POST', handler: handleResourcesBulkAction },
  { pattern: new URLPattern({ pathname: '/api/admin/resources' }), method: 'GET', handler: handleResourcesList },
  { pattern: new URLPattern({ pathname: '/api/admin/resources' }), method: 'POST', handler: handleResourceCreate },
  { pattern: new URLPattern({ pathname: '/api/admin/resources/:id' }), method: 'GET', handler: handleResourceGet },
  { pattern: new URLPattern({ pathname: '/api/admin/resources/:id' }), method: 'PATCH', handler: handleResourceUpdate },
  { pattern: new URLPattern({ pathname: '/api/admin/resources/:id' }), method: 'DELETE', handler: handleResourceDelete },
  { pattern: new URLPattern({ pathname: '/api/admin/resources/:id/restore' }), method: 'POST', handler: handleResourceRestore },
  { pattern: new URLPattern({ pathname: '/api/admin/resources/:id/duplicate' }), method: 'POST', handler: handleResourceDuplicate },
  { pattern: new URLPattern({ pathname: '/api/admin/resources/:id/status' }), method: 'POST', handler: handleResourceStatusTransition },
  // Added Version 2.1 Phase 2 (Blog CMS) — see
  // docs/v2.1-architecture-plan.md Section 4. Same admin route shape
  // as Resources; `/meta` and `/bulk` ordered before `/:id`.
  { pattern: new URLPattern({ pathname: '/api/admin/blog/meta' }), method: 'GET', handler: handleBlogMeta },
  { pattern: new URLPattern({ pathname: '/api/admin/blog/bulk' }), method: 'POST', handler: handleBlogBulkAction },
  { pattern: new URLPattern({ pathname: '/api/admin/blog' }), method: 'GET', handler: handleBlogList },
  { pattern: new URLPattern({ pathname: '/api/admin/blog' }), method: 'POST', handler: handleBlogCreate },
  { pattern: new URLPattern({ pathname: '/api/admin/blog/:id' }), method: 'GET', handler: handleBlogGet },
  { pattern: new URLPattern({ pathname: '/api/admin/blog/:id' }), method: 'PATCH', handler: handleBlogUpdate },
  { pattern: new URLPattern({ pathname: '/api/admin/blog/:id' }), method: 'DELETE', handler: handleBlogDelete },
  { pattern: new URLPattern({ pathname: '/api/admin/blog/:id/restore' }), method: 'POST', handler: handleBlogRestore },
  { pattern: new URLPattern({ pathname: '/api/admin/blog/:id/duplicate' }), method: 'POST', handler: handleBlogDuplicate },
  { pattern: new URLPattern({ pathname: '/api/admin/blog/:id/status' }), method: 'POST', handler: handleBlogStatusTransition },
  // Added Version 2.1 Phase 4 (User Management) — see
  // docs/v2.1-phase4-design.md. super_admin-only (enforced inside each
  // handler, not by this table). Static paths (`/invite`,
  // `/invites/:id/...`) ordered before the `/:id` wildcard so `invite`
  // and `invites` are never mistaken for an admin id.
  { pattern: new URLPattern({ pathname: '/api/admin/users' }), method: 'GET', handler: handleListAdmins },
  { pattern: new URLPattern({ pathname: '/api/admin/users/invite' }), method: 'POST', handler: handleInviteAdmin },
  { pattern: new URLPattern({ pathname: '/api/admin/users/invites/:id/resend' }), method: 'POST', handler: handleResendInvite },
  { pattern: new URLPattern({ pathname: '/api/admin/users/invites/:id' }), method: 'DELETE', handler: handleCancelInvite },
  { pattern: new URLPattern({ pathname: '/api/admin/users/:id' }), method: 'GET', handler: handleGetAdmin },
  { pattern: new URLPattern({ pathname: '/api/admin/users/:id' }), method: 'PATCH', handler: handleEditAdmin },
  { pattern: new URLPattern({ pathname: '/api/admin/users/:id' }), method: 'DELETE', handler: handleDeleteAdmin },
  { pattern: new URLPattern({ pathname: '/api/admin/users/:id/disable' }), method: 'POST', handler: handleDisableAdmin },
  { pattern: new URLPattern({ pathname: '/api/admin/users/:id/reactivate' }), method: 'POST', handler: handleReactivateAdmin },
  { pattern: new URLPattern({ pathname: '/api/admin/users/:id/force-password-reset' }), method: 'POST', handler: handleForcePasswordReset },
  { pattern: new URLPattern({ pathname: '/api/admin/users/:id/force-password-change' }), method: 'POST', handler: handleForcePasswordChange },
  { pattern: new URLPattern({ pathname: '/api/admin/users/:id/force-logout' }), method: 'POST', handler: handleForceLogout },
  { pattern: new URLPattern({ pathname: '/api/admin/users/:id/unlock' }), method: 'POST', handler: handleUnlockAdmin },
  // Added Version 2.1 Phase 5 (Settings) — see
  // docs/v2.1-phase5-design.md. super_admin-only for reads and writes
  // alike (enforced inside each handler, not by this table).
  { pattern: new URLPattern({ pathname: '/api/admin/settings' }), method: 'GET', handler: handleGetSettings },
  { pattern: new URLPattern({ pathname: '/api/admin/settings' }), method: 'PATCH', handler: handleUpdateSettings },
  { pattern: new URLPattern({ pathname: '/api/admin/settings/status' }), method: 'GET', handler: handleSettingsStatus },
  // Added Version 2.0 Phase 2 (Products Module) — public site
  // integration. This Worker fully owns `/books/*` via a new Workers
  // Route (wrangler.jsonc) — see routes/books.ts's header comment for
  // why it never falls through to GitHub Pages for any case (index,
  // known slug, unknown slug all render/404 from D1 directly). Ordered
  // last since `/books/*` is the broadest pattern on this table.
  { pattern: new URLPattern({ pathname: '/books/' }), method: 'GET', handler: handleBooksIndex },
  { pattern: new URLPattern({ pathname: '/books/:slug/' }), method: 'GET', handler: handleBookDetail },
  { pattern: new URLPattern({ pathname: '/books/:slug' }), method: 'GET', handler: handleBookRedirect },
  // Added Version 2.1 Phase 1 (Resources CMS) — public site
  // integration, identical `/books/*` Workers Route pattern. `/download`
  // ordered before the (nonexistent) detail pattern since Resources has
  // no per-resource detail page — only the index and a real download
  // action, matching this content type's simpler, single-file shape.
  { pattern: new URLPattern({ pathname: '/resources/' }), method: 'GET', handler: handleResourcesIndex },
  { pattern: new URLPattern({ pathname: '/resources/:slug/download' }), method: 'GET', handler: handleResourceDownloadRoute },
  // Added Version 2.1 Phase 2 (Blog CMS) — public site integration,
  // identical `/books/*`/`/resources/*` Workers Route pattern. Has a
  // real per-post detail page (unlike Resources) — mirrors `/books/*`'s
  // shape exactly.
  { pattern: new URLPattern({ pathname: '/blog/' }), method: 'GET', handler: handleBlogIndex },
  { pattern: new URLPattern({ pathname: '/blog/:slug/' }), method: 'GET', handler: handleBlogDetail },
  { pattern: new URLPattern({ pathname: '/blog/:slug' }), method: 'GET', handler: handleBlogRedirect },
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = generateRequestId();
    const url = new URL(request.url);

    // Checked before route matching — see middleware/maintenanceMode.ts's
    // header comment for exactly which paths this gates and why
    // /api/admin/*, /api/webhooks/*, and /api/health are exempt.
    const maintenanceResponse = await checkMaintenanceMode(request, env);
    if (maintenanceResponse) return withSecurityHeaders(maintenanceResponse, env);

    let matchedRoute: Route | undefined;
    let params: RouteParams = {};
    for (const candidate of ROUTES) {
      if (candidate.method !== request.method) continue;
      const match = candidate.pattern.exec(request.url);
      if (match) {
        matchedRoute = candidate;
        params = match.pathname.groups;
        break;
      }
    }

    const logger = createLogger(requestId, `${request.method} ${url.pathname}`);

    const response = matchedRoute
      ? await withErrorHandling(() => matchedRoute.handler(request, env, logger, params), logger, requestId)
      : jsonError('NOT_FOUND', 'Not found.');

    return withSecurityHeaders(response, env);
  },
};
