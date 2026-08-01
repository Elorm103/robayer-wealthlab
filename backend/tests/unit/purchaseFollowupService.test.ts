/**
 * Unit tests: purchase-followup lifecycle — Version 4.0 Milestone C1
 * (Core Email Lifecycle). A deliberate structural mirror of
 * tests/unit/reviewReminderService.test.ts, covering the same class of
 * requirements (delay timing, one send per purchase, opt-out support,
 * audit logging, and the M5D.1 concurrency/retry guarantees the
 * underlying atomic-claim pattern was built to prove) against the new
 * purchaseFollowupService.ts — the same pattern, reused for a second,
 * independent automation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { sendDuePurchaseFollowups, optOutOfPurchaseFollowups } from '../../services/customer/purchaseFollowupService';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createLogger } from '../../utils/logger';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';
import { queueResendResponseStickyOverride, clearResendResponseStickyOverride } from '../outboundMock';

const logger = createLogger('test-request-id', 'test');
const SITE_BASE_URL = 'https://example.com';

async function seedVerifiedPurchase(customerId: number, reference: string, verifiedDaysAgo: number): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, verified_at, expires_at)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', ?, datetime('now', ? || ' days'), datetime('now', '+30 minutes'))`
  )
    .bind(reference, TEST_PRODUCT_SLUG, customerId, String(-verifiedDaysAgo))
    .run();
  return Number(insert.meta.last_row_id);
}

describe('purchaseFollowupService.sendDuePurchaseFollowups', () => {
  let customerId: number;

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM audit_logs');
    await env.DB.exec('DELETE FROM purchase_followup_attempts');
    await env.DB.exec('DELETE FROM email_log');
    await env.DB.exec('DELETE FROM purchase_sessions');
    await cleanupTestProduct(env as any);
    await env.DB.exec('DELETE FROM customer_profiles');
    await env.DB.exec('DELETE FROM customers');

    await seedTestProduct(env as any);
    const created = await findOrCreateCustomer(env as any, `purchase-followup-${Date.now()}@example.com`, false);
    customerId = created.customerId;
  });

  afterEach(async () => {
    await clearResendResponseStickyOverride(env as any);
  });

  it('sends a follow-up for a verified purchase past the delay window', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-FOLLOWUP-0001', 3);

    const result = await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    expect(result.eligible).toBe(1);
    expect(result.sent).toBe(1);

    const logged = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_log WHERE template = 'customer-purchase-followup'`
    ).first<{ n: number }>();
    expect(logged?.n).toBe(1);
  });

  it('does not follow up a purchase verified too recently', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-FOLLOWUP-0002', 1);

    const result = await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    expect(result.eligible).toBe(0);
  });

  it('one follow-up per purchase: a second run does not re-send for the same purchase', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-FOLLOWUP-0003', 3);

    const first = await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    expect(first.sent).toBe(1);

    const second = await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    expect(second.eligible).toBe(0);

    const logCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_log WHERE template = 'customer-purchase-followup'`
    ).first<{ n: number }>();
    expect(logCount?.n).toBe(1);
  });

  it('never follows up a customer who has opted out', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-FOLLOWUP-0005', 3);
    await env.DB.prepare('UPDATE customer_profiles SET purchase_followup_opt_out = 1 WHERE customer_id = ?').bind(customerId).run();

    const result = await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    expect(result.eligible).toBe(0);
  });

  it('never follows up an orphaned (no customer_id) purchase', async () => {
    await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
       VALUES ('RWL-FOLLOWUP-0006', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '-3 days'), datetime('now', '+30 minutes'))`
    )
      .bind(TEST_PRODUCT_SLUG)
      .run();

    const result = await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    expect(result.eligible).toBe(0);
  });

  it('writes an audit log entry for each follow-up actually sent', async () => {
    const purchaseId = await seedVerifiedPurchase(customerId, 'RWL-FOLLOWUP-0007', 3);

    await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);

    const audit = await env.DB.prepare(
      `SELECT actor_type, entity_id FROM audit_logs WHERE action = 'customer.purchase_followup_sent'`
    ).first<{ actor_type: string; entity_id: number }>();
    expect(audit?.actor_type).toBe('system');
    expect(audit?.entity_id).toBe(purchaseId);
  });

  it('generates an opt-out token lazily on first send', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-FOLLOWUP-0008', 3);

    const before = await env.DB.prepare('SELECT purchase_followup_opt_out_token AS token FROM customer_profiles WHERE customer_id = ?')
      .bind(customerId)
      .first<{ token: string | null }>();
    expect(before?.token).toBeNull();

    await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);

    const after = await env.DB.prepare('SELECT purchase_followup_opt_out_token AS token FROM customer_profiles WHERE customer_id = ?')
      .bind(customerId)
      .first<{ token: string | null }>();
    expect(after?.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('a review-reminder opt-out does not silently suppress the purchase follow-up (independent preferences)', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-FOLLOWUP-0009', 3);
    await env.DB.prepare('UPDATE customer_profiles SET review_reminder_opt_out = 1 WHERE customer_id = ?').bind(customerId).run();

    const result = await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    expect(result.eligible).toBe(1);
    expect(result.sent).toBe(1);
  });

  it('concurrent scheduled runs send exactly one follow-up for the same purchase, not two', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-FOLLOWUP-CONCURRENT', 3);

    const [resultA, resultB] = await Promise.all([
      sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL),
      sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL),
    ]);

    expect(resultA.sent + resultB.sent).toBe(1);

    const logCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_log WHERE template = 'customer-purchase-followup'`
    ).first<{ n: number }>();
    expect(logCount?.n).toBe(1);
  });

  it('a transient send failure remains eligible on a later run and succeeds once the outage clears', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-FOLLOWUP-TRANSIENT', 3);

    await queueResendResponseStickyOverride(env as any, { status: 500, body: { message: 'simulated transient outage' } });
    const first = await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    expect(first.claimed).toBe(1);
    expect(first.sent).toBe(0);

    const attemptRow = await env.DB.prepare(`SELECT status FROM purchase_followup_attempts WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = 'RWL-FOLLOWUP-TRANSIENT')`).first<{ status: string }>();
    expect(attemptRow?.status).toBe('failed');

    await clearResendResponseStickyOverride(env as any);
    const second = await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    expect(second.sent).toBe(1);

    const finalStatus = await env.DB.prepare(`SELECT status FROM purchase_followup_attempts WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = 'RWL-FOLLOWUP-TRANSIENT')`).first<{ status: string }>();
    expect(finalStatus?.status).toBe('sent');
  });

  it('a persistently-failing send stops retrying after MAX_SEND_ATTEMPTS and is marked permanently_failed with an audit trail', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-FOLLOWUP-MAXATTEMPTS', 3);
    await queueResendResponseStickyOverride(env as any, { status: 500, body: { message: 'simulated persistent outage' } });

    await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    const third = await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    expect(third.claimed).toBe(1);

    const attemptRow = await env.DB.prepare(`SELECT status, attempt_count AS attemptCount FROM purchase_followup_attempts WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = 'RWL-FOLLOWUP-MAXATTEMPTS')`).first<{ status: string; attemptCount: number }>();
    expect(attemptRow?.status).toBe('permanently_failed');
    expect(attemptRow?.attemptCount).toBe(3);

    const fourth = await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    expect(fourth.eligible).toBe(0);

    const audit = await env.DB.prepare(`SELECT actor_type FROM audit_logs WHERE action = 'customer.purchase_followup_failed'`).first<{ actor_type: string }>();
    expect(audit?.actor_type).toBe('system');
  });

  it('an immediately-permanent (4xx) send failure is marked permanently_failed on the very first attempt, not retried', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-FOLLOWUP-PERMANENT', 3);
    await queueResendResponseStickyOverride(env as any, { status: 400, body: { message: 'simulated invalid recipient' } });

    const result = await sendDuePurchaseFollowups(env as any, logger, SITE_BASE_URL);
    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(0);

    const attemptRow = await env.DB.prepare(`SELECT status, attempt_count AS attemptCount FROM purchase_followup_attempts WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = 'RWL-FOLLOWUP-PERMANENT')`).first<{ status: string; attemptCount: number }>();
    expect(attemptRow?.status).toBe('permanently_failed');
    expect(attemptRow?.attemptCount).toBe(1);
  });
});

describe('purchaseFollowupService.optOutOfPurchaseFollowups', () => {
  let customerId: number;

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM purchase_followup_attempts');
    await env.DB.exec('DELETE FROM purchase_sessions');
    await env.DB.exec('DELETE FROM customer_profiles');
    await env.DB.exec('DELETE FROM customers');
    const created = await findOrCreateCustomer(env as any, `followup-opt-out-${Date.now()}@example.com`, false);
    customerId = created.customerId;
    await env.DB.prepare('UPDATE customer_profiles SET purchase_followup_opt_out_token = ? WHERE customer_id = ?')
      .bind('b'.repeat(64), customerId)
      .run();
  });

  it('sets the opt-out flag for a valid token', async () => {
    await optOutOfPurchaseFollowups(env as any, logger, 'b'.repeat(64));

    const row = await env.DB.prepare('SELECT purchase_followup_opt_out AS optOut FROM customer_profiles WHERE customer_id = ?')
      .bind(customerId)
      .first<{ optOut: number }>();
    expect(row?.optOut).toBe(1);
  });

  it('is a silent no-op for an unrecognized token (never throws)', async () => {
    await expect(optOutOfPurchaseFollowups(env as any, logger, 'not-a-real-token')).resolves.toBeUndefined();

    const row = await env.DB.prepare('SELECT purchase_followup_opt_out AS optOut FROM customer_profiles WHERE customer_id = ?')
      .bind(customerId)
      .first<{ optOut: number }>();
    expect(row?.optOut).toBe(0);
  });

  it('is idempotent — opting out twice does not error', async () => {
    await optOutOfPurchaseFollowups(env as any, logger, 'b'.repeat(64));
    await expect(optOutOfPurchaseFollowups(env as any, logger, 'b'.repeat(64))).resolves.toBeUndefined();
  });
});
