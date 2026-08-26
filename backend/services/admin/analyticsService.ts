/**
 * Analytics — Version 2.0 Phase 3 (Operational Visibility). See
 * docs/v2.0-phase3-architecture-plan.md's "Analytics" section and
 * docs/v2-analytics-spec.md's data-source boundary (Visitors/Sessions/
 * Traffic Sources live only in Cloudflare Web Analytics, which has no
 * API — never faked here, the frontend links out instead).
 *
 * Every number in this file is a real, live D1 aggregate — no caching
 * layer, no pre-aggregation table, matching v2-analytics-spec.md's
 * "Refresh & caching" conclusion that this platform's real row counts
 * don't justify one yet.
 */

import type { Env } from '../../worker/env';
import { exclusiveEndDate, previousPeriod, deltaPercent, everyDateInRange, daysBetweenInclusive, type PeriodRange } from '../../utils/dateRange';
import { clampToTrackingStart } from '../../utils/analyticsConfig';
import { metaProvider } from '../analytics/metaProvider';

export interface KpiMetric {
  current: number;
  previous: number;
  deltaPercent: number | null;
}

export interface AnalyticsSummary {
  revenuePesewas: KpiMetric;
  orders: KpiMetric;
  newSubscribers: KpiMetric;
  downloadsServed: KpiMetric;
  consultations: KpiMetric;
  contacts: KpiMetric;
}

async function countInRange(env: Env, table: string, dateColumn: string, range: PeriodRange, extraWhere?: string): Promise<number> {
  const where = extraWhere ? `${extraWhere} AND ` : '';
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM ${table} WHERE ${where}${dateColumn} >= ? AND ${dateColumn} < ?`
  )
    .bind(range.from, exclusiveEndDate(range.to))
    .first<{ c: number }>();
  return row?.c ?? 0;
}

async function revenueInRange(env: Env, range: PeriodRange): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_pesewas), 0) AS total FROM purchase_sessions
     WHERE status = 'verified' AND verified_at >= ? AND verified_at < ?`
  )
    .bind(range.from, exclusiveEndDate(range.to))
    .first<{ total: number }>();
  return row?.total ?? 0;
}

function toMetric(current: number, previous: number): KpiMetric {
  return { current, previous, deltaPercent: deltaPercent(current, previous) };
}

export async function getSummary(env: Env, range: PeriodRange): Promise<AnalyticsSummary> {
  const previous = previousPeriod(range);

  const [
    revenueCurrent,
    revenuePrevious,
    ordersCurrent,
    ordersPrevious,
    subscribersCurrent,
    subscribersPrevious,
    downloadsCurrent,
    downloadsPrevious,
    consultationsCurrent,
    consultationsPrevious,
    contactsCurrent,
    contactsPrevious,
  ] = await Promise.all([
    revenueInRange(env, range),
    revenueInRange(env, previous),
    countInRange(env, 'purchase_sessions', 'verified_at', range, "status = 'verified'"),
    countInRange(env, 'purchase_sessions', 'verified_at', previous, "status = 'verified'"),
    countInRange(env, 'newsletter_subscribers', 'subscribed_at', range),
    countInRange(env, 'newsletter_subscribers', 'subscribed_at', previous),
    countInRange(env, 'download_tokens', 'used_at', range, 'used_at IS NOT NULL'),
    countInRange(env, 'download_tokens', 'used_at', previous, 'used_at IS NOT NULL'),
    countInRange(env, 'consultation_requests', 'created_at', range, 'deleted_at IS NULL'),
    countInRange(env, 'consultation_requests', 'created_at', previous, 'deleted_at IS NULL'),
    countInRange(env, 'contact_messages', 'created_at', range, 'deleted_at IS NULL'),
    countInRange(env, 'contact_messages', 'created_at', previous, 'deleted_at IS NULL'),
  ]);

  return {
    revenuePesewas: toMetric(revenueCurrent, revenuePrevious),
    orders: toMetric(ordersCurrent, ordersPrevious),
    newSubscribers: toMetric(subscribersCurrent, subscribersPrevious),
    downloadsServed: toMetric(downloadsCurrent, downloadsPrevious),
    consultations: toMetric(consultationsCurrent, consultationsPrevious),
    contacts: toMetric(contactsCurrent, contactsPrevious),
  };
}

export interface TimeseriesPoint {
  date: string;
  count: number;
}

export interface AnalyticsTimeseries {
  ordersPerDay: TimeseriesPoint[];
  subscribersPerDay: TimeseriesPoint[];
}

/** Zero-fills every date in range — a chart must never silently skip a day with no rows, or a real gap in activity would look identical to missing data. */
function zeroFillByDate(rows: { date: string; count: number }[], dates: string[]): TimeseriesPoint[] {
  const byDate = new Map(rows.map((r) => [r.date, r.count]));
  return dates.map((date) => ({ date, count: byDate.get(date) ?? 0 }));
}

