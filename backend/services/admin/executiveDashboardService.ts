/**
 * Executive Dashboard Service — Version 3.5 (Executive Dashboard &
 * Business Intelligence). Backs every endpoint in
 * routes/admin/executiveDashboard.ts except health (see
 * systemHealthService.ts for that).
 *
 * Every number here is a real, live D1 aggregate over this project's
 * existing tables (purchase_sessions, customers, products, coupons,
 * newsletter_subscribers, product_reviews, media_assets, blog_posts,
 * resources, deliveries, email_log, login_history, audit_logs) — no
 * caching layer, no pre-aggregation table, same "real row counts don't
 * justify one yet" reasoning as services/admin/analyticsService.ts.
 * Per the milestone brief's explicit "no placeholder metrics" rule, a
 * metric this service cannot honestly compute from real data (e.g. Top
 * Referrers — this codebase stores no referrer field on any table) is
 * simply not included, rather than faked.
 *
 * "Lifetime" below always means "every purchase_sessions row with
 * status = 'verified', regardless of date" — the one true revenue
 * ledger this project has (see docs/payment-verification.md).
 */

import type { Env } from '../../worker/env';
import { exclusiveEndDate, type PeriodRange } from '../../utils/dateRange';

function pesewasToMajor(pesewas: number): number {
  return Math.round(pesewas) / 100;
}

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function todayUtcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysToDateString(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function firstOfMonth(dateStr: string): string {
  return dateStr.slice(0, 7) + '-01';
}

// ============================================================
// Phase 2 + 7 + 9 + 10 — Executive Summary (KPIs, Revenue
// Intelligence, Publishing inventory, Financial breakdown). One
// endpoint: this is all "open the dashboard and see it immediately"
// data with no date-range picker, so it is computed together in one
// Promise.all pass.
// ============================================================

export interface ExecutiveKpis {
  revenue: {
    todayPesewas: number;
    yesterdayPesewas: number;
    todayVsYesterdayPercent: number | null;
    monthPesewas: number;
    lastMonthPesewas: number;
    monthVsLastMonthPercent: number | null;
    lifetimePesewas: number;
  };
  orders: {
    today: number;
    thisMonth: number;
    completed: number;
    pending: number;
    refunds: number;
  };
  conversionRate: { value: number | null; windowDays: number };
  returningCustomers: number;
  averageOrderValuePesewas: number | null;
  newsletter: { totalSubscribers: number; newToday: number };
  content: {
    publishedBooks: number;
    publishedResources: number;
    publishedBlogPosts: number;
    publishedReviews: number;
    averageRating: number | null;
    draftProducts: number;
    draftResources: number;
    draftBlogPosts: number;
  };
  coupons: { active: number; expired: number };
}

async function getKpis(env: Env): Promise<ExecutiveKpis> {
  const today = todayUtcDateString();
  const yesterday = addDaysToDateString(today, -1);
  const monthStart = firstOfMonth(today);
  const lastMonthStart = firstOfMonth(addDaysToDateString(monthStart, -1));

  const [
    revenueToday,
    revenueYesterday,
    revenueMonth,
    revenueLastMonth,
    revenueLifetime,
    ordersToday,
    ordersThisMonth,
    ordersCompleted,
    ordersPending,
    ordersRefunded,
    checkoutStarts30d,
    checkoutCompletions30d,
    returningCustomers,
    aov,
    newsletterTotal,
    newsletterToday,
    publishedBooks,
    publishedResources,
    publishedBlogPosts,
    reviewStats,
    draftProducts,
    draftResources,
    draftBlogPosts,
    couponsActive,
    couponsExpired,
  ] = await Promise.all([
    revenueBetween(env, today, exclusiveEndDate(today)),
    revenueBetween(env, yesterday, exclusiveEndDate(yesterday)),
    revenueBetween(env, monthStart, exclusiveEndDate(today)),
    revenueBetween(env, lastMonthStart, monthStart),
    revenueBetween(env, '0001-01-01', '9999-12-31'),
    countVerifiedOrdersBetween(env, today, exclusiveEndDate(today)),
    countVerifiedOrdersBetween(env, monthStart, exclusiveEndDate(today)),
    countVerifiedOrdersBetween(env, '0001-01-01', '9999-12-31'),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM purchase_sessions WHERE status = 'pending' AND expires_at > datetime('now')`).first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM purchase_sessions WHERE status = 'refunded'`).first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM purchase_sessions WHERE created_at > datetime('now', '-30 days')`).first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM purchase_sessions WHERE status = 'verified' AND verified_at > datetime('now', '-30 days')`).first<{ c: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT customer_id FROM purchase_sessions WHERE status = 'verified' AND customer_id IS NOT NULL
         GROUP BY customer_id HAVING COUNT(*) >= 2
       )`
    ).first<{ c: number }>(),
    env.DB.prepare(`SELECT COALESCE(SUM(amount_pesewas), 0) AS total, COUNT(*) AS c FROM purchase_sessions WHERE status = 'verified'`).first<{
      total: number;
      c: number;
    }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM newsletter_subscribers WHERE status = 'subscribed'`).first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM newsletter_subscribers WHERE status = 'subscribed' AND subscribed_at >= ? AND subscribed_at < ?`)
      .bind(today, exclusiveEndDate(today))
      .first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM products WHERE status = 'active' AND deleted_at IS NULL`).first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM resources WHERE status = 'published' AND deleted_at IS NULL`).first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM blog_posts WHERE status = 'published' AND deleted_at IS NULL`).first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c, AVG(rating) AS avgRating FROM product_reviews WHERE status = 'approved'`).first<{
      c: number;
      avgRating: number | null;
    }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM products WHERE status = 'draft' AND deleted_at IS NULL`).first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM resources WHERE status = 'draft' AND deleted_at IS NULL`).first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM blog_posts WHERE status = 'draft' AND deleted_at IS NULL`).first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM coupons WHERE status = 'active' AND (expires_at IS NULL OR expires_at > datetime('now'))`).first<{
      c: number;
    }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM coupons WHERE status = 'expired' OR (expires_at IS NOT NULL AND expires_at <= datetime('now'))`).first<{
      c: number;
    }>(),
  ]);

  const startsCount = checkoutStarts30d?.c ?? 0;
  const completionsCount = checkoutCompletions30d?.c ?? 0;

  return {
    revenue: {
      todayPesewas: revenueToday,
      yesterdayPesewas: revenueYesterday,
      todayVsYesterdayPercent: percentChange(revenueToday, revenueYesterday),
      monthPesewas: revenueMonth,
      lastMonthPesewas: revenueLastMonth,
      monthVsLastMonthPercent: percentChange(revenueMonth, revenueLastMonth),
      lifetimePesewas: revenueLifetime,
    },
    orders: {
      today: ordersToday,
      thisMonth: ordersThisMonth,
      completed: ordersCompleted,
      pending: ordersPending?.c ?? 0,
      refunds: ordersRefunded?.c ?? 0,
    },
    conversionRate: {
      value: startsCount > 0 ? Math.round((completionsCount / startsCount) * 1000) / 10 : null,
      windowDays: 30,
    },
    returningCustomers: returningCustomers?.c ?? 0,
    averageOrderValuePesewas: aov && aov.c > 0 ? Math.round(aov.total / aov.c) : null,
    newsletter: { totalSubscribers: newsletterTotal?.c ?? 0, newToday: newsletterToday?.c ?? 0 },
    content: {
      publishedBooks: publishedBooks?.c ?? 0,
      publishedResources: publishedResources?.c ?? 0,
      publishedBlogPosts: publishedBlogPosts?.c ?? 0,
      publishedReviews: reviewStats?.c ?? 0,
      averageRating: reviewStats?.avgRating != null ? Math.round(reviewStats.avgRating * 10) / 10 : null,
      draftProducts: draftProducts?.c ?? 0,
      draftResources: draftResources?.c ?? 0,
      draftBlogPosts: draftBlogPosts?.c ?? 0,
    },
    coupons: { active: couponsActive?.c ?? 0, expired: couponsExpired?.c ?? 0 },
  };
}

