/**
 * Profitability Service — P0-D (Business Intelligence backbone,
 * Profitability & Campaign Performance Reporting). Follows
 * executiveDashboardService.ts's own established architecture exactly:
 * live D1 aggregates over existing tables, no caching layer, no
 * pre-aggregation table — see that file's own header comment for the
 * "real row counts don't justify one yet" reasoning this inherits.
 *
 * Canonical inputs, none of them new (see the P0-D investigation
 * report): `purchase_sessions.amount_pesewas`/`status`/`verified_at`/
 * `data_classification`/`utm_campaign`/`attribution_confidence`,
 * `payment_transactions.fee_pesewas`/`status`, `ad_spend_entries.*`.
 * This file computes CONTRIBUTION, never "profit"/"gross profit"/
 * "net profit"/"earnings" — those require cost data (COGS, overhead,
 * tax) this platform does not track, and the P0-D investigation was
 * explicit that using those labels would overstate what the number
 * means. Never that word anywhere below, including comments.
 *
 * Currency discipline: this codebase has no FX infrastructure and an
 * explicit written precedent against fabricating one (see
 * services/ai/types.ts's own `estimateCostUsdMicros()` doc comment).
 * Ad spend is therefore only ever summed within a single currency —
 * Contribution/ROAS/Cost-per-Attributed-Purchase are computed from the
 * GHS slice of spend only (the currency purchases are actually
 * denominated in); any other currency is reported separately, never
 * blended or converted.
 */

import type { Env } from '../../worker/env';
import { exclusiveEndDate, type PeriodRange } from '../../utils/dateRange';
import { ANALYTICS_MODE_CLASSIFICATIONS, classificationPredicate, type AnalyticsMode } from './executiveDashboardService';

const REVENUE_CURRENCY = 'GHS';

function pesewasToMajor(pesewas: number): number {
  return Math.round(pesewas) / 100;
}

// ============================================================
// Platform summary
// ============================================================

export interface PlatformProfitability {
  range: PeriodRange;
  analyticsMode: AnalyticsMode;
  purchaseCount: number;
  grossRevenuePesewas: number;
  paystackFeesPesewas: number;
  /**
   * Verified purchases in range with no successful payment_transactions
   * row carrying a fee — real, not a rounding artifact. The one
   * confirmed source: services/commerceService.ts's
   * adminReprocessPurchase() completes a purchase without ever writing
   * payment_transactions (see the P0-D investigation report, Section
   * 2). `paystackFeesPesewas` above already COALESCEs each such
   * purchase's fee to 0 rather than dropping it from the sum — this
   * count exists so the UI can disclose that gap instead of silently
   * implying the fee is genuinely zero.
   */
  feeUnknownPurchaseCount: number;
  adSpendByCurrency: { currency: string; amountMinorUnits: number }[];
  /** The one slice of adSpendByCurrency that actually participates in contributionPesewas below — GHS is the only currency purchases are denominated in today. */
  ghsAdSpendMinorUnits: number;
  contributionPesewas: number;
  /** null when grossRevenuePesewas is 0 — a percentage of nothing is undefined, never displayed as 0%. */
  contributionMarginPercent: number | null;
  /** Revenue from purchase_sessions.attribution_confidence = 'utm' only — see getCampaignProfitability()'s own comment for why this can exceed the sum of every campaign row's own revenue. */
  attributedRevenuePesewas: number;
  /** Everything else: 'meta_click', 'unknown', and NULL — never treated as lost revenue, only as revenue this platform cannot honestly credit to a named campaign. */
  unattributedRevenuePesewas: number;
}

interface PlatformAggregateRow {
  purchaseCount: number;
  grossRevenuePesewas: number;
  paystackFeesPesewas: number;
  feeUnknownPurchaseCount: number;
  attributedRevenuePesewas: number;
  unattributedRevenuePesewas: number;
}