/** A daily chart is only ever useful over a bounded window — 366 days matches routes/admin/analytics.ts's own MAX_RANGE_DAYS clamp. Without this, the "All time" preset's literal '0001-01-01'..'9999-12-31' range (a fine, cheap bound for a plain SQL SUM/COUNT elsewhere in this file) would make everyDateInRange() materialize millions of zero-filled days here — a real, measured multi-second/hundred-megabyte response, not a hypothetical one. Clamps to the most recent MAX_TIMESERIES_DAYS of the requested range, applied to both the zero-fill list AND the SQL bind params together so a query never silently drops real rows outside the shown window. */
const MAX_TIMESERIES_DAYS = 366;

function clampToRecentWindow(range: PeriodRange): PeriodRange {
  // Also caps `to` at today: the "All time" preset's far-future sentinel
  // ('9998-12-31', see routes/admin/analytics.ts's parseRange()) has no
  // real data past today, so anchoring the "most recent" window to that
  // sentinel instead of today would render a chart full of future,
  // meaninglessly-zero-filled dates instead of anything a person
  // actually asked to see.
  const todayStr = new Date().toISOString().slice(0, 10);
  const to = range.to > todayStr ? todayStr : range.to;
  if (daysBetweenInclusive(range.from, to) <= MAX_TIMESERIES_DAYS) return { from: range.from, to };
  const toMs = new Date(`${to}T00:00:00.000Z`).getTime();
  const clampedFrom = new Date(toMs - (MAX_TIMESERIES_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from: clampedFrom, to };
}

export async function getTimeseries(env: Env, requestedRange: PeriodRange): Promise<AnalyticsTimeseries> {
  const range = clampToRecentWindow(requestedRange);
  const dates = everyDateInRange(range.from, range.to);

  const [orderRows, subscriberRows] = await Promise.all([
    env.DB.prepare(
      `SELECT date(verified_at) AS date, COUNT(*) AS count FROM purchase_sessions
       WHERE status = 'verified' AND verified_at >= ? AND verified_at < ?
       GROUP BY date(verified_at)`
    )
      .bind(range.from, exclusiveEndDate(range.to))
      .all<{ date: string; count: number }>(),
    env.DB.prepare(
      `SELECT date(subscribed_at) AS date, COUNT(*) AS count FROM newsletter_subscribers
       WHERE subscribed_at >= ? AND subscribed_at < ?
       GROUP BY date(subscribed_at)`
    )
      .bind(range.from, exclusiveEndDate(range.to))
      .all<{ date: string; count: number }>(),
  ]);

  return {
    ordersPerDay: zeroFillByDate(orderRows.results, dates),
    subscribersPerDay: zeroFillByDate(subscriberRows.results, dates),
  };
}

export interface TopProduct {
  slug: string;
  title: string;
  orderCount: number;
  revenuePesewas: number;
}

/** Real product ranking — `GROUP BY product_slug` over verified orders in range, joined to the live `products.title` (not the historical per-order snapshot) so a later rename is reflected here, matching the architecture plan's explicit "joined to products.title for display." Falls back to the order's own snapshotted title for a slug with no matching live product row (e.g. since deleted). */
export async function getTopProducts(env: Env, range: PeriodRange, limit = 10): Promise<TopProduct[]> {
  const { results } = await env.DB.prepare(
    `SELECT ps.product_slug AS slug,
            COALESCE(p.title, MAX(ps.product_title)) AS title,
            COUNT(*) AS orderCount,
            COALESCE(SUM(ps.amount_pesewas), 0) AS revenuePesewas
     FROM purchase_sessions ps
     LEFT JOIN products p ON p.slug = ps.product_slug
     WHERE ps.status = 'verified' AND ps.verified_at >= ? AND ps.verified_at < ?
     GROUP BY ps.product_slug
     ORDER BY orderCount DESC
     LIMIT ?`
  )
    .bind(range.from, exclusiveEndDate(range.to), limit)
    .all<TopProduct>();

  return results;
}

// ============================================================
// Activation Analytics — Version 3.3 Milestone M5C (Activation,
// Analytics and Customer Reconciliation). See
// docs/v3.3-m5c-analytics-architecture.md. Every metric here reuses an
// already-existing table and, where one already exists, an already-
// existing signal (e.g. customer_sessions.last_seen_at) — no new
// instrumentation, matching the sprint brief's explicit "reuse
// existing analytics infrastructure where possible."
// ============================================================

export interface ActivationSummary {
  checkoutStarts: KpiMetric;
  checkoutCompletions: KpiMetric;
  checkoutCompletionRate: number | null;
  couponRedemptions: KpiMetric;
  reviewsSubmitted: KpiMetric;
  dashboardActiveCustomers: KpiMetric;
  repeatPurchases: KpiMetric;
  purchasesReconciled: KpiMetric;
}

/** Every `purchase_sessions` row created in range, regardless of outcome — a checkout "start," matching the same `created_at` moment the row itself is inserted at (see database/schema.sql's purchase_sessions comment). */
async function checkoutStartsInRange(env: Env, range: PeriodRange): Promise<number> {
  return countInRange(env, 'purchase_sessions', 'created_at', range);
}

/** Distinct customers with an authenticated dashboard request (any /api/customer/* page load past the session gate) in range — reuses customer_sessions.last_seen_at, already updated on every authenticated request by sessionService.ts's validateSession(), zero new instrumentation. */
async function dashboardActiveCustomersInRange(env: Env, range: PeriodRange): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT customer_id) AS c FROM customer_sessions WHERE last_seen_at >= ? AND last_seen_at < ?`
  )
    .bind(range.from, exclusiveEndDate(range.to))
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * A verified purchase in range by a customer who already had at least
 * one earlier verified purchase — a genuine repeat-purchase EVENT, not
 * a lifetime customer count, so it fits the same current-vs-previous
 * KpiMetric shape as every other metric here. `verified_at` alone
 * isn't a safe ordering key — `datetime('now')` has one-second
 * resolution, so two purchases verified within the same second (a real
 * possibility at checkout, and the exact case this project's own test
 * suite caught) would otherwise tie and neither would count as
 * "later" — `id` (monotonically increasing on insert) breaks the tie.
 */
async function repeatPurchasesInRange(env: Env, range: PeriodRange): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM purchase_sessions ps
     WHERE ps.status = 'verified' AND ps.verified_at >= ? AND ps.verified_at < ? AND ps.customer_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM purchase_sessions prior
         WHERE prior.customer_id = ps.customer_id AND prior.status = 'verified'
           AND (prior.verified_at < ps.verified_at OR (prior.verified_at = ps.verified_at AND prior.id < ps.id))
       )`
  )
    .bind(range.from, exclusiveEndDate(range.to))
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function getActivationSummary(env: Env, range: PeriodRange): Promise<ActivationSummary> {
  const previous = previousPeriod(range);

  const [
    startsCurrent,
    startsPrevious,
    completionsCurrent,
    completionsPrevious,
    couponsCurrent,
    couponsPrevious,
    reviewsCurrent,
    reviewsPrevious,
    dashboardActiveCurrent,
    dashboardActivePrevious,
    repeatCurrent,
    repeatPrevious,
    reconciledCurrent,
    reconciledPrevious,
  ] = await Promise.all([
    checkoutStartsInRange(env, range),
    checkoutStartsInRange(env, previous),
    countInRange(env, 'purchase_sessions', 'verified_at', range, "status = 'verified'"),
    countInRange(env, 'purchase_sessions', 'verified_at', previous, "status = 'verified'"),
    countInRange(env, 'coupon_redemptions', 'redeemed_at', range),
    countInRange(env, 'coupon_redemptions', 'redeemed_at', previous),
    countInRange(env, 'product_reviews', 'created_at', range),
    countInRange(env, 'product_reviews', 'created_at', previous),
    dashboardActiveCustomersInRange(env, range),
    dashboardActiveCustomersInRange(env, previous),
    repeatPurchasesInRange(env, range),
    repeatPurchasesInRange(env, previous),
    countInRange(env, 'audit_logs', 'created_at', range, "action = 'customer.purchases_reconciled'"),
    countInRange(env, 'audit_logs', 'created_at', previous, "action = 'customer.purchases_reconciled'"),
  ]);

  return {
    checkoutStarts: toMetric(startsCurrent, startsPrevious),
    checkoutCompletions: toMetric(completionsCurrent, completionsPrevious),
    checkoutCompletionRate: startsCurrent > 0 ? Math.round((completionsCurrent / startsCurrent) * 1000) / 10 : null,
    couponRedemptions: toMetric(couponsCurrent, couponsPrevious),
    reviewsSubmitted: toMetric(reviewsCurrent, reviewsPrevious),
    dashboardActiveCustomers: toMetric(dashboardActiveCurrent, dashboardActivePrevious),
    repeatPurchases: toMetric(repeatCurrent, repeatPrevious),
    purchasesReconciled: toMetric(reconciledCurrent, reconciledPrevious),
  };
}

