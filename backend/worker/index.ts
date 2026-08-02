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
import { handleAnalyticsEvent } from '../routes/analytics';
import { handleContact } from '../routes/contact';
import { handleConsultation } from '../routes/consultation';
import { handleCreateCheckoutSession } from '../routes/checkout';
import { handlePaystackWebhook } from '../routes/webhooks';
import { handleGetPurchaseStatus, handleRequestDownload, handleRequestReceiptDownload } from '../routes/purchases';
import { handleDownload, handleDownloadReceipt } from '../routes/downloads';
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
import {
  handleListCampaigns,
  handleGetCampaign,
  handleSubscribedCount,
  handleCreateCampaign,
  handleUpdateCampaign,
  handleDeleteCampaign,
  handleTestCampaign,
  handleSendCampaign,
  handleResumeCampaign,
} from '../routes/admin/newsletterCampaigns';
import { handleAdminDashboardSummary } from '../routes/admin/dashboard';
import {
  handleDashboardHealth,
  handleDashboardExecutiveSummary,
  handleDashboardCharts,
  handleDashboardCustomerInsights,
  handleDashboardOperational,
  handleDashboardAlerts,
  handleDashboardTraffic,
  handleDashboardEmailLifecycle,
} from '../routes/admin/executiveDashboard';
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
import { handleGetBranding, handleUpdateBranding } from '../routes/admin/branding';
import { handleGetPublicBranding } from '../routes/branding';
import { handleGetPublicHero } from '../routes/hero';
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
  handleProductBundleItemsUpdate,
  handleProductsBulkAction,
} from '../routes/admin/products';
import { handlePublicProductsList, handlePublicProductGet } from '../routes/products';
import { handleBooksIndex, handleBookDetail, handleBookRedirect } from '../routes/books';
import { handleHomepage } from '../routes/home';
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
  handleOrderRefund,
} from '../routes/admin/orders';
import {
  handleAnalyticsSummary,
  handleAnalyticsTimeseries,
  handleAnalyticsTopProducts,
  handleAnalyticsActivationSummary,
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
import { handleResourcesIndex, handleResourceDownloadRoute, handleGetFeaturedResource } from '../routes/resources';
import { handleFreeGuideIndex } from '../routes/free-guide';
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
// Added Version 3.0.2 Milestone M1 (Customer Identity & Guest Checkout)
// — see docs/v3.0.2-commerce-architecture-blueprint.md. The only
// customer-facing auth routes in this milestone; no public
// registration endpoint exists (ADR-006).
import {
  handleCustomerLogin,
  handleCustomerLogout,
  handleCustomerSession,
  handleCustomerForgotPassword,
  handleCustomerSetPassword,
  handleCustomerChangePassword,
} from '../routes/customer/auth';
// Version 3.0.2 Milestone M2 (Orders, Receipts & Customer Library) —
// the Customer Library's data layer. See
// docs/v3.0.2-m2-api-planning-report.md.
import {
  handleListCustomerPurchases,
  handleGetCustomerPurchase,
  handleListCustomerReceipts,
  handleDownloadCustomerReceipt,
  handleListCustomerLicenses,
} from '../routes/customer/purchases';
// Version 3.1 Milestone M3 (Checkout Auto-Provisioning & Dashboard
// MVP) — Account Security's own-sessions list/revoke. See
// docs/v3.1-m3-api-gap-analysis.md's Gap 3.
import { handleListCustomerSessions, handleRevokeCustomerSession } from '../routes/customer/sessions';
// Version 3.2 Milestone M4 (Commerce & Trust Foundations) — Product
// Reviews. See docs/v3.2-m4-scope-recommendation.md.
import { handleListPublicReviews } from '../routes/reviews';
import { handleListCustomerOwnReviews, handleSubmitReview, handleDeleteOwnReview } from '../routes/customer/reviews';
import { handleAdminReviewsList, handleAdminReviewModerate } from '../routes/admin/reviews';
// Version 3.2 Milestone M4 — Coupon Engine, schema corrected per the
// M4B Required Amendment 1 (docs/v3.2-m4c-amendment-1-resolution.md).
import { handleValidateCoupon } from '../routes/coupons';
import { handleAdminCouponsList, handleAdminCouponCreate, handleAdminCouponUpdate } from '../routes/admin/coupons';
// Version 3.3 Milestone M5C (Activation, Analytics and Customer
// Reconciliation) — historical guest-purchase account claiming. See
// docs/v3.3-m5c-customer-reconciliation-architecture.md. A second,
// still-ADR-006-compliant call site alongside the auth.ts import
// above — see routes/customer/reconciliation.ts's own header comment.
import { handleCustomerReconcilePurchases } from '../routes/customer/reconciliation';
// Version 3.3 Milestone M5C Phase 5 (Review Lifecycle) — the
// email-linked opt-out action. See routes/customer/reviewReminders.ts.
import { handleReviewReminderOptOut } from '../routes/customer/reviewReminders';
import { sendDueReviewReminders } from '../services/customer/reviewReminderService';
// Version 4.0 Milestone C1 (Core Email Lifecycle) — same shape as the
// review-reminder pair immediately above; runs on the same Cron
// Trigger, not a new one.
import { handlePurchaseFollowupOptOut } from '../routes/customer/purchaseFollowup';
import { sendDuePurchaseFollowups } from '../services/customer/purchaseFollowupService';
import { record as recordAuditEvent } from '../services/admin/auditService';

export type { Env };

export type RouteParams = Record<string, string | undefined>;

// `ctx` (5th param) added in Version 2.1 Phase 6 (Newsletter
// Campaigns) — the campaign send/resume handlers need
// `ctx.waitUntil()` to run their recipient loop past the point the
// HTTP response is returned (see docs/v2.1-phase6-design.md's §4).
// Every pre-existing handler, declared with 4 params, still satisfies
// this wider type unchanged — the same "fewer params than the type
// expects" allowance already used when `params` itself was added.
type RouteHandler = (request: Request, env: Env, logger: Logger, params: RouteParams, ctx: ExecutionContext) => Promise<Response>;

interface Route {
  pattern: URLPattern;
  method: string;
  handler: RouteHandler;
}

const ROUTES: Route[] = [
  { pattern: new URLPattern({ pathname: '/api/newsletter' }), method: 'POST', handler: handleNewsletter },
  { pattern: new URLPattern({ pathname: '/api/analytics/event' }), method: 'POST', handler: handleAnalyticsEvent },
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
  // Milestone M2 (Orders, Receipts & Customer Library) — guest,
  // reference-scoped receipt download (ADR-013 tier 2).
  { pattern: new URLPattern({ pathname: '/api/purchases/:reference/receipt-download' }), method: 'POST', handler: handleRequestReceiptDownload },
  { pattern: new URLPattern({ pathname: '/api/download-receipt/:token' }), method: 'GET', handler: handleDownloadReceipt },
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
  // Version 3.5 (Executive Dashboard & Business Intelligence).
  { pattern: new URLPattern({ pathname: '/api/admin/dashboard/health' }), method: 'GET', handler: handleDashboardHealth },
  { pattern: new URLPattern({ pathname: '/api/admin/dashboard/executive-summary' }), method: 'GET', handler: handleDashboardExecutiveSummary },
  { pattern: new URLPattern({ pathname: '/api/admin/dashboard/charts' }), method: 'GET', handler: handleDashboardCharts },
  { pattern: new URLPattern({ pathname: '/api/admin/dashboard/customer-insights' }), method: 'GET', handler: handleDashboardCustomerInsights },
  { pattern: new URLPattern({ pathname: '/api/admin/dashboard/operational' }), method: 'GET', handler: handleDashboardOperational },
  { pattern: new URLPattern({ pathname: '/api/admin/dashboard/alerts' }), method: 'GET', handler: handleDashboardAlerts },
  { pattern: new URLPattern({ pathname: '/api/admin/dashboard/traffic' }), method: 'GET', handler: handleDashboardTraffic },
  { pattern: new URLPattern({ pathname: '/api/admin/dashboard/email-lifecycle' }), method: 'GET', handler: handleDashboardEmailLifecycle },
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
  // Added Homepage Modernization Part 4 (CMS Logo Management) — see
  // services/admin/brandingService.ts. Public GET has no auth, matching
  // /api/media/file's trust model (a resolved logo URL is exactly as
  // public as the underlying Media Library asset it points to).
  { pattern: new URLPattern({ pathname: '/api/admin/branding' }), method: 'GET', handler: handleGetBranding },
  { pattern: new URLPattern({ pathname: '/api/admin/branding' }), method: 'PATCH', handler: handleUpdateBranding },
  { pattern: new URLPattern({ pathname: '/api/branding' }), method: 'GET', handler: handleGetPublicBranding },
  { pattern: new URLPattern({ pathname: '/api/hero' }), method: 'GET', handler: handleGetPublicHero },
  // Version 3.5.1 (Homepage CMS Completion) - see routes/resources.ts's own header comment on this endpoint.
  { pattern: new URLPattern({ pathname: '/api/resources/featured' }), method: 'GET', handler: handleGetFeaturedResource },
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
  { pattern: new URLPattern({ pathname: '/api/admin/products/:id/bundle-items' }), method: 'PUT', handler: handleProductBundleItemsUpdate },
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
  // Milestone M2 (Orders, Receipts & Customer Library) — internal,
  // admin-triggered refund/revocation action (ADR-003).
  { pattern: new URLPattern({ pathname: '/api/admin/orders/:reference/refund' }), method: 'POST', handler: handleOrderRefund },
  // Analytics (Phase 3 Stage 4) — read-only, no role gate beyond auth.
  { pattern: new URLPattern({ pathname: '/api/admin/analytics/summary' }), method: 'GET', handler: handleAnalyticsSummary },
  { pattern: new URLPattern({ pathname: '/api/admin/analytics/timeseries' }), method: 'GET', handler: handleAnalyticsTimeseries },
  { pattern: new URLPattern({ pathname: '/api/admin/analytics/top-products' }), method: 'GET', handler: handleAnalyticsTopProducts },
  // Version 3.3 Milestone M5C — activation/reconciliation/conversion-funnel metrics for the Business Dashboard extension.
  { pattern: new URLPattern({ pathname: '/api/admin/analytics/activation-summary' }), method: 'GET', handler: handleAnalyticsActivationSummary },
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
  // Added Version 2.1 Phase 6 (Newsletter Campaigns) — see
  // docs/v2.1-phase6-design.md. `subscribed-count` is a static path
  // and must be ordered before the `:id` wildcard patterns below, the
  // same lesson already learned in Phase 4's invite routes. Draft/edit/
  // delete/test are editor+super_admin; send/resume are super_admin
  // only (enforced inside each handler, not by this table).
  { pattern: new URLPattern({ pathname: '/api/admin/newsletter/campaigns' }), method: 'GET', handler: handleListCampaigns },
  { pattern: new URLPattern({ pathname: '/api/admin/newsletter/campaigns' }), method: 'POST', handler: handleCreateCampaign },
  { pattern: new URLPattern({ pathname: '/api/admin/newsletter/campaigns/subscribed-count' }), method: 'GET', handler: handleSubscribedCount },
  { pattern: new URLPattern({ pathname: '/api/admin/newsletter/campaigns/:id' }), method: 'GET', handler: handleGetCampaign },
  { pattern: new URLPattern({ pathname: '/api/admin/newsletter/campaigns/:id' }), method: 'PATCH', handler: handleUpdateCampaign },
  { pattern: new URLPattern({ pathname: '/api/admin/newsletter/campaigns/:id' }), method: 'DELETE', handler: handleDeleteCampaign },
  { pattern: new URLPattern({ pathname: '/api/admin/newsletter/campaigns/:id/test' }), method: 'POST', handler: handleTestCampaign },
  { pattern: new URLPattern({ pathname: '/api/admin/newsletter/campaigns/:id/send' }), method: 'POST', handler: handleSendCampaign },
  { pattern: new URLPattern({ pathname: '/api/admin/newsletter/campaigns/:id/resume' }), method: 'POST', handler: handleResumeCampaign },
  // Added Version 2.0 Phase 2 (Products Module) — public site
  // integration. This Worker fully owns `/books/*` via a new Workers
  // Route (wrangler.jsonc) — see routes/books.ts's header comment for
  // why it never falls through to GitHub Pages for any case (index,
  // known slug, unknown slug all render/404 from D1 directly). Ordered
  // last since `/books/*` is the broadest pattern on this table.
  { pattern: new URLPattern({ pathname: '/' }), method: 'GET', handler: handleHomepage },
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
  // Added Phase 11 (Free Guide modernization) — identical pattern, own
  // Workers Route. See routes/free-guide.ts's header comment.
  { pattern: new URLPattern({ pathname: '/free-guide/' }), method: 'GET', handler: handleFreeGuideIndex },
  // Added Version 2.1 Phase 2 (Blog CMS) — public site integration,
  // identical `/books/*`/`/resources/*` Workers Route pattern. Has a
  // real per-post detail page (unlike Resources) — mirrors `/books/*`'s
  // shape exactly.
  { pattern: new URLPattern({ pathname: '/blog/' }), method: 'GET', handler: handleBlogIndex },
  { pattern: new URLPattern({ pathname: '/blog/:slug/' }), method: 'GET', handler: handleBlogDetail },
  { pattern: new URLPattern({ pathname: '/blog/:slug' }), method: 'GET', handler: handleBlogRedirect },
  // Added Version 3.0.2 Milestone M1 (Customer Identity & Guest
  // Checkout) — see docs/v3.0.2-commerce-architecture-blueprint.md.
  // No registration/sign-up route exists here or anywhere in this
  // scope (ADR-006) — every /api/customer/auth/* route below is
  // either unauthenticated-by-design (login, forgot-password,
  // set-password — mirroring admin auth's equivalent public flows) or
  // requires an existing session (logout, session).
  { pattern: new URLPattern({ pathname: '/api/customer/auth/login' }), method: 'POST', handler: handleCustomerLogin },
  { pattern: new URLPattern({ pathname: '/api/customer/auth/logout' }), method: 'POST', handler: handleCustomerLogout },
  { pattern: new URLPattern({ pathname: '/api/customer/auth/session' }), method: 'GET', handler: handleCustomerSession },
  { pattern: new URLPattern({ pathname: '/api/customer/auth/forgot-password' }), method: 'POST', handler: handleCustomerForgotPassword },
  { pattern: new URLPattern({ pathname: '/api/customer/auth/set-password' }), method: 'POST', handler: handleCustomerSetPassword },
  // Version 3.1 Milestone M3 — the Account Security page's own
  // change-password action (already-logged-in, distinct from
  // set-password's emailed-token flow above).
  { pattern: new URLPattern({ pathname: '/api/customer/auth/change-password' }), method: 'POST', handler: handleCustomerChangePassword },
  // Version 3.3 Milestone M5C — historical guest-purchase account
  // claiming. Unauthenticated-by-design, same reasoning as
  // forgot-password above: there is no session yet at the point this
  // is called.
  { pattern: new URLPattern({ pathname: '/api/customer/reconcile-purchases' }), method: 'POST', handler: handleCustomerReconcilePurchases },
  // Version 3.3 Milestone M5C Phase 5 — the review-reminder email's one-click opt-out link.
  { pattern: new URLPattern({ pathname: '/api/customer/review-reminders/opt-out' }), method: 'GET', handler: handleReviewReminderOptOut },
  // Version 4.0 Milestone C1 (Core Email Lifecycle) — the purchase-followup email's one-click opt-out link.
  { pattern: new URLPattern({ pathname: '/api/customer/purchase-followup/opt-out' }), method: 'GET', handler: handlePurchaseFollowupOptOut },
  // Milestone M2 (Orders, Receipts & Customer Library) — `/receipts`
  // ordered before `/receipts/:receiptNumber/download`'s more specific
  // pattern is irrelevant here since URLPattern matches by exact
  // pathname shape, not by list order, but grouped together for
  // readability, same convention as the admin orders block above.
  { pattern: new URLPattern({ pathname: '/api/customer/purchases' }), method: 'GET', handler: handleListCustomerPurchases },
  { pattern: new URLPattern({ pathname: '/api/customer/purchases/:reference' }), method: 'GET', handler: handleGetCustomerPurchase },
  { pattern: new URLPattern({ pathname: '/api/customer/receipts' }), method: 'GET', handler: handleListCustomerReceipts },
  { pattern: new URLPattern({ pathname: '/api/customer/receipts/:receiptNumber/download' }), method: 'GET', handler: handleDownloadCustomerReceipt },
  { pattern: new URLPattern({ pathname: '/api/customer/licenses' }), method: 'GET', handler: handleListCustomerLicenses },
  // Version 3.1 Milestone M3 — Account Security's own-sessions list/revoke.
  { pattern: new URLPattern({ pathname: '/api/customer/sessions' }), method: 'GET', handler: handleListCustomerSessions },
  { pattern: new URLPattern({ pathname: '/api/customer/sessions/:sessionId/revoke' }), method: 'POST', handler: handleRevokeCustomerSession },

  // Version 3.2 Milestone M4 (Commerce & Trust Foundations) — Product
  // Reviews. See docs/v3.2-m4-scope-recommendation.md.
  { pattern: new URLPattern({ pathname: '/api/products/:slug/reviews' }), method: 'GET', handler: handleListPublicReviews },
  { pattern: new URLPattern({ pathname: '/api/customer/reviews' }), method: 'GET', handler: handleListCustomerOwnReviews },
  { pattern: new URLPattern({ pathname: '/api/customer/reviews' }), method: 'POST', handler: handleSubmitReview },
  { pattern: new URLPattern({ pathname: '/api/customer/reviews/:id' }), method: 'DELETE', handler: handleDeleteOwnReview },
  { pattern: new URLPattern({ pathname: '/api/admin/reviews' }), method: 'GET', handler: handleAdminReviewsList },
  { pattern: new URLPattern({ pathname: '/api/admin/reviews/:id/moderate' }), method: 'POST', handler: handleAdminReviewModerate },

  // Version 3.2 Milestone M4 — Coupon Engine, schema corrected per the
  // M4B Required Amendment 1.
  { pattern: new URLPattern({ pathname: '/api/coupons/validate' }), method: 'POST', handler: handleValidateCoupon },
  { pattern: new URLPattern({ pathname: '/api/admin/coupons' }), method: 'GET', handler: handleAdminCouponsList },
  { pattern: new URLPattern({ pathname: '/api/admin/coupons' }), method: 'POST', handler: handleAdminCouponCreate },
  { pattern: new URLPattern({ pathname: '/api/admin/coupons/:id' }), method: 'PATCH', handler: handleAdminCouponUpdate },
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      ? await withErrorHandling(() => matchedRoute.handler(request, env, logger, params, ctx), logger, requestId)
      : jsonError('NOT_FOUND', 'Not found.');

    return withSecurityHeaders(response, env);
  },

  /**
   * Version 3.3 Milestone M5C Phase 5 — this project's first-ever Cron
   * Trigger (see wrangler.jsonc's `triggers.crons`, previously empty).
   * Runs services/customer/reviewReminderService.ts's
   * sendDueReviewReminders().
   *
   * Corrected in Milestone M5D.1 (Acceptance Remediation): an earlier
   * version of this comment claimed the eligibility query alone made
   * this "idempotent by construction... with no separate lock or
   * dedupe needed" against Cloudflare's documented at-least-once
   * Cron Trigger delivery. Sprint M5D's independent acceptance review
   * (docs/v3.3-m5d-review-reminder-validation-report.md) reproduced
   * that this was false: a single failed send permanently suppressed
   * all future reminders for that purchase, and genuinely concurrent
   * invocations sent duplicate emails. The actual safety now comes from
   * `sendDueReviewReminders()`'s own atomic per-purchase claim
   * (`review_reminder_attempts`, migration 0022) — see that service's
   * own header comment and docs/v3.3-m5d1-retry-idempotency-strategy.md
   * for the corrected design.
   *
   * Version 4.0 Milestone C1 (Core Email Lifecycle) adds a second,
   * independent `ctx.waitUntil()` below for
   * `sendDuePurchaseFollowups()` — the same Cron Trigger, not a new
   * one, since both jobs are cheap, idempotent, and unrelated to each
   * other. Each has its own try/catch and its own `cron.heartbeat`
   * entity_type ('review_reminders' vs. 'purchase_followups') so one
   * job failing is visible on the dashboard without ever masking or
   * being masked by the other's outcome.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const logger = createLogger(generateRequestId(), 'scheduled review-reminders');
    // Version 3.5 Milestone (Executive Dashboard) - a real, queryable
    // "did the Cron actually run today" signal for the dashboard's
    // Business Health panel. Unconditional: written whether the run
    // found zero due reminders (still a real, successful execution) or
    // threw (still worth knowing the Cron fired, even if the job
    // itself failed) - the alternative (only logging on a non-empty
    // result) would make an ordinary quiet day indistinguishable from
    // the Cron trigger never firing at all, which is exactly the
    // failure mode this signal exists to catch.
    ctx.waitUntil(
      sendDueReviewReminders(env, logger, env.SITE_BASE_URL)
        .then((result) =>
          recordAuditEvent(env, logger, {
            actorType: 'system',
            actorId: null,
            action: 'cron.heartbeat',
            entityType: 'review_reminders',
            entityId: null,
            metadata: { ok: true, eligible: result.eligible, claimed: result.claimed, sent: result.sent },
          })
        )
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('review_reminders.run_failed', { error: message });
          return recordAuditEvent(env, logger, {
            actorType: 'system',
            actorId: null,
            action: 'cron.heartbeat',
            entityType: 'review_reminders',
            entityId: null,
            metadata: { ok: false, error: message },
          });
        })
    );

    ctx.waitUntil(
      sendDuePurchaseFollowups(env, logger, env.SITE_BASE_URL)
        .then((result) =>
          recordAuditEvent(env, logger, {
            actorType: 'system',
            actorId: null,
            action: 'cron.heartbeat',
            entityType: 'purchase_followups',
            entityId: null,
            metadata: { ok: true, eligible: result.eligible, claimed: result.claimed, sent: result.sent },
          })
        )
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('purchase_followups.run_failed', { error: message });
          return recordAuditEvent(env, logger, {
            actorType: 'system',
            actorId: null,
            action: 'cron.heartbeat',
            entityType: 'purchase_followups',
            entityId: null,
            metadata: { ok: false, error: message },
          });
        })
    );
  },
};
