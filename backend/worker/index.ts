/**
 * Robayer WealthLab — Cloudflare Worker entry point (Version 1.2 Sprint 3,
 * extended Sprint 2.3 with checkout session creation, extended Sprint 2.4
 * with Paystack webhook verification, extended Sprint 2.5 with digital
 * fulfilment).
 *
 * Routes every incoming request via the Workers-native `URLPattern`
 * API (no router dependency — worker/README.md's stated preference),
 * applies CORS, generates one requestId per request (threaded through
 * the logger passed to every route/service, per
 * docs/monitoring-and-alerting.md), and guarantees every response —
 * success, a known error, an unmatched route, or an unhandled
 * exception — comes back through the same standardized envelope
 * (backend/types/api-contracts.ts), never a raw stack trace. The one
 * exception is `GET /api/download/:token`'s success case, which
 * returns the file itself — see routes/downloads.ts.
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
 * Updated — Version 1.0 Launch Readiness pass: every response (including
 * the CORS preflight short-circuit) now also passes through
 * `withSecurityHeaders()` — see middleware/securityHeaders.ts and
 * docs/launch-readiness.md for the full per-header reasoning.
 */

import type { Env } from './env';
import { generateRequestId } from '../utils/requestId';
import { createLogger, type Logger } from '../utils/logger';
import { jsonError } from '../utils/responses';
import { handlePreflight, withCors } from '../middleware/cors';
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
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const preflight = handlePreflight(request, env);
    if (preflight) return withSecurityHeaders(preflight, env);

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

    return withSecurityHeaders(withCors(response, env), env);
  },
};