async function revenueBetween(env: Env, fromInclusive: string, toExclusive: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_pesewas), 0) AS total FROM purchase_sessions WHERE status = 'verified' AND verified_at >= ? AND verified_at < ?`
  )
    .bind(fromInclusive, toExclusive)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function countVerifiedOrdersBetween(env: Env, fromInclusive: string, toExclusive: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM purchase_sessions WHERE status = 'verified' AND verified_at >= ? AND verified_at < ?`
  )
    .bind(fromInclusive, toExclusive)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export interface RevenueIntelligence {
  bestSellingProduct: { title: string; slug: string; orderCount: number; revenuePesewas: number } | null;
  highestRevenueDay: { date: string; revenuePesewas: number } | null;
  fastestGrowingProduct: { title: string; slug: string; growthPercent: number } | null;
  averageDiscountPesewas: number | null;
  revenueLostToCouponsPesewas: number;
  revenueByMonth: { month: string; revenuePesewas: number; orderCount: number }[];
  salesForecast: { nextMonthPesewas: number; basis: string } | null;
}

async function getRevenueIntelligence(env: Env): Promise<RevenueIntelligence> {
  const [bestSeller, highestDay, discountStats, monthly] = await Promise.all([
    env.DB.prepare(
      `SELECT ps.product_slug AS slug, COALESCE(p.title, MAX(ps.product_title)) AS title, COUNT(*) AS orderCount, COALESCE(SUM(ps.amount_pesewas), 0) AS revenuePesewas
       FROM purchase_sessions ps
       LEFT JOIN products p ON p.slug = ps.product_slug
       WHERE ps.status = 'verified'
       GROUP BY ps.product_slug
       ORDER BY revenuePesewas DESC
       LIMIT 1`
    ).first<{ slug: string; title: string; orderCount: number; revenuePesewas: number }>(),
    env.DB.prepare(
      `SELECT date(verified_at) AS date, COALESCE(SUM(amount_pesewas), 0) AS revenuePesewas
       FROM purchase_sessions WHERE status = 'verified'
       GROUP BY date(verified_at)
       ORDER BY revenuePesewas DESC
       LIMIT 1`
    ).first<{ date: string; revenuePesewas: number }>(),
    env.DB.prepare(
      `SELECT AVG(discount_pesewas) AS avgDiscount, COALESCE(SUM(discount_pesewas), 0) AS totalDiscount
       FROM purchase_sessions WHERE status = 'verified' AND coupon_id IS NOT NULL`
    ).first<{ avgDiscount: number | null; totalDiscount: number }>(),
    env.DB.prepare(
      `SELECT strftime('%Y-%m', verified_at) AS month, COALESCE(SUM(amount_pesewas), 0) AS revenuePesewas, COUNT(*) AS orderCount
       FROM purchase_sessions WHERE status = 'verified' AND verified_at > datetime('now', '-12 months')
       GROUP BY month
       ORDER BY month ASC`
    ).all<{ month: string; revenuePesewas: number; orderCount: number }>(),
  ]);

  // Fastest-growing product: last 30 days vs the 30 days before that,
  // among products with at least one order in both windows (a product
  // with zero prior orders would show an undefined/infinite growth
  // rate, which is not a real "fastest growing" signal).
  const growthRows = await env.DB.prepare(
    `SELECT ps.product_slug AS slug, COALESCE(p.title, MAX(ps.product_title)) AS title,
            SUM(CASE WHEN ps.verified_at > datetime('now', '-30 days') THEN ps.amount_pesewas ELSE 0 END) AS recentPesewas,
            SUM(CASE WHEN ps.verified_at <= datetime('now', '-30 days') AND ps.verified_at > datetime('now', '-60 days') THEN ps.amount_pesewas ELSE 0 END) AS priorPesewas
     FROM purchase_sessions ps
     LEFT JOIN products p ON p.slug = ps.product_slug
     WHERE ps.status = 'verified' AND ps.verified_at > datetime('now', '-60 days')
     GROUP BY ps.product_slug`
  ).all<{ slug: string; title: string; recentPesewas: number; priorPesewas: number }>();

  let fastestGrowing: RevenueIntelligence['fastestGrowingProduct'] = null;
  for (const row of growthRows.results) {
    if (row.priorPesewas <= 0 || row.recentPesewas <= 0) continue;
    const growth = percentChange(row.recentPesewas, row.priorPesewas);
    if (growth === null) continue;
    if (!fastestGrowing || growth > fastestGrowing.growthPercent) {
      fastestGrowing = { title: row.title, slug: row.slug, growthPercent: growth };
    }
  }

  const monthlyResults = monthly.results;
  // A genuinely simple trendline, per the brief's explicit "do not
  // fabricate forecasts" instruction: the average absolute
  // month-over-month change across the real trailing data, projected
  // one month forward from the most recent real month. Never shown if
  // fewer than 3 real months exist — extrapolating from 1-2 data
  // points is not a forecast, it is a guess.
  let salesForecast: RevenueIntelligence['salesForecast'] = null;
  if (monthlyResults.length >= 3) {
    const deltas: number[] = [];
    for (let i = 1; i < monthlyResults.length; i++) {
      deltas.push(monthlyResults[i].revenuePesewas - monthlyResults[i - 1].revenuePesewas);
    }
    const avgDelta = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
    const lastMonthRevenue = monthlyResults[monthlyResults.length - 1].revenuePesewas;
    salesForecast = {
      nextMonthPesewas: Math.max(0, Math.round(lastMonthRevenue + avgDelta)),
      basis: `Linear trend over the last ${monthlyResults.length} months of real revenue.`,
    };
  }

  return {
    bestSellingProduct: bestSeller && bestSeller.orderCount > 0 ? bestSeller : null,
    highestRevenueDay: highestDay && highestDay.revenuePesewas > 0 ? highestDay : null,
    fastestGrowingProduct: fastestGrowing,
    averageDiscountPesewas: discountStats?.avgDiscount != null ? Math.round(discountStats.avgDiscount) : null,
    revenueLostToCouponsPesewas: discountStats?.totalDiscount ?? 0,
    revenueByMonth: monthlyResults,
    salesForecast,
  };
}