// ============================================================
// Conversion Dispatch Observability — Version 5.0 (Customer
// Acquisition Phase 1, Phase 10). Reads analytics_conversion_log
// (migration 0040) — the record of every SERVER-SIDE conversion
// dispatch attempt (Purchase, via Meta Conversions API today; see
// services/analytics/conversionDispatchService.ts).
//
// "Recent Leads sent" and "Recent Downloads sent" are deliberately NOT
// sourced from analytics_conversion_log: Lead and Download are
// browser-pixel-only events (Phases 4/5's own scope — Phase 7 scopes
// server-side/CAPI dispatch to Purchase specifically), which means
// they fire directly from the visitor's browser to Meta and this
// backend genuinely never observes them. Rather than fabricate a
// "sent to Meta" confirmation this backend cannot honestly make,
// these two lists are sourced from the real underlying business
// events that trigger each browser-side fire — newsletter_subscribers/
// consultation_requests for Leads (js/components/newsletter-form.js /
// consultation-form.js), download_tokens for Downloads
// (js/components/fulfilment-status.js) — labeled as such in the
// admin UI. See docs/v5.0-analytics-architecture.md and this phase's
// own Known Limitations for the full reasoning.
// ============================================================

export interface ConversionProviderHealth {
  provider: string;
  configured: boolean;
  lastEventSentAt: string | null;
  recentFailureCount: number;
}