export async function getPlatformProfitability(env: Env, range: PeriodRange, analyticsMode: AnalyticsMode): Promise<PlatformProfitability> {
  const cls = classificationPredicate(ANALYTICS_MODE_CLASSIFICATIONS[analyticsMode], 'ps.data_classification');
  const fromInclusive = range.from;
  const toExclusive = exclusiveEndDate(range.to);

  const [aggregateRow, adSpendRows] = await Promise.all([
    env.DB.prepare(
      `SELECT
         COUNT(*) AS purchaseCount,
         COALESCE(SUM(ps.amount_pesewas), 0) AS grossRevenuePesewas,
         COALESCE(SUM(feeAgg.fee_pesewas), 0) AS paystackFeesPesewas,
         SUM(CASE WHEN feeAgg.fee_pesewas IS NULL THEN 1 ELSE 0 END) AS feeUnknownPurchaseCount,
         COALESCE(SUM(CASE WHEN ps.attribution_confidence = 'utm' THEN ps.amount_pesewas ELSE 0 END), 0) AS attributedRevenuePesewas,
         COALESCE(SUM(CASE WHEN ps.attribution_confidence != 'utm' OR ps.attribution_confidence IS NULL THEN ps.amount_pesewas ELSE 0 END), 0) AS unattributedRevenuePesewas
       FROM purchase_sessions ps
       LEFT JOIN (
         SELECT purchase_session_id, SUM(fee_pesewas) AS fee_pesewas
         FROM payment_transactions
         WHERE status = 'success'
         GROUP BY purchase_session_id
       ) feeAgg ON feeAgg.purchase_session_id = ps.id
       WHERE ps.status = 'verified' AND ps.verified_at >= ? AND ps.verified_at < ? AND ${cls.sql}`
    )
      .bind(fromInclusive, toExclusive, ...cls.params)
      .first<PlatformAggregateRow>(),
    env.DB.prepare(
      `SELECT currency, COALESCE(SUM(amount_minor_units), 0) AS amountMinorUnits
       FROM ad_spend_entries
       WHERE deleted_at IS NULL AND entry_date >= ? AND entry_date <= ?
       GROUP BY currency
       ORDER BY currency`
    )
      .bind(range.from, range.to)
      .all<{ currency: string; amountMinorUnits: number }>(),
  ]);

  const agg: PlatformAggregateRow = aggregateRow ?? {
    purchaseCount: 0,
    grossRevenuePesewas: 0,
    paystackFeesPesewas: 0,
    feeUnknownPurchaseCount: 0,
    attributedRevenuePesewas: 0,
    unattributedRevenuePesewas: 0,
  };

  const adSpendByCurrency = adSpendRows.results ?? [];
  const ghsAdSpendMinorUnits = adSpendByCurrency.find((r) => r.currency === REVENUE_CURRENCY)?.amountMinorUnits ?? 0;

  const contributionPesewas = agg.grossRevenuePesewas - agg.paystackFeesPesewas - ghsAdSpendMinorUnits;
  const contributionMarginPercent = agg.grossRevenuePesewas > 0 ? Math.round((contributionPesewas / agg.grossRevenuePesewas) * 1000) / 10 : null;

  return {
    range,
    analyticsMode,
    purchaseCount: agg.purchaseCount,
    grossRevenuePesewas: agg.grossRevenuePesewas,
    paystackFeesPesewas: agg.paystackFeesPesewas,
    feeUnknownPurchaseCount: agg.feeUnknownPurchaseCount,
    adSpendByCurrency,
    ghsAdSpendMinorUnits,
    contributionPesewas,
    contributionMarginPercent,
    attributedRevenuePesewas: agg.attributedRevenuePesewas,
    unattributedRevenuePesewas: agg.unattributedRevenuePesewas,
  };
}

// ============================================================
// Campaign performance
// ============================================================

