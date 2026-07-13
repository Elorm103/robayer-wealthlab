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
import { handleNewsletter } from '../routes/newsletter';
import { handleContact } from '../routes/contact';
import { handleConsultation } from '../routes/consultation';
import { handleCreateCheckoutSession } from '../routes/checkout';
import { handlePaystackWebhook } from '../routes/webhooks';
import { handleGetPurchaseStatus, handleRequestDownload } from '../routes/purchases';
import { handleDownload } from '../routes/downloads';
import { handleUnsubscribeStatus, handleUnsubscribeConfirm } from '../routes/unsubscribe';
import { handleAdminLogin, handleAdminLogout, handleAdminSession } from '../routes/admin/auth';
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
  // Added Version 2.0 Phase 2 (Products Module) — public site
  // integration. This Worker fully owns `/books/*` via a new Workers
  // Route (wrangler.jsonc) — see routes/books.ts's header comment for
  // why it never falls through to GitHub Pages for any case (index,
  // known slug, unknown slug all render/404 from D1 directly). Ordered
  // last since `/books/*` is the broadest pattern on this table.
  { pattern: new URLPattern({ pathname: '/books/' }), method: 'GET', handler: handleBooksIndex },
  { pattern: new URLPattern({ pathname: '/books/:slug/' }), method: 'GET', handler: handleBookDetail },
  { pattern: new URLPattern({ pathname: '/books/:slug' }), method: 'GET', handler: handleBookRedirect },
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = generateRequestId();
    const url = new URL(request.url);

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
