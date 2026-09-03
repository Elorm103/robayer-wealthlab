/**
 * Integration tests: the affiliate payout ledger. Threshold
 * enforcement, atomic commission claiming, the requested -> approved ->
 * paid state machine, failure/cancellation releasing claimed
 * commissions back to the payable pool, and audit logging. Calls
 * affiliatePayoutService.ts directly (real D1, no HTTP layer), the
 * same convention affiliateCommission.test.ts's refund-reversal tests
 * already use for revokePurchase().
 *
 * No payment provider is integrated (explicit product decision):
 * processPayout() only records that an admin already paid the affiliate
 * externally and logs a real reference; it never moves money itself.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { requestPayout, approvePayout, processPayout, failPayout, cancelPayout, MIN_PAYOUT_PESEWAS } from '../../services/affiliatePayoutService';
import { createLogger } from '../../utils/logger';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM affiliate_payouts');
  await env.DB.exec('DELETE FROM affiliate_commissions');
  await env.DB.exec('DELETE FROM affiliates');
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM email_log');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await env.DB.exec('DELETE FROM admin_users');
  await env.DB.exec('DELETE FROM products');
});

const logger = createLogger('test-request-id', 'test.payout');

async function seedAffiliate(email: string, code: string, payoutMethod: 'mobile_money' | 'bank_transfer' | null = 'mobile_money'): Promise<number> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const insert = await env.DB.prepare(
    `INSERT INTO affiliates (customer_id, affiliate_code, status, default_commission_percent, payout_method, data_classification) VALUES (?, ?, 'approved', 20, ?, 'PRODUCTION')`
  )
    .bind(customerId, code, payoutMethod)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedAdmin(): Promise<number> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', 'super_admin', 1)`)
    .bind(`payout-admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedPayableCommission(affiliateId: number, commissionPesewas: number): Promise<number> {
  const productInsert = await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES (?, ?, 'Test Product', 'investing', 'ebook', 'active', 3900, 'GHS', 'one-time', 'inclusive', 'en')`
  )
    .bind(`prod-payout-${Math.random().toString(36).slice(2)}`, `payout-test-${Math.random().toString(36).slice(2)}`)
    .run();
  const productId = Number(productInsert.meta.last_row_id);

  const sessionInsert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at)
     VALUES (?, 'payout-test', ?, 'Test Product', ?, 'GHS', 'verified', datetime('now', '+1 hour'))`
  )
    .bind(`RWL-PAYOUT-TEST-${Math.random().toString(36).slice(2)}`, productId, commissionPesewas * 5)
    .run();

  const commissionInsert = await env.DB.prepare(
    `INSERT INTO affiliate_commissions (affiliate_id, purchase_session_id, product_id, gross_pesewas, commission_percent, commission_pesewas, status, payable_at, data_classification)
     VALUES (?, ?, ?, ?, 20, ?, 'payable', datetime('now'), 'PRODUCTION')`
  )
    .bind(affiliateId, Number(sessionInsert.meta.last_row_id), productId, commissionPesewas * 5, commissionPesewas)
    .run();
  return Number(commissionInsert.meta.last_row_id);
}

describe('requestPayout(): threshold and eligibility', () => {
  it('rejects a request with no payout method configured yet', async () => {
    const affiliateId = await seedAffiliate('no-method@example.com', 'RWLNOMETHOD', null);
    await seedPayableCommission(affiliateId, MIN_PAYOUT_PESEWAS);

    const result = await requestPayout(env as any, logger, affiliateId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_payout_method');
  });

  it('rejects a request with zero payable balance', async () => {
    const affiliateId = await seedAffiliate('zero-balance@example.com', 'RWLZEROBAL');
    const result = await requestPayout(env as any, logger, affiliateId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_payable_balance');
  });

  it('rejects a request below the minimum payout threshold', async () => {
    const affiliateId = await seedAffiliate('below-threshold@example.com', 'RWLBELOWMIN');
    await seedPayableCommission(affiliateId, MIN_PAYOUT_PESEWAS - 100);

    const result = await requestPayout(env as any, logger, affiliateId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('below_threshold');
  });

  it('accepts a request at or above the threshold, atomically claiming every unclaimed payable commission', async () => {
    const affiliateId = await seedAffiliate('at-threshold@example.com', 'RWLATTHRESH');
    await seedPayableCommission(affiliateId, MIN_PAYOUT_PESEWAS);
    await seedPayableCommission(affiliateId, 1000); // a second payable commission, both should be claimed together

    const result = await requestPayout(env as any, logger, affiliateId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amountPesewas).toBe(MIN_PAYOUT_PESEWAS + 1000);

    const claimed = await env.DB.prepare(`SELECT COUNT(*) AS n FROM affiliate_commissions WHERE affiliate_id = ? AND payout_id = ?`).bind(affiliateId, result.payoutId).first<any>();
    expect(claimed.n).toBe(2);

    const audit = await env.DB.prepare(`SELECT action FROM audit_logs WHERE entity_type = 'affiliate_payout' AND entity_id = ?`).bind(result.payoutId).first<any>();
    expect(audit.action).toBe('affiliate.payout_requested');
  });

  it('a second request while the first is still outstanding has nothing left to claim (no double-claiming)', async () => {
    const affiliateId = await seedAffiliate('double-claim@example.com', 'RWLDOUBLECLAIM');
    await seedPayableCommission(affiliateId, MIN_PAYOUT_PESEWAS);

    const first = await requestPayout(env as any, logger, affiliateId);
    expect(first.ok).toBe(true);

    const second = await requestPayout(env as any, logger, affiliateId);
    expect(second.ok).toBe(false); // the only payable commission is already claimed by the first payout
    if (!second.ok) expect(second.reason).toBe('no_payable_balance');
  });

  it('two GENUINELY CONCURRENT requestPayout() calls (fired together, not awaited sequentially) can never both succeed for the same balance', async () => {
    // Promise.all, not two sequential awaits: the same true-concurrency
    // technique tests/integration/couponRaceConditions.test.ts already
    // uses for its own redemption-limit race. Only ONE of these two
    // calls may claim the affiliate's single payable commission; the
    // other must see nothing left, never a second payout for the same
    // already-claimed balance (the exact "duplicate money" bug the
    // read-then-write version of requestPayout() used to allow).
    const affiliateId = await seedAffiliate('true-race@example.com', 'RWLTRUERACE');
    await seedPayableCommission(affiliateId, MIN_PAYOUT_PESEWAS);

    const [resultA, resultB] = await Promise.all([requestPayout(env as any, logger, affiliateId), requestPayout(env as any, logger, affiliateId)]);

    const succeeded = [resultA, resultB].filter((r) => r.ok);
    expect(succeeded.length).toBe(1); // exactly one wins: never zero, never both

    // No orphaned payout row exists for the loser: it must have been discarded, not left around with a phantom amount.
    const payoutCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM affiliate_payouts WHERE affiliate_id = ?`).bind(affiliateId).first<any>();
    expect(payoutCount.n).toBe(1);

    // The one payout that exists is genuinely backed by the one real claimed commission, not a duplicated amount.
    const payoutRow = await env.DB.prepare(`SELECT amount_pesewas AS amount FROM affiliate_payouts WHERE affiliate_id = ?`).bind(affiliateId).first<any>();
    expect(payoutRow.amount).toBe(MIN_PAYOUT_PESEWAS);
  });
});

describe('Payout state machine', () => {
  it('walks requested -> approved -> paid, marking every claimed commission paid on the final transition', async () => {
    const affiliateId = await seedAffiliate('full-lifecycle@example.com', 'RWLFULLCYCLE');
    await seedPayableCommission(affiliateId, MIN_PAYOUT_PESEWAS);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    const approved = await approvePayout(env as any, logger, adminId, requested.payoutId);
    expect(approved.ok).toBe(true);

    const paid = await processPayout(env as any, logger, adminId, requested.payoutId, 'MOMO-REF-000123');
    expect(paid.ok).toBe(true);

    const payoutRow = await env.DB.prepare(`SELECT status, reference AS reference FROM affiliate_payouts WHERE id = ?`).bind(requested.payoutId).first<any>();
    expect(payoutRow.status).toBe('paid');
    expect(payoutRow.reference).toBe('MOMO-REF-000123');

    const commissionRow = await env.DB.prepare(`SELECT status FROM affiliate_commissions WHERE payout_id = ?`).bind(requested.payoutId).first<any>();
    expect(commissionRow.status).toBe('paid');

    const actions = await env.DB.prepare(`SELECT action FROM audit_logs WHERE entity_type = 'affiliate_payout' AND entity_id = ? ORDER BY id ASC`).bind(requested.payoutId).all<any>();
    expect(actions.results.map((r: any) => r.action)).toEqual(['affiliate.payout_requested', 'affiliate.payout_approved', 'affiliate.payout_paid']);
  });

  it('processPayout() refuses a missing or too-short reference: never marks paid without a real one', async () => {
    const affiliateId = await seedAffiliate('blank-reference@example.com', 'RWLBLANKREF');
    await seedPayableCommission(affiliateId, MIN_PAYOUT_PESEWAS);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');
    await approvePayout(env as any, logger, adminId, requested.payoutId);

    const blank = await processPayout(env as any, logger, adminId, requested.payoutId, '');
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.reason).toBe('invalid_input');

    const tooShort = await processPayout(env as any, logger, adminId, requested.payoutId, 'ab');
    expect(tooShort.ok).toBe(false);

    const payoutRow = await env.DB.prepare(`SELECT status FROM affiliate_payouts WHERE id = ?`).bind(requested.payoutId).first<any>();
    expect(payoutRow.status).toBe('approved'); // unchanged: still awaiting a real reference
  });

  it('cannot approve a payout that is not in the requested state (e.g. already approved)', async () => {
    const affiliateId = await seedAffiliate('double-approve@example.com', 'RWLDOUBLEAPPROVE');
    await seedPayableCommission(affiliateId, MIN_PAYOUT_PESEWAS);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');
    await approvePayout(env as any, logger, adminId, requested.payoutId);

    const secondApprove = await approvePayout(env as any, logger, adminId, requested.payoutId);
    expect(secondApprove.ok).toBe(false);
    if (!secondApprove.ok) expect(secondApprove.reason).toBe('invalid_state');
  });

  it('cannot process (mark paid) a payout that was never approved', async () => {
    const affiliateId = await seedAffiliate('skip-approval@example.com', 'RWLSKIPAPPROVAL');
    await seedPayableCommission(affiliateId, MIN_PAYOUT_PESEWAS);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');

    const paid = await processPayout(env as any, logger, adminId, requested.payoutId, 'SHOULD-NOT-WORK');
    expect(paid.ok).toBe(false);
    if (!paid.ok) expect(paid.reason).toBe('invalid_state');
  });

  it('failPayout() releases claimed commissions back to the payable pool so they can be retried', async () => {
    const affiliateId = await seedAffiliate('failed-payout@example.com', 'RWLFAILEDPAYOUT');
    await seedPayableCommission(affiliateId, MIN_PAYOUT_PESEWAS);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');

    const failed = await failPayout(env as any, logger, adminId, requested.payoutId, 'Mobile money transfer bounced');
    expect(failed.ok).toBe(true);

    const payoutRow = await env.DB.prepare(`SELECT status, failure_reason AS reason FROM affiliate_payouts WHERE id = ?`).bind(requested.payoutId).first<any>();
    expect(payoutRow.status).toBe('failed');
    expect(payoutRow.reason).toBe('Mobile money transfer bounced');

    const commissionRow = await env.DB.prepare(`SELECT status, payout_id AS payoutId FROM affiliate_commissions WHERE affiliate_id = ?`).bind(affiliateId).first<any>();
    expect(commissionRow.status).toBe('payable'); // released, not lost
    expect(commissionRow.payoutId).toBeNull(); // free to be claimed by a future payout request

    const retry = await requestPayout(env as any, logger, affiliateId);
    expect(retry.ok).toBe(true); // the released commission is claimable again
  });

  it('cancelPayout() also releases claimed commissions back to the payable pool', async () => {
    const affiliateId = await seedAffiliate('cancelled-payout@example.com', 'RWLCANCELLEDPAYOUT');
    await seedPayableCommission(affiliateId, MIN_PAYOUT_PESEWAS);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');

    const cancelled = await cancelPayout(env as any, logger, adminId, requested.payoutId, 'Affiliate requested cancellation');
    expect(cancelled.ok).toBe(true);

    const commissionRow = await env.DB.prepare(`SELECT status, payout_id AS payoutId FROM affiliate_commissions WHERE affiliate_id = ?`).bind(affiliateId).first<any>();
    expect(commissionRow.status).toBe('payable');
    expect(commissionRow.payoutId).toBeNull();
  });

  it('a paid payout can never be cancelled or failed after the fact', async () => {
    const affiliateId = await seedAffiliate('paid-cannot-cancel@example.com', 'RWLPAIDCANTCANCEL');
    await seedPayableCommission(affiliateId, MIN_PAYOUT_PESEWAS);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');
    await approvePayout(env as any, logger, adminId, requested.payoutId);
    await processPayout(env as any, logger, adminId, requested.payoutId, 'REF-ALREADY-PAID');

    const cancelAttempt = await cancelPayout(env as any, logger, adminId, requested.payoutId, 'too late');
    expect(cancelAttempt.ok).toBe(false);
    if (!cancelAttempt.ok) expect(cancelAttempt.reason).toBe('invalid_state');

    const failAttempt = await failPayout(env as any, logger, adminId, requested.payoutId, 'too late');
    expect(failAttempt.ok).toBe(false);

    const payoutRow = await env.DB.prepare(`SELECT status FROM affiliate_payouts WHERE id = ?`).bind(requested.payoutId).first<any>();
    expect(payoutRow.status).toBe('paid'); // unchanged
  });
});