export interface ConversionFailedEvent {
  id: number;
  provider: string;
  eventName: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
}

export interface RecentConversionEvent {
  id: number;
  provider: string;
  eventName: string;
  status: string;
  createdAt: string;
  sentAt: string | null;
}

export interface RecentLeadEvent {
  source: 'newsletter' | 'consultation';
  email: string;
  createdAt: string;
}

export interface RecentDownloadEvent {
  productSlug: string;
  assetId: string;
  usedAt: string;
}

export interface ConversionDispatchSummary {
  providers: ConversionProviderHealth[];
  retryQueueCount: number;
  failedEvents: ConversionFailedEvent[];
  recentPurchasesSent: RecentConversionEvent[];
  recentLeads: RecentLeadEvent[];
  recentDownloads: RecentDownloadEvent[];
}

const RECENT_LIMIT = 20;
const RECENT_WINDOW_FAILURE_HOURS = 24;

export async function getConversionDispatchSummary(env: Env): Promise<ConversionDispatchSummary> {
  const [lastSentRow, recentFailureRow, retryQueueRow, failedRows, purchaseRows, newsletterRows, consultationRows, downloadRows] = await Promise.all([
    env.DB.prepare(`SELECT sent_at FROM analytics_conversion_log WHERE provider = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`)
      .bind(metaProvider.name)
      .first<{ sent_at: string }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM analytics_conversion_log WHERE provider = ? AND status IN ('failed', 'permanently_failed') AND created_at >= datetime('now', ?)`
    )
      .bind(metaProvider.name, `-${RECENT_WINDOW_FAILURE_HOURS} hours`)
      .first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM analytics_conversion_log WHERE status = 'failed'`).first<{ c: number }>(),
    env.DB.prepare(
      `SELECT id, provider, event_name AS eventName, status, attempt_count AS attemptCount, last_error AS lastError, created_at AS createdAt
       FROM analytics_conversion_log WHERE status IN ('failed', 'permanently_failed') ORDER BY created_at DESC LIMIT ?`
    )
      .bind(RECENT_LIMIT)
      .all<ConversionFailedEvent>(),
    env.DB.prepare(
      `SELECT id, provider, event_name AS eventName, status, created_at AS createdAt, sent_at AS sentAt
       FROM analytics_conversion_log WHERE event_name = 'Purchase' AND status = 'sent' ORDER BY sent_at DESC LIMIT ?`
    )
      .bind(RECENT_LIMIT)
      .all<RecentConversionEvent>(),
    env.DB.prepare(`SELECT email, subscribed_at AS createdAt FROM newsletter_subscribers ORDER BY subscribed_at DESC LIMIT ?`)
      .bind(RECENT_LIMIT)
      .all<{ email: string; createdAt: string }>(),
    env.DB.prepare(`SELECT email, created_at AS createdAt FROM consultation_requests WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`)
      .bind(RECENT_LIMIT)
      .all<{ email: string; createdAt: string }>(),
    env.DB.prepare(
      `SELECT d.product_slug AS productSlug, d.asset_id AS assetId, dt.used_at AS usedAt
       FROM download_tokens dt JOIN deliveries d ON d.id = dt.delivery_id
       WHERE dt.used_at IS NOT NULL ORDER BY dt.used_at DESC LIMIT ?`
    )
      .bind(RECENT_LIMIT)
      .all<RecentDownloadEvent>(),
  ]);

  const recentLeads: RecentLeadEvent[] = [
    ...newsletterRows.results.map((r) => ({ source: 'newsletter' as const, email: r.email, createdAt: r.createdAt })),
    ...consultationRows.results.map((r) => ({ source: 'consultation' as const, email: r.email, createdAt: r.createdAt })),
  ]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, RECENT_LIMIT);

  return {
    providers: [
      {
        provider: metaProvider.name,
        configured: metaProvider.isConfigured(env),
        lastEventSentAt: lastSentRow?.sent_at ?? null,
        recentFailureCount: recentFailureRow?.c ?? 0,
      },
    ],
    retryQueueCount: retryQueueRow?.c ?? 0,
    failedEvents: failedRows.results,
    recentPurchasesSent: purchaseRows.results,
    recentLeads,
    recentDownloads: downloadRows.results,
  };
}

