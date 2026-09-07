/**
 * Unit tests: Affiliate Programme 2.0 Phase F reporting foundation —
 * services/admin/executiveDashboardService.ts's
 * getAcquisitionSourceBreakdown(). Verifies the aggregation itself
 * (orders/customers/revenue/commission/net by acquisition_source),
 * matching this codebase's existing convention of testing
 * executiveDashboardService-style aggregates by seeding real D1 rows
 * directly rather than mocking the query.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getAcquisitionSourceBreakdown } from '../../services/admin/executiveDashboardService';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM affiliate_commissions');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM affiliates');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

async function seedVerifiedPurchase(
  reference: string,
  amountPesewas: number,
  acquisitionSource: string,
  options: { customerId?: number | null; dataClassification?: string } = {}
): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions
       (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at, acquisition_source, customer_id, data_classification)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', ?, 'GHS', 'verified', datetime('now'), datetime('now', '+30 minutes'), ?, ?, ?)`
  )
    .bind(reference, TEST_PRODUCT_SLUG, amountPesewas, acquisitionSource, options.customerId ?? null, options.dataClassification ?? 'PRODUCTION')
    .run();
  return Number(insert.meta.last_row_id);
}

describe('getAcquisitionSourceBreakdown', () => {
  it('always returns all 5 sources, zeroed when no purchases exist', async () => {
    const result = await getAcquisitionSourceBreakdown(env as any, 'production');
    expect(result.rows.map((r) => r.source)).toEqual(['affiliate', 'paid', 'organic', 'direct', 'unknown']);
    for (const row of result.rows) {
      expect(row.orders).toBe(0);
      expect(row.grossRevenuePesewas).toBe(0);
      expect(row.commissionPesewas).toBe(0);
    }
  });

  it('aggregates orders and gross revenue per source, verified purchases only', async () => {
    await seedVerifiedPurchase('RWL-RPT-0001', 5000, 'organic');
    await seedVerifiedPurchase('RWL-RPT-0002', 3000, 'organic');
    await seedVerifiedPurchase('RWL-RPT-0003', 4000, 'paid');
    await seedVerifiedPurchase('RWL-RPT-0004', 2000, 'direct');
    // An unpaid/pending session must never be counted as revenue or an order.
    await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, acquisition_source, data_classification)
       VALUES ('RWL-RPT-UNPAID', ?, 'prod-test-guide', 'Test Guide', 9999, 'GHS', 'pending', datetime('now', '+30 minutes'), 'organic', 'PRODUCTION')`
    )
      .bind(TEST_PRODUCT_SLUG)
      .run();

    const result = await getAcquisitionSourceBreakdown(env as any, 'production');
    const organic = result.rows.find((r) => r.source === 'organic')!;
    const paid = result.rows.find((r) => r.source === 'paid')!;
    const direct = result.rows.find((r) => r.source === 'direct')!;

    expect(organic.orders).toBe(2);
    expect(organic.grossRevenuePesewas).toBe(8000);
    expect(paid.orders).toBe(1);
    expect(paid.grossRevenuePesewas).toBe(4000);
    expect(direct.orders).toBe(1);
    expect(direct.grossRevenuePesewas).toBe(2000);
    expect(result.totals.orders).toBe(4); // the pending session is excluded
    expect(result.totals.grossRevenuePesewas).toBe(14000);
  });

  it('counts distinct customers per source, not one row per purchase', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'repeat-buyer@example.com', false);
    await seedVerifiedPurchase('RWL-RPT-0010', 5000, 'organic', { customerId });
    await seedVerifiedPurchase('RWL-RPT-0011', 5000, 'organic', { customerId });

    const result = await getAcquisitionSourceBreakdown(env as any, 'production');
    const organic = result.rows.find((r) => r.source === 'organic')!;
    expect(organic.orders).toBe(2);
    expect(organic.customers).toBe(1);
  });

  it('sums commission for affiliate-attributed purchases and computes net after commission, excluding reversed commissions', async () => {
    const { customerId: affiliateCustomerId } = await findOrCreateCustomer(env as any, 'reporting-affiliate@example.com', false);
    const affiliateInsert = await env.DB.prepare(
      `INSERT INTO affiliates (customer_id, affiliate_code, status, default_commission_percent, data_classification) VALUES (?, 'RWLREPORTTEST', 'approved', 20, 'PRODUCTION')`
    )
      .bind(affiliateCustomerId)
      .run();
    const affiliateId = Number(affiliateInsert.meta.last_row_id);

    const psId1 = await seedVerifiedPurchase('RWL-RPT-0020', 10000, 'affiliate');
    await env.DB.prepare(
      `INSERT INTO affiliate_commissions (affiliate_id, purchase_session_id, product_id, gross_pesewas, commission_percent, commission_pesewas, status, data_classification)
       VALUES (?, ?, (SELECT id FROM products WHERE slug = ?), 10000, 20, 2000, 'approved', 'PRODUCTION')`
    )
      .bind(affiliateId, psId1, TEST_PRODUCT_SLUG)
      .run();

    // A reversed commission must not count against net revenue.
    const psId2 = await seedVerifiedPurchase('RWL-RPT-0021', 5000, 'affiliate');
    await env.DB.prepare(
      `INSERT INTO affiliate_commissions (affiliate_id, purchase_session_id, product_id, gross_pesewas, commission_percent, commission_pesewas, status, reversed_at, reversed_reason, data_classification)
       VALUES (?, ?, (SELECT id FROM products WHERE slug = ?), 5000, 20, 1000, 'reversed', datetime('now'), 'refunded', 'PRODUCTION')`
    )
      .bind(affiliateId, psId2, TEST_PRODUCT_SLUG)
      .run();

    const result = await getAcquisitionSourceBreakdown(env as any, 'production');
    const affiliate = result.rows.find((r) => r.source === 'affiliate')!;
    expect(affiliate.orders).toBe(2);
    expect(affiliate.grossRevenuePesewas).toBe(15000);
    expect(affiliate.commissionPesewas).toBe(2000); // only the approved commission, not the reversed one
    expect(affiliate.netAfterCommissionPesewas).toBe(13000);
  });

  it('respects analyticsMode: a DEVELOPMENT-classified purchase is excluded under production mode and included under all', async () => {
    await seedVerifiedPurchase('RWL-RPT-0030', 7000, 'organic', { dataClassification: 'DEVELOPMENT' });

    const production = await getAcquisitionSourceBreakdown(env as any, 'production');
    expect(production.rows.find((r) => r.source === 'organic')!.orders).toBe(0);

    const all = await getAcquisitionSourceBreakdown(env as any, 'all');
    expect(all.rows.find((r) => r.source === 'organic')!.orders).toBe(1);
  });
});
