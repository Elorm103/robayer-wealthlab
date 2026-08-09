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
import { exclusiveEndDate, previousPeriod, deltaPercent, everyDateInRange, type PeriodRange } from '../../utils/dateRange';
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

export async function getTimeseries(env: Env, range: PeriodRange): Promise<AnalyticsTimeseries> {
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