// ============================================================
// Analytics & User-Activity Baseline (migration 0045) — registered
// users, unique visitors, Online Now, per-book funnel, device/country
// breakdown. Registered-users and revenue/purchase figures read
// existing tables with real historical data and are never clamped.
// Visitor/session/device/country figures come from analytics_events
// and are clamped to ANALYTICS_TRACKING_START_DATE (see
// utils/analyticsConfig.ts) — this platform has no first-party
// visitor data before that date, and these queries must say so
// honestly rather than silently return a number for a range that
// predates real tracking.
// ============================================================

export interface GrowthSummary {
  registeredUsers: KpiMetric;
  uniqueVisitors: KpiMetric;
  /** True when the requested range's `from` was clamped forward to ANALYTICS_TRACKING_START_DATE for the uniqueVisitors figure specifically. */
  visitorsClamped: boolean;
}

export async function getGrowthSummary(env: Env, range: PeriodRange): Promise<GrowthSummary> {
  const previous = previousPeriod(range);
  const { range: visitorRange, clamped } = clampToTrackingStart(range);
  const { range: visitorPreviousRange } = clampToTrackingStart(previous);

  async function uniqueVisitorsInRange(r: PeriodRange): Promise<number> {
    const row = await env.DB.prepare(
      `SELECT COUNT(DISTINCT session_id) AS c FROM analytics_events
       WHERE event_type IN ('page_view', 'product_view') AND created_at >= ? AND created_at < ?`
    )
      .bind(r.from, exclusiveEndDate(r.to))
      .first<{ c: number }>();
    return row?.c ?? 0;
  }

  const [registeredCurrent, registeredPrevious, visitorsCurrent, visitorsPrevious] = await Promise.all([
    countInRange(env, 'customers', 'created_at', range, 'deleted_at IS NULL'),
    countInRange(env, 'customers', 'created_at', previous, 'deleted_at IS NULL'),
    uniqueVisitorsInRange(visitorRange),
    uniqueVisitorsInRange(visitorPreviousRange),
  ]);

  return {
    registeredUsers: toMetric(registeredCurrent, registeredPrevious),
    uniqueVisitors: toMetric(visitorsCurrent, visitorsPrevious),
    visitorsClamped: clamped,
  };
}

/**
 * KV-only "Online Now" count (migration 0045's own header comment) —
 * never a D1 row. `list()` is eventually consistent and paginates at
 * 1000 keys; both are known, acceptable tradeoffs at this platform's
 * real traffic scale, not silently assumed exact.
 */
export async function getOnlineNowCount(env: Env): Promise<number> {
  const result = await env.RATE_LIMIT_KV.list({ prefix: 'online:' });
  return result.keys.length;
}

export interface ProductFunnelRow {
  slug: string;
  title: string;
  views: number;
  checkoutStarts: number;
  purchases: number;
  revenuePesewas: number;
  downloads: number;
  conversionRate: number | null;
}

/**
 * One row per real `products` row — generalizes automatically to any
 * future book with zero code changes, unlike the page_path-LIKE-match
 * approach `executiveDashboardService.getTrafficFunnel()`'s
 * `productAttention` previously used. `views` comes from the new
 * `product_view` event (clamped to tracking start, like every
 * analytics_events-derived figure); checkoutStarts/purchases/revenue
 * come from `purchase_sessions` (real historical data, never
 * clamped); downloads comes from `download_tokens`/`deliveries`,
 * exactly the same join `getConversionDispatchSummary()`'s
 * recentDownloads already uses.
 */