export interface CampaignProfitability {
  campaignLabel: string;
  ghsSpendMinorUnits: number;
  purchaseCount: number;
  attributedRevenuePesewas: number;
  paystackFeesPesewas: number;
  feeUnknownPurchaseCount: number;
  contributionPesewas: number;
  /** Attributed Gross Revenue / GHS Ad Spend — never labeled bare "ROAS", see the P0-D blueprint's Section 7. null when ghsSpendMinorUnits is 0. */
  revenueRoas: number | null;
  /** Attributed Contribution / GHS Ad Spend. null when ghsSpendMinorUnits is 0. */
  contributionRoas: number | null;
  /** Ad Spend / UTM-attributed purchase count — deliberately never called CAC or "customer acquisition cost" (repeat purchases and nullable customer_id make real CAC uncomputable; see the P0-D investigation report, Section 9). null when purchaseCount is 0. */
  costPerAttributedPurchasePesewas: number | null;
}

export interface CampaignProfitabilityResult {
  campaigns: CampaignProfitability[];
  /**
   * Ad spend in any currency other than GHS, for a campaign_label that
   * has no honest way to participate in the GHS contribution table
   * above (see getPlatformProfitability()'s own comment and the P0-D
   * blueprint's Section 3/4 currency rules). Never converted, never
   * summed into a GHS figure — reported here exactly as entered.
   */
  nonGhsSpend: { campaignLabel: string; currency: string; amountMinorUnits: number }[];
}

function normalizeCampaignKey(label: string): string {
  return label.trim().toLowerCase();
}

interface AdSpendCampaignRow {
  campaignKey: string;
  campaignLabel: string;
  currency: string;
  amountMinorUnits: number;
}

interface PurchaseCampaignRow {
  campaignKey: string;
  campaignLabel: string;
  purchaseCount: number;
  attributedRevenuePesewas: number;
  paystackFeesPesewas: number;
  feeUnknownPurchaseCount: number;
}

/**
 * Campaign-level attribution is restricted to
 * `attribution_confidence = 'utm'` only — a `meta_click` purchase
 * proves a Meta ad was clicked, never which campaign, and `unknown`/
 * NULL carry no campaign evidence at all (see the P0-D blueprint's
 * Section 4). Matching against `ad_spend_entries.campaign_label` is
 * case- and whitespace-insensitive (`LOWER(TRIM(...))` on both sides),
 * per Section 5 — SQLite's default collation is otherwise exact-byte,
 * which this codebase's two independently-typed campaign-label fields
 * (a free-text ledger entry vs. a URL parameter) cannot be assumed to
 * match under.
 *
 * The sum of every campaign row's own `attributedRevenuePesewas` can
 * be LESS than `getPlatformProfitability()`'s own
 * `attributedRevenuePesewas` for the same range: a purchase can have
 * `attribution_confidence = 'utm'` (a real utm_source/utm_medium was
 * captured) while `utm_campaign` itself is NULL — genuinely
 * UTM-attributed, but to no named campaign. That purchase counts at
 * the platform level and is correctly absent from every campaign row
 * here, never guessed into one.
 */
