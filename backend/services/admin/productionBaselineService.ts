/**
 * Production Launch Baseline — Version 4.9 Phase 9. Captures an
 * immutable, point-in-time snapshot of "true launch metrics" (see
 * migration 0032_production_launch_baselines.sql — the table itself
 * refuses UPDATE/DELETE at the database layer via triggers, not just
 * by convention). Every future report is meant to compare against
 * whichever baseline this produces.
 *
 * Deliberately reuses executiveDashboardService.getKpis(env,
 * 'production') for every number that function already computes
 * (revenue breakdown, customers, orders, AOV, conversion rate,
 * subscribers, published products/resources/reviews) rather than
 * re-deriving the same SQL a second time — per the founder's explicit
 * "no duplicated logic, no duplicated queries" engineering standard.
 * Only genuinely new metrics (bundles, downloads, traffic, top
 * products) get their own query here.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { getKpis } from './executiveDashboardService';
import * as auditService from './auditService';

export interface ProductionBaseline {
  id: number;
  platformVersion: string;
  launchDate: string;
  notes: string | null;
  lifetimeRevenuePesewas: number;
  customerRevenuePesewas: number;
  internalRevenuePesewas: number;
  developmentRevenuePesewas: number;
  customersCount: number;
  ordersCount: number;
  productsCount: number;
  bundlesCount: number;
  resourcesCount: number;
  downloadsCount: number;
  subscribersCount: number;
  reviewsCount: number;
  conversionRatePercent: number | null;
  averageOrderValuePesewas: number | null;
  trafficPageViews: number | null;
  topProducts: { slug: string; title: string; orderCount: number; revenuePesewas: number }[];
  createdBy: number | null;
  createdAt: string;
}

function rowToBaseline(row: Record<string, unknown>): ProductionBaseline {
  return {
    id: row.id as number,
    platformVersion: row.platform_version as string,
    launchDate: row.launch_date as string,
    notes: (row.notes as string | null) ?? null,
    lifetimeRevenuePesewas: row.lifetime_revenue_pesewas as number,
    customerRevenuePesewas: row.customer_revenue_pesewas as number,
    internalRevenuePesewas: row.internal_revenue_pesewas as number,
    developmentRevenuePesewas: row.development_revenue_pesewas as number,
    customersCount: row.customers_count as number,
    ordersCount: row.orders_count as number,
    productsCount: row.products_count as number,
    bundlesCount: row.bundles_count as number,
    resourcesCount: row.resources_count as number,
    downloadsCount: row.downloads_count as number,
    subscribersCount: row.subscribers_count as number,
    reviewsCount: row.reviews_count as number,
    conversionRatePercent: (row.conversion_rate_percent as number | null) ?? null,
    averageOrderValuePesewas: (row.average_order_value_pesewas as number | null) ?? null,
    trafficPageViews: (row.traffic_page_views as number | null) ?? null,
    topProducts: JSON.parse((row.top_products as string) || '[]'),
    createdBy: (row.created_by as number | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export async function listBaselines(env: Env): Promise<ProductionBaseline[]> {
  const rows = await env.DB.prepare(`SELECT * FROM production_launch_baselines ORDER BY created_at DESC`).all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowToBaseline);
}

export async function getLatestBaseline(env: Env): Promise<ProductionBaseline | null> {
  const row = await env.DB.prepare(`SELECT * FROM production_launch_baselines ORDER BY created_at DESC LIMIT 1`).first<Record<string, unknown>>();
  return row ? rowToBaseline(row) : null;
}

export interface CaptureBaselineInput {
  platformVersion: string;
  launchDate?: string;
  notes?: string | null;
}

export async function captureBaseline(env: Env, logger: Logger, actorAdminId: number, input: CaptureBaselineInput): Promise<ProductionBaseline> {
  const kpis = await getKpis(env, 'production');

  const [bundlesRow, downloadsRow, trafficRow, topProductsRows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS c FROM products WHERE is_bundle = 1 AND status = 'active' AND deleted_at IS NULL AND data_classification = 'PRODUCTION'`).first<{
      c: number;
    }>(),
    env.DB.prepare(`SELECT COALESCE(SUM(downloads_used), 0) AS c FROM deliveries WHERE data_classification = 'PRODUCTION'`).first<{ c: number }>(),
    // analytics_events carries no data_classification (anonymous traffic — see migration 0028's exclusion list), so this is a lifetime, unfiltered total, not a PRODUCTION-only figure like everything else here.
    env.DB.prepare(`SELECT COUNT(*) AS c FROM analytics_events WHERE event_type = 'page_view'`)
      .first<{ c: number }>()
      .catch(() => null),
    env.DB.prepare(
      `SELECT ps.product_slug AS slug, COALESCE(p.title, MAX(ps.product_title)) AS title, COUNT(*) AS orderCount, COALESCE(SUM(ps.amount_pesewas), 0) AS revenuePesewas
       FROM purchase_sessions ps
       LEFT JOIN products p ON p.slug = ps.product_slug
       WHERE ps.status = 'verified' AND ps.data_classification = 'PRODUCTION'
       GROUP BY ps.product_slug
       ORDER BY revenuePesewas DESC
       LIMIT 5`
    ).all<{ slug: string; title: string; orderCount: number; revenuePesewas: number }>(),
  ]);

  const launchDate = input.launchDate ?? new Date().toISOString().slice(0, 10);
  const topProducts = topProductsRows.results ?? [];

  const insert = await env.DB.prepare(
    `INSERT INTO production_launch_baselines (
       platform_version, launch_date, notes,
       lifetime_revenue_pesewas, customer_revenue_pesewas, internal_revenue_pesewas, development_revenue_pesewas,
       customers_count, orders_count, products_count, bundles_count, resources_count, downloads_count, subscribers_count, reviews_count,
       conversion_rate_percent, average_order_value_pesewas, traffic_page_views,
       top_products, created_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.platformVersion,
      launchDate,
      input.notes ?? null,
      kpis.revenue.breakdown.totalProcessedPesewas,
      kpis.revenue.breakdown.productionPesewas,
      kpis.revenue.breakdown.internalPesewas,
      kpis.revenue.breakdown.developmentPesewas,
      kpis.totalCustomers,
      kpis.orders.completed,
      kpis.content.publishedBooks,
      bundlesRow?.c ?? 0,
      kpis.content.publishedResources,
      downloadsRow?.c ?? 0,
      kpis.newsletter.totalSubscribers,
      kpis.content.publishedReviews,
      kpis.conversionRate.value,
      kpis.averageOrderValuePesewas,
      trafficRow?.c ?? null,
      JSON.stringify(topProducts),
      actorAdminId
    )
    .run();

  const id = Number(insert.meta.last_row_id);
  const row = await env.DB.prepare(`SELECT * FROM production_launch_baselines WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  const baseline = rowToBaseline(row!);

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId: actorAdminId,
    action: 'production_baseline.captured',
    entityType: 'production_launch_baselines',
    entityId: baseline.id,
    metadata: { platformVersion: baseline.platformVersion, launchDate: baseline.launchDate },
  });
  logger.info('production_baseline.captured', { id: baseline.id, platformVersion: baseline.platformVersion });

  return baseline;
}