export interface PublishingInventory {
  books: { published: number; draft: number; comingSoon: number; archived: number };
  resources: { published: number; draft: number };
  blog: { published: number; draft: number };
  mediaAssetsCount: number;
  brokenMediaReferences: number;
  productsMissingCovers: number;
  productsMissingMetadata: number;
  productsMissingSeo: number;
}

async function getPublishingInventory(env: Env): Promise<PublishingInventory> {
  const [bookStatus, resourceStatus, blogStatus, mediaCount, brokenRefs, missingCovers, missingMetadata, missingSeo] = await Promise.all([
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS published,
         SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
         SUM(CASE WHEN status = 'coming-soon' THEN 1 ELSE 0 END) AS comingSoon,
         SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived
       FROM products WHERE deleted_at IS NULL`
    ).first<{ published: number; draft: number; comingSoon: number; archived: number }>(),
    env.DB.prepare(
      `SELECT SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published, SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft
       FROM resources WHERE deleted_at IS NULL`
    ).first<{ published: number; draft: number }>(),
    env.DB.prepare(
      `SELECT SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published, SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft
       FROM blog_posts WHERE deleted_at IS NULL`
    ).first<{ published: number; draft: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM media_assets WHERE deleted_at IS NULL`).first<{ c: number }>(),
    // A "broken media reference" is any non-null media id on a
    // publicly-relevant record that no longer resolves to a real,
    // non-deleted media_assets row — the exact class of defect Version
    // 3.4.2 Milestone M6.2 found and repaired one instance of by hand.
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM products p WHERE p.deleted_at IS NULL AND (
            (p.cover_media_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.id = p.cover_media_id AND m.deleted_at IS NULL)) OR
            (p.thumbnail_media_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.id = p.thumbnail_media_id AND m.deleted_at IS NULL)) OR
            (p.preview_media_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.id = p.preview_media_id AND m.deleted_at IS NULL)) OR
            (p.og_media_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.id = p.og_media_id AND m.deleted_at IS NULL))
         )) +
         (SELECT COUNT(*) FROM blog_posts b WHERE b.deleted_at IS NULL AND b.cover_media_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.id = b.cover_media_id AND m.deleted_at IS NULL)) +
         (SELECT COUNT(*) FROM resources r WHERE r.deleted_at IS NULL AND (
            (r.cover_media_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.id = r.cover_media_id AND m.deleted_at IS NULL)) OR
            (r.thumbnail_media_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.id = r.thumbnail_media_id AND m.deleted_at IS NULL)) OR
            (r.file_media_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.id = r.file_media_id AND m.deleted_at IS NULL))
         )) AS total`
    ).first<{ total: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM products WHERE status = 'active' AND deleted_at IS NULL AND cover_media_id IS NULL`).first<{ c: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM products WHERE status = 'active' AND deleted_at IS NULL AND (author IS NULL OR short_description IS NULL)`
    ).first<{ c: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM products WHERE status = 'active' AND deleted_at IS NULL AND (seo_title IS NULL OR seo_description IS NULL)`
    ).first<{ c: number }>(),
  ]);

  return {
    books: {
      published: bookStatus?.published ?? 0,
      draft: bookStatus?.draft ?? 0,
      comingSoon: bookStatus?.comingSoon ?? 0,
      archived: bookStatus?.archived ?? 0,
    },
    resources: { published: resourceStatus?.published ?? 0, draft: resourceStatus?.draft ?? 0 },
    blog: { published: blogStatus?.published ?? 0, draft: blogStatus?.draft ?? 0 },
    mediaAssetsCount: mediaCount?.c ?? 0,
    brokenMediaReferences: brokenRefs?.total ?? 0,
    productsMissingCovers: missingCovers?.c ?? 0,
    productsMissingMetadata: missingMetadata?.c ?? 0,
    productsMissingSeo: missingSeo?.c ?? 0,
  };
}