export async function getCampaignProfitability(env: Env, range: PeriodRange, analyticsMode: AnalyticsMode): Promise<CampaignProfitabilityResult> {
  const cls = classificationPredicate(ANALYTICS_MODE_CLASSIFICATIONS[analyticsMode], 'ps.data_classification');
  const toExclusive = exclusiveEndDate(range.to);

  const [adSpendRows, purchaseRows] = await Promise.all([
    env.DB.prepare(
      `SELECT LOWER(TRIM(campaign_label)) AS campaignKey, TRIM(campaign_label) AS campaignLabel, currency,
              COALESCE(SUM(amount_minor_units), 0) AS amountMinorUnits
       FROM ad_spend_entries
       WHERE deleted_at IS NULL AND entry_date >= ? AND entry_date <= ?
       GROUP BY campaignKey, currency`
    )
      .bind(range.from, range.to)
      .all<AdSpendCampaignRow>(),
    env.DB.prepare(
      `SELECT LOWER(TRIM(ps.utm_campaign)) AS campaignKey, TRIM(ps.utm_campaign) AS campaignLabel,
              COUNT(*) AS purchaseCount,
              COALESCE(SUM(ps.amount_pesewas), 0) AS attributedRevenuePesewas,
              COALESCE(SUM(feeAgg.fee_pesewas), 0) AS paystackFeesPesewas,
              SUM(CASE WHEN feeAgg.fee_pesewas IS NULL THEN 1 ELSE 0 END) AS feeUnknownPurchaseCount
       FROM purchase_sessions ps
       LEFT JOIN (
         SELECT purchase_session_id, SUM(fee_pesewas) AS fee_pesewas
         FROM payment_transactions
         WHERE status = 'success'
         GROUP BY purchase_session_id
       ) feeAgg ON feeAgg.purchase_session_id = ps.id
       WHERE ps.status = 'verified' AND ps.attribution_confidence = 'utm' AND ps.utm_campaign IS NOT NULL
         AND ps.verified_at >= ? AND ps.verified_at < ? AND ${cls.sql}
       GROUP BY campaignKey`
    )
      .bind(range.from, toExclusive, ...cls.params)
      .all<PurchaseCampaignRow>(),
  ]);

  const byKey = new Map<string, CampaignProfitability>();
  const nonGhsSpend: { campaignLabel: string; currency: string; amountMinorUnits: number }[] = [];

  for (const row of purchaseRows.results ?? []) {
    byKey.set(row.campaignKey, {
      campaignLabel: row.campaignLabel,
      ghsSpendMinorUnits: 0,
      purchaseCount: row.purchaseCount,
      attributedRevenuePesewas: row.attributedRevenuePesewas,
      paystackFeesPesewas: row.paystackFeesPesewas,
      feeUnknownPurchaseCount: row.feeUnknownPurchaseCount,
      contributionPesewas: 0, // computed below, once spend is known
      revenueRoas: null,
      contributionRoas: null,
      costPerAttributedPurchasePesewas: null,
    });
  }

  for (const row of adSpendRows.results ?? []) {
    if (row.currency !== REVENUE_CURRENCY) {
      nonGhsSpend.push({ campaignLabel: row.campaignLabel, currency: row.currency, amountMinorUnits: row.amountMinorUnits });
      continue;
    }
    const existing = byKey.get(row.campaignKey);
    if (existing) {
      existing.ghsSpendMinorUnits = row.amountMinorUnits;
    } else {
      byKey.set(row.campaignKey, {
        campaignLabel: row.campaignLabel,
        ghsSpendMinorUnits: row.amountMinorUnits,
        purchaseCount: 0,
        attributedRevenuePesewas: 0,
        paystackFeesPesewas: 0,
        feeUnknownPurchaseCount: 0,
        contributionPesewas: 0,
        revenueRoas: null,
        contributionRoas: null,
        costPerAttributedPurchasePesewas: null,
      });
    }
  }

  const campaigns = Array.from(byKey.values()).map((c) => {
    const contributionPesewas = c.attributedRevenuePesewas - c.paystackFeesPesewas - c.ghsSpendMinorUnits;
    const revenueRoas = c.ghsSpendMinorUnits > 0 ? Math.round((c.attributedRevenuePesewas / c.ghsSpendMinorUnits) * 1000) / 1000 : null;
    const contributionRoas = c.ghsSpendMinorUnits > 0 ? Math.round((contributionPesewas / c.ghsSpendMinorUnits) * 1000) / 1000 : null;
    const costPerAttributedPurchasePesewas = c.purchaseCount > 0 ? Math.round(c.ghsSpendMinorUnits / c.purchaseCount) : null;
    return { ...c, contributionPesewas, revenueRoas, contributionRoas, costPerAttributedPurchasePesewas };
  });

  campaigns.sort((a, b) => b.attributedRevenuePesewas - a.attributedRevenuePesewas || b.ghsSpendMinorUnits - a.ghsSpendMinorUnits);

  return { campaigns, nonGhsSpend };
}

export { pesewasToMajor };