export async function getPerBookFunnel(env: Env, range: PeriodRange): Promise<ProductFunnelRow[]> {
  const { range: viewRange } = clampToTrackingStart(range);
  const viewFrom = viewRange.from;
  const viewTo = exclusiveEndDate(viewRange.to);
  const from = range.from;
  const to = exclusiveEndDate(range.to);

  const { results } = await env.DB.prepare(
    `SELECT p.slug AS slug, p.title AS title,
            COALESCE(pv.views, 0) AS views,
            COALESCE(cs.checkoutStarts, 0) AS checkoutStarts,
            COALESCE(pur.purchases, 0) AS purchases,
            COALESCE(pur.revenuePesewas, 0) AS revenuePesewas,
            COALESCE(dl.downloads, 0) AS downloads
     FROM products p
     LEFT JOIN (
       SELECT product_slug, COUNT(*) AS views FROM analytics_events
       WHERE event_type = 'product_view' AND created_at >= ? AND created_at < ?
       GROUP BY product_slug
     ) pv ON pv.product_slug = p.slug
     LEFT JOIN (
       SELECT product_slug, COUNT(*) AS checkoutStarts FROM purchase_sessions
       WHERE created_at >= ? AND created_at < ?
       GROUP BY product_slug
     ) cs ON cs.product_slug = p.slug
     LEFT JOIN (
       SELECT product_slug, COUNT(*) AS purchases, COALESCE(SUM(amount_pesewas), 0) AS revenuePesewas FROM purchase_sessions
       WHERE status = 'verified' AND verified_at >= ? AND verified_at < ?
       GROUP BY product_slug
     ) pur ON pur.product_slug = p.slug
     LEFT JOIN (
       SELECT d.product_slug AS product_slug, COUNT(*) AS downloads
       FROM download_tokens dt JOIN deliveries d ON d.id = dt.delivery_id
       WHERE dt.used_at IS NOT NULL AND dt.used_at >= ? AND dt.used_at < ?
       GROUP BY d.product_slug
     ) dl ON dl.product_slug = p.slug
     ORDER BY revenuePesewas DESC, views DESC`
  )
    .bind(viewFrom, viewTo, from, to, from, to, from, to)
    .all<Omit<ProductFunnelRow, 'conversionRate'>>();

  return results.map((row) => ({
    ...row,
    // Suppressed (null, not a computed number) whenever purchases > views:
    // views is a brand-new metric clamped to ANALYTICS_TRACKING_START_DATE,
    // while purchases/checkoutStarts intentionally show full, unclamped
    // history — real, expected during the transition period (a book with
    // years of purchase history has only had view-tracking for a few
    // days), but the resulting ratio can exceed 100%, which is never an
    // honest "conversion rate" to display as a plain percentage.
    conversionRate: row.views > 0 && row.purchases <= row.views ? Math.round((row.purchases / row.views) * 1000) / 10 : null,
  }));
}

export interface BreakdownRow {
  label: string;
  count: number;
}

/** `GROUP BY device_type` over `page_view`/`product_view` events, clamped to tracking start. */
export async function getDeviceBreakdown(env: Env, range: PeriodRange): Promise<BreakdownRow[]> {
  const { range: r } = clampToTrackingStart(range);
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(device_type, 'unknown') AS label, COUNT(*) AS count FROM analytics_events
     WHERE event_type IN ('page_view', 'product_view') AND created_at >= ? AND created_at < ?
     GROUP BY label ORDER BY count DESC`
  )
    .bind(r.from, exclusiveEndDate(r.to))
    .all<BreakdownRow>();
  return results;
}

/** `GROUP BY country` over `page_view`/`product_view` events, clamped to tracking start. `country` is Cloudflare's own edge-computed 2-letter code — never an IP address, never precise location. */
export async function getCountryBreakdown(env: Env, range: PeriodRange): Promise<BreakdownRow[]> {
  const { range: r } = clampToTrackingStart(range);
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(country, 'unknown') AS label, COUNT(*) AS count FROM analytics_events
     WHERE event_type IN ('page_view', 'product_view') AND created_at >= ? AND created_at < ?
     GROUP BY label ORDER BY count DESC LIMIT 20`
  )
    .bind(r.from, exclusiveEndDate(r.to))
    .all<BreakdownRow>();
  return results;
}

// ============================================================
// Reliable Sales Funnel Measurement pass — source-level and
// campaign-level funnels, built entirely from tables that already
// exist (analytics_events, purchase_sessions, email_log,
// newsletter_campaign_recipients, coupon_redemptions). No new
// tracking table; the two real gaps this closes are migration 0046's
// utm_content column and product_view's fixed URL-based trigger
// (js/components/analytics.js) — both prerequisites for these queries
// to mean what they say. See docs comment on getCampaignFunnel() for
// what this deliberately does NOT claim to measure.
// ============================================================

/**
 * The same source-bucketing rule applied consistently everywhere a
 * "source" grouping is needed here, so a session or purchase is never
 * bucketed one way in one query and another way in a different one.
 * `analytics_events` has both utm_source and referrer; purchase_sessions
 * only ever captures utm_source (no referrer at checkout time — see
 * migration 0044's own header comment on why), so the two SQL variants
 * below share every utm_source rule and only differ in whether a
 * referrer-based fallback is possible.
 */
const SOURCE_BUCKET_WITH_REFERRER = `
  CASE
    WHEN utm_source = 'fb' THEN 'Facebook'
    WHEN utm_source = 'ig' THEN 'Instagram'
    WHEN utm_source = 'email' OR utm_medium = 'newsletter' THEN 'Email'
    WHEN utm_source = 'announcement' THEN 'Announcement'
    WHEN utm_source = 'homepage_launch_spotlight' THEN 'Homepage Spotlight'
    WHEN utm_source IS NOT NULL THEN 'Other campaign'
    WHEN referrer LIKE '%facebook.com%' OR referrer LIKE '%fb.me%' THEN 'Facebook'
    WHEN referrer LIKE '%instagram.com%' THEN 'Instagram'
    WHEN referrer LIKE '%google.%' THEN 'Google'
    WHEN referrer IS NULL OR referrer = '' OR referrer LIKE 'https://robayerwealthlab.com%' THEN 'Direct'
    ELSE 'Other/referral'
  END`;

