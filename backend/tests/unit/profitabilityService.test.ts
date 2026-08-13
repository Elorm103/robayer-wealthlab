/**
 * Unit tests: profitability & campaign performance reporting — P0-D
 * (Business Intelligence backbone). Seeds purchase_sessions/
 * payment_transactions/ad_spend_entries directly via SQL (not through
 * the real checkout flow) so every financial edge case — refunded,
 * fee-unknown, multi-currency spend, attribution tiers, campaign-label
 * casing — can be constructed precisely and in isolation, matching
 * tests/unit/adSpendService.test.ts's own direct-D1-seeding convention
 * for this codebase's admin/reporting services.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getPlatformProfitability, getCampaignProfitability } from '../../services/admin/profitabilityService';
import { getSalesCharts } from '../../services/admin/executiveDashboardService';
import { exclusiveEndDate, type PeriodRange } from '../../utils/dateRange';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM payment_transactions');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM ad_spend_entries');
  await env.DB.exec('DELETE FROM admin_users');
});

let refCounter = 0;
function nextReference(): string {
  refCounter += 1;
  return `RWL-2026-P0D-${String(refCounter).padStart(6, '0')}`;
}

interface SeedPurchaseOverrides {
  status?: string;
  amountPesewas?: number;
  verifiedAt?: string | null;
  utmCampaign?: string | null;
  attributionConfidence?: string | null;
  dataClassification?: 'PRODUCTION' | 'INTERNAL' | 'DEVELOPMENT' | 'UNKNOWN';
}

async function seedPurchaseSession(overrides: SeedPurchaseOverrides = {}): Promise<number> {
  const reference = nextReference();
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions
       (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at,
        verified_at, utm_campaign, attribution_confidence, data_classification)
     VALUES (?, 'test-guide', 'prod-test-guide', 'Test Guide', ?, 'GHS', ?, datetime('now', '+30 minutes'), ?, ?, ?, ?)`
  )
    .bind(
      reference,
      overrides.amountPesewas ?? 3900,
      overrides.status ?? 'verified',
      overrides.verifiedAt ?? '2026-08-10 12:00:00',
      overrides.utmCampaign ?? null,
      overrides.attributionConfidence ?? null,
      overrides.dataClassification ?? 'PRODUCTION'
    )
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedPaymentTransaction(purchaseSessionId: number, overrides: { status?: string; feePesewas?: number | null; amountPesewas?: number } = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO payment_transactions (purchase_session_id, paystack_reference, amount_pesewas, currency, status, fee_pesewas)
     VALUES (?, ?, ?, 'GHS', ?, ?)`
  )
    .bind(purchaseSessionId, `paystack-${nextReference()}`, overrides.amountPesewas ?? 3900, overrides.status ?? 'success', overrides.feePesewas ?? null)
    .run();
}

async function seedAdmin(): Promise<number> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role) VALUES (?, 'x:1:x', 'super_admin')`)
    .bind(`admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedAdSpend(overrides: { entryDate?: string; campaignLabel?: string; amountMinorUnits?: number; currency?: string; deletedAt?: string | null } = {}): Promise<void> {
  const adminId = await seedAdmin();
  await env.DB.prepare(
    `INSERT INTO ad_spend_entries (entry_date, source, campaign_label, amount_minor_units, currency, created_by, deleted_at)
     VALUES (?, 'meta', ?, ?, ?, ?, ?)`
  )
    .bind(
      overrides.entryDate ?? '2026-08-10',
      overrides.campaignLabel ?? 'Test Campaign',
      overrides.amountMinorUnits ?? 1000,
      overrides.currency ?? 'GHS',
      adminId,
      overrides.deletedAt ?? null
    )
    .run();
}

const RANGE: PeriodRange = { from: '2026-08-01', to: '2026-08-31' };

describe('getPlatformProfitability — revenue inclusion rules', () => {
  it('counts a verified purchase', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 3900 });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.grossRevenuePesewas).toBe(3900);
    expect(result.purchaseCount).toBe(1);
  });

  it('excludes a failed purchase', async () => {
    await seedPurchaseSession({ status: 'failed', amountPesewas: 3900 });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.grossRevenuePesewas).toBe(0);
  });

  it('excludes a pending purchase', async () => {
    await seedPurchaseSession({ status: 'pending', amountPesewas: 3900 });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.grossRevenuePesewas).toBe(0);
  });

  it('excludes an expired purchase', async () => {
    await seedPurchaseSession({ status: 'expired', amountPesewas: 3900 });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.grossRevenuePesewas).toBe(0);
  });

  it('excludes a refunded purchase — status no longer verified is the entire mechanism, no separate refund calculation exists', async () => {
    await seedPurchaseSession({ status: 'refunded', amountPesewas: 3900 });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.grossRevenuePesewas).toBe(0);
  });
});

describe('getPlatformProfitability — Paystack fee rules', () => {
  it('counts a successful transaction fee exactly once', async () => {
    const id = await seedPurchaseSession({ status: 'verified' });
    await seedPaymentTransaction(id, { status: 'success', feePesewas: 65 });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.paystackFeesPesewas).toBe(65);
    expect(result.feeUnknownPurchaseCount).toBe(0);
  });

  it('excludes a failed transaction fee', async () => {
    const id = await seedPurchaseSession({ status: 'verified' });
    await seedPaymentTransaction(id, { status: 'failed', feePesewas: null });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.paystackFeesPesewas).toBe(0);
    // A failed payment_transactions row is not "the" transaction for this purchase — fee is still unknown.
    expect(result.feeUnknownPurchaseCount).toBe(1);
  });

  it('handles a verified purchase with no payment_transactions row at all without crashing, and flags it as fee-unknown (the admin-reprocess gap)', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 3900 });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.grossRevenuePesewas).toBe(3900);
    expect(result.paystackFeesPesewas).toBe(0);
    expect(result.feeUnknownPurchaseCount).toBe(1);
  });
});

describe('getPlatformProfitability — ad spend rules', () => {
  it('includes active spend', async () => {
    await seedAdSpend({ amountMinorUnits: 47000, currency: 'GHS' });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.ghsAdSpendMinorUnits).toBe(47000);
  });

  it('excludes soft-deleted spend', async () => {
    await seedAdSpend({ amountMinorUnits: 47000, currency: 'GHS', deletedAt: '2026-08-11 00:00:00' });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.ghsAdSpendMinorUnits).toBe(0);
  });

  it('sums multiple spend rows for the same currency', async () => {
    await seedAdSpend({ amountMinorUnits: 1000, currency: 'GHS', campaignLabel: 'A' });
    await seedAdSpend({ amountMinorUnits: 2500, currency: 'GHS', campaignLabel: 'B' });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.ghsAdSpendMinorUnits).toBe(3500);
  });

  it('keeps currencies separate — never blends or converts', async () => {
    await seedAdSpend({ amountMinorUnits: 200000, currency: 'GHS' });
    await seedAdSpend({ amountMinorUnits: 2500, currency: 'USD' });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.ghsAdSpendMinorUnits).toBe(200000);
    const usdRow = result.adSpendByCurrency.find((r) => r.currency === 'USD');
    expect(usdRow?.amountMinorUnits).toBe(2500);
    // Contribution must never silently include the USD figure.
    expect(result.contributionPesewas).toBe(0 - 0 - 200000);
  });
});

describe('getPlatformProfitability — contribution and margin', () => {
  it('computes contribution as grossRevenue - fees - GHS ad spend', async () => {
    const id = await seedPurchaseSession({ status: 'verified', amountPesewas: 10_000 });
    await seedPaymentTransaction(id, { status: 'success', feePesewas: 500 });
    await seedAdSpend({ amountMinorUnits: 2000, currency: 'GHS' });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.contributionPesewas).toBe(10_000 - 500 - 2000);
    expect(result.contributionMarginPercent).toBe(75); // 7500 / 10000
  });

  it('returns null contribution margin when gross revenue is zero, never Infinity/NaN', async () => {
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.grossRevenuePesewas).toBe(0);
    expect(result.contributionMarginPercent).toBeNull();
  });
});

describe('getPlatformProfitability — attribution tiers', () => {
  it('separates attributed (utm) from unattributed (meta_click/unknown/NULL) revenue', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 1000, attributionConfidence: 'utm', utmCampaign: 'Camp A' });
    await seedPurchaseSession({ status: 'verified', amountPesewas: 2000, attributionConfidence: 'meta_click' });
    await seedPurchaseSession({ status: 'verified', amountPesewas: 3000, attributionConfidence: 'unknown' });
    await seedPurchaseSession({ status: 'verified', amountPesewas: 4000, attributionConfidence: null });

    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.attributedRevenuePesewas).toBe(1000);
    expect(result.unattributedRevenuePesewas).toBe(2000 + 3000 + 4000);
    expect(result.grossRevenuePesewas).toBe(1000 + 2000 + 3000 + 4000); // unattributed is never treated as lost revenue
  });
});

describe('getPlatformProfitability — date range', () => {
  it('includes the range start date and correctly handles the range end date via exclusiveEndDate()', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 100, verifiedAt: '2026-08-01 00:00:01' }); // start
    await seedPurchaseSession({ status: 'verified', amountPesewas: 200, verifiedAt: '2026-08-31 23:59:59' }); // end, with a time component
    await seedPurchaseSession({ status: 'verified', amountPesewas: 400, verifiedAt: '2026-09-01 00:00:00' }); // outside range

    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.grossRevenuePesewas).toBe(300);
    expect(exclusiveEndDate(RANGE.to)).toBe('2026-09-01'); // sanity-check the exact utility this depends on
  });

  it('dates revenue by verified_at, not created_at', async () => {
    // created_at defaults to now (outside RANGE, since tests run "today"); verified_at is explicitly inside RANGE.
    await seedPurchaseSession({ status: 'verified', amountPesewas: 500, verifiedAt: '2026-08-15 00:00:00' });
    const result = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(result.grossRevenuePesewas).toBe(500);
  });
});

describe('getPlatformProfitability — analytics mode / classification filtering', () => {
  it('production mode includes only PRODUCTION rows, matching the Executive Dashboard', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 1000, dataClassification: 'PRODUCTION' });
    await seedPurchaseSession({ status: 'verified', amountPesewas: 2000, dataClassification: 'INTERNAL' });
    await seedPurchaseSession({ status: 'verified', amountPesewas: 3000, dataClassification: 'DEVELOPMENT' });
    await seedPurchaseSession({ status: 'verified', amountPesewas: 4000, dataClassification: 'UNKNOWN' });

    const production = await getPlatformProfitability(env as any, RANGE, 'production');
    expect(production.grossRevenuePesewas).toBe(1000);

    const productionInternal = await getPlatformProfitability(env as any, RANGE, 'production_internal');
    expect(productionInternal.grossRevenuePesewas).toBe(1000 + 2000);

    const all = await getPlatformProfitability(env as any, RANGE, 'all');
    expect(all.grossRevenuePesewas).toBe(1000 + 2000 + 3000 + 4000);
  });
});

describe('getPlatformProfitability — parity with the Executive Dashboard (critical regression)', () => {
  it('grossRevenuePesewas exactly equals the sum of getSalesCharts().dailyRevenue for the identical range and analyticsMode', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 3900, verifiedAt: '2026-08-05 10:00:00', dataClassification: 'PRODUCTION' });
    await seedPurchaseSession({ status: 'verified', amountPesewas: 4900, verifiedAt: '2026-08-20 14:30:00', dataClassification: 'PRODUCTION' });
    await seedPurchaseSession({ status: 'refunded', amountPesewas: 9900, verifiedAt: '2026-08-12 09:00:00', dataClassification: 'PRODUCTION' });
    await seedPurchaseSession({ status: 'verified', amountPesewas: 1200, verifiedAt: '2026-08-18 09:00:00', dataClassification: 'INTERNAL' });

    for (const analyticsMode of ['production', 'production_internal', 'all'] as const) {
      const [ours, theirs] = await Promise.all([
        getPlatformProfitability(env as any, RANGE, analyticsMode),
        getSalesCharts(env as any, RANGE, analyticsMode),
      ]);
      const theirTotal = theirs.dailyRevenue.reduce((sum, row) => sum + row.revenuePesewas, 0);
      expect(ours.grossRevenuePesewas).toBe(theirTotal);
    }
  });
});

describe('getCampaignProfitability — attribution and matching rules', () => {
  it('attributes a utm purchase to its campaign', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 3900, attributionConfidence: 'utm', utmCampaign: 'RWL | Book 3' });
    await seedAdSpend({ campaignLabel: 'RWL | Book 3', amountMinorUnits: 1000, currency: 'GHS' });

    const result = await getCampaignProfitability(env as any, RANGE, 'all');
    expect(result.campaigns).toHaveLength(1);
    expect(result.campaigns[0].attributedRevenuePesewas).toBe(3900);
    expect(result.campaigns[0].purchaseCount).toBe(1);
  });

  it('never attributes a meta_click purchase to a campaign, even platform-level unattributed revenue', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 3900, attributionConfidence: 'meta_click' });
    const result = await getCampaignProfitability(env as any, RANGE, 'all');
    expect(result.campaigns).toHaveLength(0);
  });

  it('never attributes an unknown-confidence purchase to a campaign', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 3900, attributionConfidence: 'unknown', utmCampaign: 'Should Not Match' });
    const result = await getCampaignProfitability(env as any, RANGE, 'all');
    expect(result.campaigns).toHaveLength(0);
  });

  it('never attributes a NULL-confidence purchase to a campaign', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 3900, attributionConfidence: null });
    const result = await getCampaignProfitability(env as any, RANGE, 'all');
    expect(result.campaigns).toHaveLength(0);
  });

  it('a utm purchase whose campaign has no matching ad spend still appears, unattributed to any spend (spend = 0, not dropped)', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 3900, attributionConfidence: 'utm', utmCampaign: 'Orphan Campaign' });
    const result = await getCampaignProfitability(env as any, RANGE, 'all');
    expect(result.campaigns).toHaveLength(1);
    expect(result.campaigns[0].ghsSpendMinorUnits).toBe(0);
    expect(result.campaigns[0].attributedRevenuePesewas).toBe(3900);
  });

  it('matches campaign_label and utm_campaign case-insensitively', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 3900, attributionConfidence: 'utm', utmCampaign: 'summer sale' });
    await seedAdSpend({ campaignLabel: 'SUMMER SALE', amountMinorUnits: 1000, currency: 'GHS' });
    const result = await getCampaignProfitability(env as any, RANGE, 'all');
    expect(result.campaigns).toHaveLength(1);
    expect(result.campaigns[0].ghsSpendMinorUnits).toBe(1000);
    expect(result.campaigns[0].attributedRevenuePesewas).toBe(3900);
  });

  it('matches campaign_label and utm_campaign despite surrounding whitespace', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 3900, attributionConfidence: 'utm', utmCampaign: '  Winter Push ' });
    await seedAdSpend({ campaignLabel: 'Winter Push', amountMinorUnits: 1000, currency: 'GHS' });
    const result = await getCampaignProfitability(env as any, RANGE, 'all');
    expect(result.campaigns).toHaveLength(1);
    expect(result.campaigns[0].ghsSpendMinorUnits).toBe(1000);
  });

  it('reports non-GHS spend separately, excluded from the main campaign contribution table', async () => {
    await seedAdSpend({ campaignLabel: 'USD Only Campaign', amountMinorUnits: 5000, currency: 'USD' });
    const result = await getCampaignProfitability(env as any, RANGE, 'all');
    expect(result.campaigns.find((c) => c.campaignLabel.toLowerCase() === 'usd only campaign')).toBeUndefined();
    expect(result.nonGhsSpend).toEqual([{ campaignLabel: 'USD Only Campaign', currency: 'USD', amountMinorUnits: 5000 }]);
  });
});

describe('getCampaignProfitability — ROAS/CPA and division-by-zero rules', () => {
  it('computes Revenue ROAS and Contribution ROAS correctly', async () => {
    const id = await seedPurchaseSession({ status: 'verified', amountPesewas: 10_000, attributionConfidence: 'utm', utmCampaign: 'Camp' });
    await seedPaymentTransaction(id, { status: 'success', feePesewas: 500 });
    await seedAdSpend({ campaignLabel: 'Camp', amountMinorUnits: 2000, currency: 'GHS' });

    const result = await getCampaignProfitability(env as any, RANGE, 'all');
    const campaign = result.campaigns[0];
    expect(campaign.revenueRoas).toBe(Math.round((10_000 / 2000) * 1000) / 1000);
    expect(campaign.contributionRoas).toBe(Math.round(((10_000 - 500 - 2000) / 2000) * 1000) / 1000);
  });

  it('returns null Revenue ROAS and Contribution ROAS when ad spend is zero — never Infinity or NaN', async () => {
    await seedPurchaseSession({ status: 'verified', amountPesewas: 3900, attributionConfidence: 'utm', utmCampaign: 'No Spend Campaign' });
    const result = await getCampaignProfitability(env as any, RANGE, 'all');
    const campaign = result.campaigns[0];
    expect(campaign.revenueRoas).toBeNull();
    expect(campaign.contributionRoas).toBeNull();
    expect(Number.isFinite(campaign.contributionPesewas)).toBe(true); // contribution itself is still a real number
  });

  it('returns null Cost per Attributed Purchase when there are zero attributed purchases — never Infinity or NaN', async () => {
    await seedAdSpend({ campaignLabel: 'Spend No Purchases', amountMinorUnits: 5000, currency: 'GHS' });
    const result = await getCampaignProfitability(env as any, RANGE, 'all');
    const campaign = result.campaigns.find((c) => c.campaignLabel === 'Spend No Purchases');
    expect(campaign?.costPerAttributedPurchasePesewas).toBeNull();
    expect(campaign?.contributionPesewas).toBe(-5000); // real, negative contribution — spend with no attributed return
  });
});