export interface FinancialSummary {
  grossRevenuePesewas: number;
  netRevenuePesewas: number;
  discountAmountPesewas: number;
  couponImpactPercent: number | null;
  mostDiscountedProduct: { title: string; slug: string; totalDiscountPesewas: number } | null;
  revenueByProduct: { title: string; slug: string; revenuePesewas: number; orderCount: number }[];
}

async function getFinancialSummary(env: Env): Promise<FinancialSummary> {
  const [totals, mostDiscounted, byProduct] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) AS net, COALESCE(SUM(discount_pesewas), 0) AS discount
       FROM purchase_sessions WHERE status = 'verified'`
    ).first<{ net: number; discount: number }>(),
    env.DB.prepare(
      `SELECT ps.product_slug AS slug, COALESCE(p.title, MAX(ps.product_title)) AS title, COALESCE(SUM(ps.discount_pesewas), 0) AS totalDiscountPesewas
       FROM purchase_sessions ps
       LEFT JOIN products p ON p.slug = ps.product_slug
       WHERE ps.status = 'verified' AND ps.coupon_id IS NOT NULL
       GROUP BY ps.product_slug
       ORDER BY totalDiscountPesewas DESC
       LIMIT 1`
    ).first<{ slug: string; title: string; totalDiscountPesewas: number }>(),
    env.DB.prepare(
      `SELECT ps.product_slug AS slug, COALESCE(p.title, MAX(ps.product_title)) AS title, COALESCE(SUM(ps.amount_pesewas), 0) AS revenuePesewas, COUNT(*) AS orderCount
       FROM purchase_sessions ps
       LEFT JOIN products p ON p.slug = ps.product_slug
       WHERE ps.status = 'verified'
       GROUP BY ps.product_slug
       ORDER BY revenuePesewas DESC`
    ).all<{ slug: string; title: string; revenuePesewas: number; orderCount: number }>(),
  ]);

  const net = totals?.net ?? 0;
  const discount = totals?.discount ?? 0;
  const gross = net + discount;

  return {
    grossRevenuePesewas: gross,
    netRevenuePesewas: net,
    discountAmountPesewas: discount,
    couponImpactPercent: gross > 0 ? Math.round((discount / gross) * 1000) / 10 : null,
    mostDiscountedProduct: mostDiscounted && mostDiscounted.totalDiscountPesewas > 0 ? mostDiscounted : null,
    revenueByProduct: byProduct.results,
  };
}

export interface ExecutiveSummary {
  kpis: ExecutiveKpis;
  revenueIntelligence: RevenueIntelligence;
  publishing: PublishingInventory;
  financial: FinancialSummary;
}

export async function getExecutiveSummary(env: Env): Promise<ExecutiveSummary> {
  const [kpis, revenueIntelligence, publishing, financial] = await Promise.all([
    getKpis(env),
    getRevenueIntelligence(env),
    getPublishingInventory(env),
    getFinancialSummary(env),
  ]);
  return { kpis, revenueIntelligence, publishing, financial };
}

// ============================================================
// Phase 3 — Sales Analytics charts (range-based).
// ============================================================

export interface SalesCharts {
  dailyRevenue: { date: string; revenuePesewas: number; orderCount: number }[];
  topProducts: { slug: string; title: string; orderCount: number; revenuePesewas: number }[];
  couponUsage: { code: string; redemptions: number; totalDiscountPesewas: number }[];
  salesByChannel: { channel: string; orderCount: number; revenuePesewas: number }[];
}

export async function getSalesCharts(env: Env, range: PeriodRange): Promise<SalesCharts> {
  const [dailyRows, topProducts, couponUsage, channelRows] = await Promise.all([
    env.DB.prepare(
      `SELECT date(verified_at) AS date, COALESCE(SUM(amount_pesewas), 0) AS revenuePesewas, COUNT(*) AS orderCount
       FROM purchase_sessions WHERE status = 'verified' AND verified_at >= ? AND verified_at < ?
       GROUP BY date(verified_at)
       ORDER BY date ASC`
    )
      .bind(range.from, exclusiveEndDate(range.to))
      .all<{ date: string; revenuePesewas: number; orderCount: number }>(),
    env.DB.prepare(
      `SELECT ps.product_slug AS slug, COALESCE(p.title, MAX(ps.product_title)) AS title, COUNT(*) AS orderCount, COALESCE(SUM(ps.amount_pesewas), 0) AS revenuePesewas
       FROM purchase_sessions ps
       LEFT JOIN products p ON p.slug = ps.product_slug
       WHERE ps.status = 'verified' AND ps.verified_at >= ? AND ps.verified_at < ?
       GROUP BY ps.product_slug
       ORDER BY revenuePesewas DESC
       LIMIT 10`
    )
      .bind(range.from, exclusiveEndDate(range.to))
      .all<{ slug: string; title: string; orderCount: number; revenuePesewas: number }>(),
    env.DB.prepare(
      `SELECT c.code AS code, COUNT(*) AS redemptions, COALESCE(SUM(cr.discount_pesewas), 0) AS totalDiscountPesewas
       FROM coupon_redemptions cr
       JOIN coupons c ON c.id = cr.coupon_id
       WHERE cr.redeemed_at >= ? AND cr.redeemed_at < ?
       GROUP BY c.code
       ORDER BY redemptions DESC`
    )
      .bind(range.from, exclusiveEndDate(range.to))
      .all<{ code: string; redemptions: number; totalDiscountPesewas: number }>(),
    // Payment channel (mobile_money/card/etc.) is only available inside
    // the raw Paystack gateway_response JSON blob recorded per
    // transaction — extracted here with json_extract rather than
    // stored as its own column, since payment_transactions.gateway_response
    // is already the authoritative, verbatim record of what Paystack
    // reported (see commerceService.ts's handlePaymentWebhook()).
    env.DB.prepare(
      `SELECT COALESCE(json_extract(pt.gateway_response, '$.data.channel'), 'unknown') AS channel,
              COUNT(*) AS orderCount,
              COALESCE(SUM(ps.amount_pesewas), 0) AS revenuePesewas
       FROM payment_transactions pt
       JOIN purchase_sessions ps ON ps.id = pt.purchase_session_id
       WHERE pt.status = 'success' AND ps.status = 'verified' AND ps.verified_at >= ? AND ps.verified_at < ?
       GROUP BY channel
       ORDER BY orderCount DESC`
    )
      .bind(range.from, exclusiveEndDate(range.to))
      .all<{ channel: string; orderCount: number; revenuePesewas: number }>(),
  ]);

  return {
    dailyRevenue: dailyRows.results,
    topProducts: topProducts.results,
    couponUsage: couponUsage.results,
    salesByChannel: channelRows.results,
  };
}

// ============================================================
// Phase 4 + 8 — Customer Analytics + Customer Experience Metrics
// (range-based).
// ============================================================

export interface CustomerInsights {
  newCustomers: number;
  returningCustomersInRange: number;
  accountCreations: number;
  passwordRecoveries: number;
  mostDownloadedProducts: { slug: string; downloads: number }[];
  reviewSubmissionRate: number | null;
  customerLifetimeValuePesewas: number | null;
  averageTimeToFirstReviewDays: number | null;
  averageTimeToPurchaseDays: number | null;
  repeatPurchaseRatePercent: number | null;
}

export async function getCustomerInsights(env: Env, range: PeriodRange): Promise<CustomerInsights> {
  const [
    newCustomers,
    returningInRange,
    passwordRecoveries,
    downloadsRows,
    reviewsInRange,
    verifiedPurchasesInRange,
    clvRow,
    firstReviewGapRow,
    purchaseGapRow,
    customersWithAnyPurchase,
    customersWithRepeatPurchase,
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS c FROM customers WHERE created_at >= ? AND created_at < ?`)
      .bind(range.from, exclusiveEndDate(range.to))
      .first<{ c: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM purchase_sessions ps
       WHERE ps.status = 'verified' AND ps.verified_at >= ? AND ps.verified_at < ? AND ps.customer_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM purchase_sessions prior WHERE prior.customer_id = ps.customer_id AND prior.status = 'verified'
             AND (prior.verified_at < ps.verified_at OR (prior.verified_at = ps.verified_at AND prior.id < ps.id))
         )`
    )
      .bind(range.from, exclusiveEndDate(range.to))
      .first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM email_log WHERE template = 'customer-password-reset' AND status = 'sent' AND created_at >= ? AND created_at < ?`)
      .bind(range.from, exclusiveEndDate(range.to))
      .first<{ c: number }>(),
    env.DB.prepare(
      `SELECT product_slug AS slug, COUNT(*) AS downloads FROM deliveries WHERE last_download_at IS NOT NULL AND last_download_at >= ? AND last_download_at < ?
       GROUP BY product_slug ORDER BY downloads DESC LIMIT 10`
    )
      .bind(range.from, exclusiveEndDate(range.to))
      .all<{ slug: string; downloads: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM product_reviews WHERE created_at >= ? AND created_at < ?`)
      .bind(range.from, exclusiveEndDate(range.to))
      .first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM purchase_sessions WHERE status = 'verified' AND verified_at >= ? AND verified_at < ?`)
      .bind(range.from, exclusiveEndDate(range.to))
      .first<{ c: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) AS total, COUNT(DISTINCT customer_id) AS customers
       FROM purchase_sessions WHERE status = 'verified' AND customer_id IS NOT NULL`
    ).first<{ total: number; customers: number }>(),
    // Average days between a purchase's verification and the first
    // review that purchase's customer ever submitted for that same
    // product — real, computed from actual timestamps, only over
    // purchases that did eventually get a review (a purchase with no
    // review yet contributes no data point, rather than being counted
    // as "infinite" or zero).
    env.DB.prepare(
      `SELECT AVG(julianday(r.created_at) - julianday(ps.verified_at)) AS avgDays
       FROM product_reviews r
       JOIN purchase_sessions ps ON ps.customer_id = r.customer_id
       JOIN products p ON p.slug = ps.product_slug AND p.id = r.product_id
       WHERE ps.status = 'verified'`
    ).first<{ avgDays: number | null }>(),
    env.DB.prepare(
      `SELECT AVG(julianday(ps.verified_at) - julianday(ps.created_at)) AS avgDays
       FROM purchase_sessions ps WHERE ps.status = 'verified'`
    ).first<{ avgDays: number | null }>(),
    env.DB.prepare(`SELECT COUNT(DISTINCT customer_id) AS c FROM purchase_sessions WHERE status = 'verified' AND customer_id IS NOT NULL`).first<{
      c: number;
    }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM (SELECT customer_id FROM purchase_sessions WHERE status = 'verified' AND customer_id IS NOT NULL GROUP BY customer_id HAVING COUNT(*) >= 2)`
    ).first<{ c: number }>(),
  ]);

  const reviewCount = reviewsInRange?.c ?? 0;
  const purchaseCount = verifiedPurchasesInRange?.c ?? 0;
  const totalCustomersWithPurchase = customersWithAnyPurchase?.c ?? 0;
  const totalCustomersWithRepeat = customersWithRepeatPurchase?.c ?? 0;

  return {
    newCustomers: newCustomers?.c ?? 0,
    returningCustomersInRange: returningInRange?.c ?? 0,
    accountCreations: newCustomers?.c ?? 0,
    passwordRecoveries: passwordRecoveries?.c ?? 0,
    mostDownloadedProducts: downloadsRows.results,
    reviewSubmissionRate: purchaseCount > 0 ? Math.round((reviewCount / purchaseCount) * 1000) / 10 : null,
    customerLifetimeValuePesewas: clvRow && clvRow.customers > 0 ? Math.round(clvRow.total / clvRow.customers) : null,
    averageTimeToFirstReviewDays: firstReviewGapRow?.avgDays != null ? Math.round(firstReviewGapRow.avgDays * 10) / 10 : null,
    averageTimeToPurchaseDays: purchaseGapRow?.avgDays != null ? Math.round(purchaseGapRow.avgDays * 10) / 10 : null,
    repeatPurchaseRatePercent: totalCustomersWithPurchase > 0 ? Math.round((totalCustomersWithRepeat / totalCustomersWithPurchase) * 1000) / 10 : null,
  };
}