const SOURCE_BUCKET_UTM_ONLY = `
  CASE
    WHEN utm_source = 'fb' THEN 'Facebook'
    WHEN utm_source = 'ig' THEN 'Instagram'
    WHEN utm_source = 'email' OR utm_medium = 'newsletter' THEN 'Email'
    WHEN utm_source = 'announcement' THEN 'Announcement'
    WHEN utm_source = 'homepage_launch_spotlight' THEN 'Homepage Spotlight'
    WHEN utm_source IS NOT NULL THEN 'Other campaign'
    ELSE 'Direct/unattributed'
  END`;

export interface SourceBreakdownRow {
  source: string;
  sessions: number;
  productViews: number;
  checkoutStarts: number;
  purchases: number;
  revenuePesewas: number;
}

/**
 * One row per source bucket, joining analytics_events (sessions,
 * product views — clamped to the tracking start date, like every
 * analytics_events-derived figure) with purchase_sessions (checkout
 * starts/purchases/revenue, real full history, never clamped).
 * purchase_sessions' own bucket can only use utm_source (no referrer
 * captured at checkout), so a purchase with no UTM lands in
 * "Direct/unattributed" here even if analytics_events could have told
 * a more specific story for the session that produced it — an honest
 * limitation of the checkout-time capture, not something this query
 * can paper over.
 */
export async function getSourceBreakdown(env: Env, range: PeriodRange): Promise<SourceBreakdownRow[]> {
  const { range: viewRange } = clampToTrackingStart(range);
  const viewFrom = viewRange.from;
  const viewTo = exclusiveEndDate(viewRange.to);
  const from = range.from;
  const to = exclusiveEndDate(range.to);

  const { results } = await env.DB.prepare(
    `SELECT source, COALESCE(SUM(sessions), 0) AS sessions, COALESCE(SUM(productViews), 0) AS productViews,
            COALESCE(SUM(checkoutStarts), 0) AS checkoutStarts, COALESCE(SUM(purchases), 0) AS purchases, COALESCE(SUM(revenuePesewas), 0) AS revenuePesewas
     FROM (
       SELECT ${SOURCE_BUCKET_WITH_REFERRER} AS source, COUNT(DISTINCT session_id) AS sessions,
              SUM(CASE WHEN event_type = 'product_view' THEN 1 ELSE 0 END) AS productViews,
              0 AS checkoutStarts, 0 AS purchases, 0 AS revenuePesewas
       FROM analytics_events
       WHERE event_type IN ('page_view', 'product_view') AND created_at >= ? AND created_at < ?
       GROUP BY source
       UNION ALL
       SELECT ${SOURCE_BUCKET_UTM_ONLY} AS source, 0 AS sessions, 0 AS productViews,
              COUNT(*) AS checkoutStarts,
              SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS purchases,
              COALESCE(SUM(CASE WHEN status = 'verified' THEN amount_pesewas ELSE 0 END), 0) AS revenuePesewas
       FROM purchase_sessions
       WHERE created_at >= ? AND created_at < ?
       GROUP BY source
     )
     GROUP BY source ORDER BY revenuePesewas DESC, sessions DESC`
  )
    .bind(viewFrom, viewTo, from, to)
    .all<SourceBreakdownRow>();

  return results;
}

export interface CampaignFunnelStage {
  /** null means "cannot be measured by this system" — never a fabricated zero. See getCampaignFunnel()'s own doc comment. */
  value: number | null;
  label: string;
}

export interface CampaignFunnel {
  campaignId: number;
  subject: string;
  utmCampaign: string | null;
  recipients: number | null;
  delivered: number;
  bounced: number;
  trackedOpens: CampaignFunnelStage;
  ctaClicks: CampaignFunnelStage;
  landingPageVisits: number;
  productViews: number;
  checkoutStarts: number;
  couponApplications: number;
  purchases: number;
  revenuePesewas: number;
  downloads: number;
}

/**
 * Every stage after "bounced" depends on the campaign having a real
 * utm_campaign tag set (newsletter_campaigns.utm_campaign, migration
 * 0046) — without one, this returns nulls for everything downstream
 * rather than guessing. Two stages are permanently unmeasurable with
 * this project's current email architecture, by design, not oversight:
 *
 *   - trackedOpens: Resend's open-tracking pixel requires (a) enabling
 *     Open Tracking in the Resend account dashboard — outside this
 *     codebase's control — and (b) a new inbound webhook endpoint to
 *     receive `email.opened` events, which does not exist. Returns
 *     `{ value: null, label: "Open rate cannot currently be determined
 *     from the existing system." }` always, per the same "say so
 *     honestly" instruction as everywhere else in this file.
 *   - ctaClicks: a plain `<a href>` in an HTML email has no reliable
 *     way to signal a click before the destination page loads (email
 *     clients don't execute JavaScript), short of a server-side
 *     redirect-tracking link — a genuinely new piece of infrastructure,
 *     not an extension of what exists, and not something that could
 *     even apply retroactively to a campaign already sent with plain
 *     links. Returns the nearest honest proxy instead: distinct
 *     sessions whose first-touch page_view carries this campaign's
 *     utm_campaign, explicitly labeled as a proxy, never presented as
 *     a true pre-arrival click count.
 */
