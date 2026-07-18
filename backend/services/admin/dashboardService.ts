/**
 * Admin Dashboard Service — Version 2.0 Phase 0.2 (Admin Shell). Backs
 * `GET /api/admin/dashboard/summary`, per `docs/v2-architecture.md`'s
 * `routes/admin/dashboard.ts` ("summary KPIs").
 *
 * Every figure here is a real, current D1 aggregate — nothing invented,
 * nothing estimated. Per the Phase 0.2 brief's explicit "no fake data"
 * rule: a metric this service cannot honestly compute yet is returned
 * as `null`, and the frontend renders "No data yet" for it rather than
 * a placeholder number.
 *
 * `productsCount` was `null` unconditionally through Phase 0.2 — at
 * that point the product catalog still lived in `content/products/*.json`
 * on the static site, not in D1. Version 2.0 Phase 2 (Products Module)
 * migrated the catalog into a real `products` D1 table, but this field
 * was never wired to it — found and fixed in Phase 3 Stage 4 (see
 * docs/v2.0-phase3-architecture-plan.md, Section 4/5). Same
 * fault-tolerant "degrade to null on error, never fake a number"
 * pattern as every other field here.
 */

import type { Env } from '../../worker/env';

export interface DashboardSummary {
  orders: { count: number; revenuePesewas: number } | null;
  subscribers: { count: number } | null;
  consultations: { count: number; newCount: number } | null;
  contacts: { count: number; newCount: number } | null;
  productsCount: number | null;
  recentActivity: RecentActivityItem[];
}

export interface RecentActivityItem {
  action: string;
  actorType: string;
  createdAt: string;
}

/**
 * One query per real data source, each independently reducible to
 * `null` if it fails — a transient fault in one figure (e.g. a locked
 * table) should never blank out the entire dashboard, matching this
 * project's established "degrade one piece, not the whole page"
 * posture (e.g. `emailService.ts`'s send-failure handling).
 */
export async function getDashboardSummary(env: Env): Promise<DashboardSummary> {
  const [orders, subscribers, consultations, contacts, productsCount, recentActivity] = await Promise.all([
    getOrdersSummary(env),
    getSubscribersSummary(env),
    getConsultationsSummary(env),
    getContactsSummary(env),
    getProductsCount(env),
    getRecentActivity(env),
  ]);

  return { orders, subscribers, consultations, contacts, productsCount, recentActivity };
}

async function getProductsCount(env: Env): Promise<DashboardSummary['productsCount']> {
  try {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM products WHERE deleted_at IS NULL`).first<{ count: number }>();
    return row ? row.count : null;
  } catch {
    return null;
  }
}

async function getOrdersSummary(env: Env): Promise<DashboardSummary['orders']> {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount_pesewas), 0) AS revenuePesewas
       FROM purchase_sessions WHERE status = 'verified'`
    ).first<{ count: number; revenuePesewas: number }>();
    return row ? { count: row.count, revenuePesewas: row.revenuePesewas } : null;
  } catch {
    return null;
  }
}

async function getSubscribersSummary(env: Env): Promise<DashboardSummary['subscribers']> {
  try {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM newsletter_subscribers WHERE status = 'subscribed'`).first<{
      count: number;
    }>();
    return row ? { count: row.count } : null;
  } catch {
    return null;
  }
}

async function getConsultationsSummary(env: Env): Promise<DashboardSummary['consultations']> {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count, SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS newCount FROM consultation_requests`
    ).first<{ count: number; newCount: number | null }>();
    return row ? { count: row.count, newCount: row.newCount ?? 0 } : null;
  } catch {
    return null;
  }
}

async function getContactsSummary(env: Env): Promise<DashboardSummary['contacts']> {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count, SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS newCount FROM contact_messages`
    ).first<{ count: number; newCount: number | null }>();
    return row ? { count: row.count, newCount: row.newCount ?? 0 } : null;
  } catch {
    return null;
  }
}

/** Most recent real audit_logs rows — empty array (not null) when nothing has happened yet, since "no activity" is itself a valid, renderable state (an empty-state message), not a fetch failure. */
async function getRecentActivity(env: Env): Promise<RecentActivityItem[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT action, actor_type AS actorType, created_at AS createdAt FROM audit_logs ORDER BY id DESC LIMIT 10`
    ).all<RecentActivityItem>();
    return results ?? [];
  } catch {
    return [];
  }
}