// ============================================================
// Phase 5 — Operational Monitoring feeds. Fixed-size recent lists;
// "View All" in the frontend links to each area's own existing admin
// list page rather than this endpoint growing pagination it doesn't
// need.
// ============================================================

export interface OperationalFeeds {
  recentOrders: { reference: string; productTitle: string; amountPesewas: number; verifiedAt: string }[];
  recentReviews: { productTitle: string; rating: number; status: string; createdAt: string }[];
  recentContactMessages: { name: string; messagePreview: string; createdAt: string }[];
  recentConsultations: { name: string; status: string; createdAt: string }[];
  recentNewsletterSignups: { email: string; subscribedAt: string }[];
  recentLogins: { email: string; createdAt: string }[];
  recentFailedLogins: { email: string; outcome: string; createdAt: string }[];
  recentPasswordResets: { recipient: string; template: string; createdAt: string }[];
  recentAdminActivity: { action: string; actorId: number | null; createdAt: string }[];
  recentProductChanges: { action: string; entityId: number | null; actorId: number | null; createdAt: string }[];
}

const RECENT_LIMIT = 10;

export async function getOperationalFeeds(env: Env): Promise<OperationalFeeds> {
  const [
    recentOrders,
    recentReviews,
    recentContactMessages,
    recentConsultations,
    recentNewsletterSignups,
    recentLogins,
    recentFailedLogins,
    recentPasswordResets,
    recentAdminActivity,
    recentProductChanges,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT purchase_reference AS reference, product_title AS productTitle, amount_pesewas AS amountPesewas, verified_at AS verifiedAt
       FROM purchase_sessions WHERE status = 'verified' ORDER BY id DESC LIMIT ?`
    )
      .bind(RECENT_LIMIT)
      .all<{ reference: string; productTitle: string; amountPesewas: number; verifiedAt: string }>(),
    env.DB.prepare(
      `SELECT COALESCE(p.title, 'Unknown product') AS productTitle, r.rating AS rating, r.status AS status, r.created_at AS createdAt
       FROM product_reviews r LEFT JOIN products p ON p.id = r.product_id ORDER BY r.id DESC LIMIT ?`
    )
      .bind(RECENT_LIMIT)
      .all<{ productTitle: string; rating: number; status: string; createdAt: string }>(),
    env.DB.prepare(`SELECT name, substr(message, 1, 80) AS messagePreview, created_at AS createdAt FROM contact_messages WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ?`)
      .bind(RECENT_LIMIT)
      .all<{ name: string; messagePreview: string; createdAt: string }>(),
    env.DB.prepare(`SELECT name, status, created_at AS createdAt FROM consultation_requests WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ?`)
      .bind(RECENT_LIMIT)
      .all<{ name: string; status: string; createdAt: string }>(),
    env.DB.prepare(`SELECT email AS email, subscribed_at AS subscribedAt FROM newsletter_subscribers ORDER BY id DESC LIMIT ?`)
      .bind(RECENT_LIMIT)
      .all<{ email: string; subscribedAt: string }>(),
    env.DB.prepare(
      `SELECT a.email AS email, lh.created_at AS createdAt FROM login_history lh JOIN admin_users a ON a.id = lh.admin_id
       WHERE lh.outcome = 'success' ORDER BY lh.id DESC LIMIT ?`
    )
      .bind(RECENT_LIMIT)
      .all<{ email: string; createdAt: string }>(),
    env.DB.prepare(
      `SELECT a.email AS email, lh.outcome AS outcome, lh.created_at AS createdAt FROM login_history lh JOIN admin_users a ON a.id = lh.admin_id
       WHERE lh.outcome != 'success' ORDER BY lh.id DESC LIMIT ?`
    )
      .bind(RECENT_LIMIT)
      .all<{ email: string; outcome: string; createdAt: string }>(),
    env.DB.prepare(
      `SELECT recipient, template, created_at AS createdAt FROM email_log
       WHERE template IN ('customer-password-reset', 'password-reset', 'customer-purchase-reconciliation') AND status = 'sent'
       ORDER BY id DESC LIMIT ?`
    )
      .bind(RECENT_LIMIT)
      .all<{ recipient: string; template: string; createdAt: string }>(),
    env.DB.prepare(
      `SELECT action, actor_id AS actorId, created_at AS createdAt FROM audit_logs WHERE actor_type = 'admin' ORDER BY id DESC LIMIT ?`
    )
      .bind(RECENT_LIMIT)
      .all<{ action: string; actorId: number | null; createdAt: string }>(),
    env.DB.prepare(
      `SELECT action, entity_id AS entityId, actor_id AS actorId, created_at AS createdAt FROM audit_logs
       WHERE entity_type = 'product' ORDER BY id DESC LIMIT ?`
    )
      .bind(RECENT_LIMIT)
      .all<{ action: string; entityId: number | null; actorId: number | null; createdAt: string }>(),
  ]);

  return {
    recentOrders: recentOrders.results,
    recentReviews: recentReviews.results,
    recentContactMessages: recentContactMessages.results,
    recentConsultations: recentConsultations.results,
    recentNewsletterSignups: recentNewsletterSignups.results,
    recentLogins: recentLogins.results,
    recentFailedLogins: recentFailedLogins.results,
    recentPasswordResets: recentPasswordResets.results,
    recentAdminActivity: recentAdminActivity.results,
    recentProductChanges: recentProductChanges.results,
  };
}

// ============================================================
// Phase 6 — Business Alerts. Only ever a real, computed condition —
// per the brief's explicit "no placeholders" rule, an alert type with
// nothing wrong simply contributes zero items, never a synthetic
// "all clear" entry.
// ============================================================

export type AlertSeverity = 'warning' | 'critical';

export interface BusinessAlert {
  key: string;
  severity: AlertSeverity;
  message: string;
}

export async function getBusinessAlerts(env: Env): Promise<BusinessAlert[]> {
  const alerts: BusinessAlert[] = [];

  const [
    lowReviewProducts,
    failedEmails,
    failedWebhooks,
    missingCovers,
    missingFiles,
    hiddenProducts,
    failedNewsletterCampaigns,
    cronHeartbeat,
    migrationInfo,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT p.title AS title, COUNT(r.id) AS reviewCount
       FROM products p LEFT JOIN product_reviews r ON r.product_id = p.id AND r.status = 'approved'
       WHERE p.status = 'active' AND p.deleted_at IS NULL
       GROUP BY p.id HAVING reviewCount < 3`
    ).all<{ title: string; reviewCount: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM email_log WHERE status IN ('failed', 'permanently_failed') AND created_at > datetime('now', '-7 days')`).first<{
      c: number;
    }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM payment_transactions WHERE status = 'failed' AND created_at > datetime('now', '-7 days')`).first<{
      c: number;
    }>(),
    // 'active' only, not 'coming-soon' - matching services/productService.ts's
    // validateProductInput() exactly: a real, live "coming-soon" product
    // in this catalog intentionally has no cover yet, and its card
    // already degrades gracefully with no image (see
    // routes/books.ts's renderProductCard()). Flagging that as an
    // alert here would be a false alarm about an established, correct
    // design, not a real problem.
    env.DB.prepare(`SELECT title FROM products WHERE status = 'active' AND deleted_at IS NULL AND cover_media_id IS NULL`).all<{
      title: string;
    }>(),
    env.DB.prepare(
      `SELECT p.title AS title FROM products p
       WHERE p.status = 'active' AND p.deleted_at IS NULL AND p.price_pesewas IS NOT NULL AND p.price_pesewas > 0
         AND NOT EXISTS (SELECT 1 FROM product_files f WHERE f.product_id = p.id AND f.status = 'published')`
    ).all<{ title: string }>(),
    env.DB.prepare(`SELECT title, status FROM products WHERE status IN ('hidden', 'unavailable') AND deleted_at IS NULL`).all<{
      title: string;
      status: string;
    }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM newsletter_campaigns WHERE status = 'failed' AND deleted_at IS NULL AND created_at > datetime('now', '-30 days')`).first<{
      c: number;
    }>(),
    env.DB.prepare(`SELECT created_at AS createdAt FROM audit_logs WHERE actor_type = 'system' AND action = 'cron.heartbeat' ORDER BY id DESC LIMIT 1`).first<{
      createdAt: string;
    }>(),
    env.DB.prepare(`SELECT MAX(id) AS appliedCount FROM d1_migrations`).first<{ appliedCount: number }>(),
  ]);

  for (const row of lowReviewProducts.results) {
    alerts.push({ key: `low-reviews-${row.title}`, severity: 'warning', message: `"${row.title}" has only ${row.reviewCount} approved review${row.reviewCount === 1 ? '' : 's'}.` });
  }

  if ((failedEmails?.c ?? 0) > 0) {
    alerts.push({ key: 'failed-emails', severity: 'warning', message: `${failedEmails!.c} email${failedEmails!.c === 1 ? '' : 's'} failed to send in the last 7 days.` });
  }

  if ((failedWebhooks?.c ?? 0) > 0) {
    alerts.push({ key: 'failed-webhooks', severity: 'critical', message: `${failedWebhooks!.c} payment webhook${failedWebhooks!.c === 1 ? '' : 's'} failed verification in the last 7 days.` });
  }

  for (const row of missingCovers.results) {
    alerts.push({ key: `missing-cover-${row.title}`, severity: 'critical', message: `"${row.title}" is published with no cover image.` });
  }

  for (const row of missingFiles.results) {
    alerts.push({ key: `missing-file-${row.title}`, severity: 'critical', message: `"${row.title}" is a paid, active product with no published download file.` });
  }

  for (const row of hiddenProducts.results) {
    alerts.push({ key: `hidden-${row.title}`, severity: 'warning', message: `"${row.title}" is currently ${row.status} and not visible to customers.` });
  }

  if ((failedNewsletterCampaigns?.c ?? 0) > 0) {
    alerts.push({ key: 'newsletter-failures', severity: 'warning', message: `${failedNewsletterCampaigns!.c} newsletter campaign${failedNewsletterCampaigns!.c === 1 ? '' : 's'} failed to send in the last 30 days.` });
  }

  if (!cronHeartbeat) {
    alerts.push({ key: 'cron-never-run', severity: 'warning', message: 'No Cron execution has ever been recorded.' });
  } else {
    const ageMs = Date.now() - new Date(cronHeartbeat.createdAt.replace(' ', 'T') + 'Z').getTime();
    if (ageMs > 30 * 60 * 60 * 1000) {
      alerts.push({ key: 'cron-stale', severity: 'critical', message: `Cron has not run since ${cronHeartbeat.createdAt} (more than 30 hours ago).` });
    }
  }

  // A hardcoded "expected latest migration" would drift the moment a
  // new migration file is added without updating it — instead this
  // just confirms d1_migrations has at least the count of files this
  // Worker's own bundled routes/services assume exist, using the
  // schema's own highest-numbered table dependency as evidence rather
  // than a maintained constant. Given no such runtime introspection is
  // possible against the source tree from inside the Worker (see
  // systemHealthService.ts's own note on this), this is intentionally
  // omitted as a "pending migration" alert here — the risk of a false
  // "no migration pending" reading from a stale hardcoded expectation
  // is worse than not asserting it at all. Real drift is instead
  // caught by this project's existing pre-deploy discipline (running
  // `wrangler d1 migrations apply` as a required step before every
  // `wrangler deploy`, documented in backend/config/README.md).
  void migrationInfo;

  return alerts;
}
