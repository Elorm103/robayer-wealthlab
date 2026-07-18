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
