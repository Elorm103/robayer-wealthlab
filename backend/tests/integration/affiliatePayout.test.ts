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
import { reverseCommission } from '../../services/affiliateCommissionService';
import { createLogger } from '../../utils/logger';

beforeEach(async () => {
  // affiliate_commissions.payout_id REFERENCES affiliate_payouts(id): must
  // be cleared first, or a payout with a still-claimed commission fails
  // this DELETE with a foreign key violation.
  await env.DB.exec('DELETE FROM affiliate_commissions');
  await env.DB.exec('DELETE FROM affiliate_payouts');
  await env.DB.exec('DELETE FROM affiliates');
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM email_log');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await env.DB.exec('DELETE FROM admin_users');
  // Scoped to this file's own seeded products (see seedPayableCommission()/
  // seedPayableCommissionWithSession()'s slug pattern), not a blanket
  // DELETE FROM products: several other tables (reviews, coupons,
  // product_bundle_items, product_relations) reference products(id) and
  // are outside this file's own cleanup list, so an unscoped delete can
  // hit a foreign key violation on data this file never created.
  await env.DB.prepare(`DELETE FROM products WHERE slug LIKE 'payout-test-%'`).run();
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

/** Same as seedPayableCommission(), but also returns purchase_session_id: reverseCommission() takes a purchase session id, not a commission id. */
async function seedPayableCommissionWithSession(affiliateId: number, commissionPesewas: number): Promise<{ commissionId: number; purchaseSessionId: number }> {
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
  const purchaseSessionId = Number(sessionInsert.meta.last_row_id);

  const commissionInsert = await env.DB.prepare(
    `INSERT INTO affiliate_commissions (affiliate_id, purchase_session_id, product_id, gross_pesewas, commission_percent, commission_pesewas, status, payable_at, data_classification)
     VALUES (?, ?, ?, ?, 20, ?, 'payable', datetime('now'), 'PRODUCTION')`
  )
    .bind(affiliateId, purchaseSessionId, productId, commissionPesewas * 5, commissionPesewas)
    .run();
  return { commissionId: Number(commissionInsert.meta.last_row_id), purchaseSessionId };
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

/**
 * Post-commit audit finding: a commission reversed after being claimed
 * into an unpaid payout could previously still end up marked 'paid'
 * (processPayout()'s finalize step had no status filter), paying the
 * affiliate for a refunded sale and silently overwriting the
 * commission's 'reversed' status back to 'paid'. Fixed in both
 * reverseCommission() (atomic status-gated transition, plus an
 * immediate, atomically-gated shrink of any outstanding payout it was
 * claimed into) and processPayout() (finalizes only genuinely
 * 'payable' commissions, then recomputes its own recorded amount from
 * what was ACTUALLY just marked paid rather than trusting the
 * pre-existing amount_pesewas). These tests cover the full interleaving
 * matrix, including a real concurrency test (Promise.all, not
 * sequential awaits), not just the sequential case.
 */
describe('Payout finalization vs. commission reversal interaction', () => {
  it('payable -> claimed -> reversed -> payout paid: with only one commission claimed, a full reversal leaves nothing legitimately owed, so the payout fails rather than being recorded paid for zero pesewas', async () => {
    const affiliateId = await seedAffiliate('reversed-then-paid@example.com', 'RWLREVTHENPAID');
    const { purchaseSessionId } = await seedPayableCommissionWithSession(affiliateId, MIN_PAYOUT_PESEWAS);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');
    await approvePayout(env as any, logger, adminId, requested.payoutId);

    const reversal = await reverseCommission(env as any, logger, purchaseSessionId, 'Order refunded');
    expect(reversal.reversed).toBe(true);

    // With only one commission ever claimed, reversing it would bring the payout's
    // amount to zero, which the amount_pesewas > 0 CHECK constraint forbids writing.
    // The reversal itself fails the payout immediately instead (amount_pesewas is left
    // as whatever it already was, never overwritten with an invalid value; the real
    // signal that nothing is owed is the status transition, not the stored amount).
    const afterReversal = await env.DB.prepare(`SELECT status FROM affiliate_payouts WHERE id = ?`).bind(requested.payoutId).first<any>();
    expect(afterReversal.status).toBe('failed');

    const processed = await processPayout(env as any, logger, adminId, requested.payoutId, 'REF-SHOULD-NOT-APPLY');
    expect(processed.ok).toBe(false); // nothing legitimately owed: this must never succeed as a "paid" record
    if (!processed.ok) expect(processed.reason).toBe('invalid_state');

    const payoutRow = await env.DB.prepare(`SELECT status, failure_reason AS failureReason FROM affiliate_payouts WHERE id = ?`).bind(requested.payoutId).first<any>();
    expect(payoutRow.status).toBe('failed'); // never left as 'paid' for a zero-pesewas payout
    expect(payoutRow.failureReason).toBeTruthy();

    const commissionRow = await env.DB.prepare(`SELECT status FROM affiliate_commissions WHERE purchase_session_id = ?`).bind(purchaseSessionId).first<any>();
    expect(commissionRow.status).toBe('reversed'); // never flipped to 'paid'
  });

  it('payable -> claimed -> reversed -> payout approved: reversing AFTER approval but BEFORE processing still shrinks the approved payout in real time', async () => {
    const affiliateId = await seedAffiliate('reversed-after-approval@example.com', 'RWLREVAFTERAPPROVE');
    const kept = await seedPayableCommissionWithSession(affiliateId, MIN_PAYOUT_PESEWAS);
    const reversed = await seedPayableCommissionWithSession(affiliateId, 2000);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');
    expect(requested.amountPesewas).toBe(MIN_PAYOUT_PESEWAS + 2000);

    const approved = await approvePayout(env as any, logger, adminId, requested.payoutId);
    expect(approved.ok).toBe(true);

    await reverseCommission(env as any, logger, reversed.purchaseSessionId, 'Order cancelled');

    // The payout is still merely 'approved', not yet paid, but its recorded amount already reflects the reversal.
    const afterReversal = await env.DB.prepare(`SELECT status, amount_pesewas AS amount FROM affiliate_payouts WHERE id = ?`).bind(requested.payoutId).first<any>();
    expect(afterReversal.status).toBe('approved');
    expect(afterReversal.amount).toBe(MIN_PAYOUT_PESEWAS);
  });

  it('a payout with multiple claimed commissions where only one is reversed pays out exactly the remaining valid total, never the reversed share', async () => {
    const affiliateId = await seedAffiliate('partial-reversal@example.com', 'RWLPARTIALREV');
    const kept = await seedPayableCommissionWithSession(affiliateId, MIN_PAYOUT_PESEWAS);
    const reversed = await seedPayableCommissionWithSession(affiliateId, 3000);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');
    await approvePayout(env as any, logger, adminId, requested.payoutId);
    await reverseCommission(env as any, logger, reversed.purchaseSessionId, 'Chargeback');

    const processed = await processPayout(env as any, logger, adminId, requested.payoutId, 'REF-PARTIAL-OK');
    expect(processed.ok).toBe(true);

    const payoutRow = await env.DB.prepare(`SELECT amount_pesewas AS amount FROM affiliate_payouts WHERE id = ?`).bind(requested.payoutId).first<any>();
    expect(payoutRow.amount).toBe(MIN_PAYOUT_PESEWAS); // exactly the kept commission's share, never including the reversed 3000

    const keptRow = await env.DB.prepare(`SELECT status FROM affiliate_commissions WHERE purchase_session_id = ?`).bind(kept.purchaseSessionId).first<any>();
    expect(keptRow.status).toBe('paid');
    const reversedRow = await env.DB.prepare(`SELECT status, reversed_reason AS reason FROM affiliate_commissions WHERE purchase_session_id = ?`).bind(reversed.purchaseSessionId).first<any>();
    expect(reversedRow.status).toBe('reversed'); // never overwritten to 'paid'
    expect(reversedRow.reason).toBe('Chargeback'); // audit trail preserved through the payout finalization
  });

  it('a genuinely CONCURRENT reversal and payout processing (Promise.all, not sequential awaits) can never result in the reversed commission being marked paid or counted in the paid amount', async () => {
    // The same true-concurrency technique used elsewhere in this suite
    // (see the "GENUINELY CONCURRENT requestPayout()" test above and
    // tests/integration/couponRaceConditions.test.ts); both operations
    // fired together so their individual awaited D1 statements genuinely
    // interleave, not simulated by sequential calls.
    const affiliateId = await seedAffiliate('true-race-reversal@example.com', 'RWLTRUERACEREV');
    const kept = await seedPayableCommissionWithSession(affiliateId, MIN_PAYOUT_PESEWAS);
    const contested = await seedPayableCommissionWithSession(affiliateId, 1500);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');
    await approvePayout(env as any, logger, adminId, requested.payoutId);

    const [reversalResult, payoutResult] = await Promise.all([
      reverseCommission(env as any, logger, contested.purchaseSessionId, 'Order refunded mid-payout'),
      processPayout(env as any, logger, adminId, requested.payoutId, 'REF-TRUE-RACE'),
    ]);

    // Whichever order the two actually resolved in, the invariant must hold regardless:
    const contestedRow = await env.DB.prepare(`SELECT status FROM affiliate_commissions WHERE purchase_session_id = ?`).bind(contested.purchaseSessionId).first<any>();
    expect(contestedRow.status).not.toBe('paid'); // the core guarantee: reversed can never become paid, no matter the interleaving

    const payoutRow = await env.DB.prepare(`SELECT amount_pesewas AS amount, status FROM affiliate_payouts WHERE id = ?`).bind(requested.payoutId).first<any>();
    if (payoutRow.status === 'paid') {
      // The contested commission's 1500 pesewas must never be part of a 'paid' total.
      expect(payoutRow.amount).toBe(MIN_PAYOUT_PESEWAS);
    }

    // Sum of every commission actually marked 'paid' anywhere for this affiliate must never include the reversed one's amount.
    const paidSum = await env.DB.prepare(`SELECT COALESCE(SUM(commission_pesewas), 0) AS total FROM affiliate_commissions WHERE affiliate_id = ? AND status = 'paid'`).bind(affiliateId).first<any>();
    expect(paidSum.total).toBeLessThanOrEqual(MIN_PAYOUT_PESEWAS);
  });

  it('an already-paid commission still cannot be reversed, even when reached through the full real payout flow (not just a directly-seeded paid row)', async () => {
    const affiliateId = await seedAffiliate('paid-via-payout-flow@example.com', 'RWLPAIDVIAFLOW');
    const { purchaseSessionId } = await seedPayableCommissionWithSession(affiliateId, MIN_PAYOUT_PESEWAS);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');
    await approvePayout(env as any, logger, adminId, requested.payoutId);
    const processed = await processPayout(env as any, logger, adminId, requested.payoutId, 'REF-ALREADY-PAID-FLOW');
    expect(processed.ok).toBe(true);

    const reversal = await reverseCommission(env as any, logger, purchaseSessionId, 'attempted refund after payout');
    expect(reversal.reversed).toBe(false); // blocked: already paid

    const commissionRow = await env.DB.prepare(`SELECT status FROM affiliate_commissions WHERE purchase_session_id = ?`).bind(purchaseSessionId).first<any>();
    expect(commissionRow.status).toBe('paid'); // unchanged
  });

  it('reverseCommission() is idempotent under retry even when it has already shrunk an outstanding payout: a second call never double-decrements the payout amount', async () => {
    const affiliateId = await seedAffiliate('retry-reversal@example.com', 'RWLRETRYREV');
    const kept = await seedPayableCommissionWithSession(affiliateId, MIN_PAYOUT_PESEWAS);
    const reversed = await seedPayableCommissionWithSession(affiliateId, 2500);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');
    await approvePayout(env as any, logger, adminId, requested.payoutId);

    const first = await reverseCommission(env as any, logger, reversed.purchaseSessionId, 'Refund webhook delivery 1');
    expect(first.reversed).toBe(true);
    const second = await reverseCommission(env as any, logger, reversed.purchaseSessionId, 'Refund webhook delivery 2 (redelivered)');
    expect(second.reversed).toBe(false); // idempotent no-op, not a second reversal

    const payoutRow = await env.DB.prepare(`SELECT amount_pesewas AS amount FROM affiliate_payouts WHERE id = ?`).bind(requested.payoutId).first<any>();
    expect(payoutRow.amount).toBe(MIN_PAYOUT_PESEWAS); // decremented exactly once, not twice
  });

  it('retrying processPayout() after it already failed due to a full reversal does not throw and does not resurrect the payout as paid', async () => {
    const affiliateId = await seedAffiliate('retry-all-reversed@example.com', 'RWLRETRYALLREV');
    const { purchaseSessionId } = await seedPayableCommissionWithSession(affiliateId, MIN_PAYOUT_PESEWAS);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');
    await approvePayout(env as any, logger, adminId, requested.payoutId);
    await reverseCommission(env as any, logger, purchaseSessionId, 'Order refunded');

    const firstAttempt = await processPayout(env as any, logger, adminId, requested.payoutId, 'REF-FIRST-ATTEMPT');
    expect(firstAttempt.ok).toBe(false);

    // The payout is now 'failed', not 'approved'/'processing' any more, so a retry is cleanly rejected, not a crash or a silent success.
    const retryAttempt = await processPayout(env as any, logger, adminId, requested.payoutId, 'REF-RETRY-ATTEMPT');
    expect(retryAttempt.ok).toBe(false);
    if (!retryAttempt.ok) expect(retryAttempt.reason).toBe('invalid_state');
  });

  it('the audit trail records the payout amount reduction and the final payout_paid entry reflects the corrected amount', async () => {
    const affiliateId = await seedAffiliate('audit-trail-check@example.com', 'RWLAUDITTRAIL');
    const kept = await seedPayableCommissionWithSession(affiliateId, MIN_PAYOUT_PESEWAS);
    const reversed = await seedPayableCommissionWithSession(affiliateId, 1000);
    const adminId = await seedAdmin();

    const requested = await requestPayout(env as any, logger, affiliateId);
    if (!requested.ok) throw new Error('setup failed');
    await approvePayout(env as any, logger, adminId, requested.payoutId);
    await reverseCommission(env as any, logger, reversed.purchaseSessionId, 'Order refunded');
    await processPayout(env as any, logger, adminId, requested.payoutId, 'REF-AUDIT-CHECK');

    const shrinkAudit = await env.DB.prepare(`SELECT metadata FROM audit_logs WHERE action = 'affiliate.payout_amount_reduced_by_reversal' AND entity_id = ?`).bind(requested.payoutId).first<any>();
    expect(shrinkAudit).toBeTruthy();
    const shrinkMetadata = JSON.parse(shrinkAudit.metadata);
    expect(shrinkMetadata.reducedByPesewas).toBe(1000);

    const paidAudit = await env.DB.prepare(`SELECT metadata FROM audit_logs WHERE action = 'affiliate.payout_paid' AND entity_id = ?`).bind(requested.payoutId).first<any>();
    expect(paidAudit).toBeTruthy();
    const paidMetadata = JSON.parse(paidAudit.metadata);
    expect(paidMetadata.amountPesewas).toBe(MIN_PAYOUT_PESEWAS);
  });
});