export async function getCampaignFunnel(env: Env, campaignId: number): Promise<CampaignFunnel | null> {
  const campaign = await env.DB.prepare(
    `SELECT id, subject, utm_campaign AS utmCampaign, intended_recipient_count AS recipients FROM newsletter_campaigns WHERE id = ? AND deleted_at IS NULL`
  )
    .bind(campaignId)
    .first<{ id: number; subject: string; utmCampaign: string | null; recipients: number | null }>();
  if (!campaign) return null;

  const [deliveryRows, downloadRow] = await Promise.all([
    env.DB.prepare(`SELECT status, COUNT(*) AS c FROM email_log WHERE entity_type = 'newsletter_campaign' AND entity_id = ? GROUP BY status`)
      .bind(campaignId)
      .all<{ status: string; c: number }>(),
    // Downloads can only be tied to this campaign via the purchase(s)
    // it produced, joined through deliveries — same reasoning as
    // getPerBookFunnel()'s own downloads join.
    campaign.utmCampaign
      ? env.DB.prepare(
          `SELECT COUNT(*) AS c FROM download_tokens dt
           JOIN deliveries d ON d.id = dt.delivery_id
           JOIN purchase_sessions ps ON ps.id = d.purchase_session_id
           WHERE ps.utm_campaign = ? AND dt.used_at IS NOT NULL`
        )
          .bind(campaign.utmCampaign)
          .first<{ c: number }>()
      : Promise.resolve({ c: 0 }),
  ]);

  const delivered = deliveryRows.results.find((r) => r.status === 'sent')?.c ?? 0;
  const bounced = deliveryRows.results
    .filter((r) => r.status === 'failed' || r.status === 'permanently_failed')
    .reduce((sum, r) => sum + r.c, 0);

  if (!campaign.utmCampaign) {
    return {
      campaignId: campaign.id,
      subject: campaign.subject,
      utmCampaign: null,
      recipients: campaign.recipients,
      delivered,
      bounced,
      trackedOpens: { value: null, label: 'Open rate cannot currently be determined from the existing system.' },
      ctaClicks: { value: null, label: 'This campaign has no utm_campaign tag set, so site visits cannot be attributed to it.' },
      landingPageVisits: 0,
      productViews: 0,
      checkoutStarts: 0,
      couponApplications: 0,
      purchases: 0,
      revenuePesewas: 0,
      downloads: 0,
    };
  }

  const [visitsRow, viewsRow, checkoutRow] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(DISTINCT session_id) AS c FROM analytics_events WHERE event_type = 'page_view' AND utm_campaign = ?`
    )
      .bind(campaign.utmCampaign)
      .first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM analytics_events WHERE event_type = 'product_view' AND utm_campaign = ?`)
      .bind(campaign.utmCampaign)
      .first<{ c: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS starts, SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS purchases,
              COALESCE(SUM(CASE WHEN status = 'verified' THEN amount_pesewas ELSE 0 END), 0) AS revenue,
              SUM(CASE WHEN coupon_id IS NOT NULL THEN 1 ELSE 0 END) AS couponApplications
       FROM purchase_sessions WHERE utm_campaign = ?`
    )
      .bind(campaign.utmCampaign)
      .first<{ starts: number; purchases: number; revenue: number; couponApplications: number }>(),
  ]);

  return {
    campaignId: campaign.id,
    subject: campaign.subject,
    utmCampaign: campaign.utmCampaign,
    recipients: campaign.recipients,
    delivered,
    bounced,
    trackedOpens: { value: null, label: 'Open rate cannot currently be determined from the existing system.' },
    ctaClicks: {
      value: visitsRow?.c ?? 0,
      label: 'Proxy metric: distinct sessions whose first site visit carried this campaign\'s UTM tag — not a true pre-arrival click count (email clients do not run the JavaScript that would make one possible without a server-side redirect link, which this campaign\'s already-sent links do not use).',
    },
    landingPageVisits: visitsRow?.c ?? 0,
    productViews: viewsRow?.c ?? 0,
    checkoutStarts: checkoutRow?.starts ?? 0,
    couponApplications: checkoutRow?.couponApplications ?? 0,
    purchases: checkoutRow?.purchases ?? 0,
    revenuePesewas: checkoutRow?.revenue ?? 0,
    downloads: downloadRow?.c ?? 0,
  };
}
