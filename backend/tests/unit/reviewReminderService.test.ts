/**
 * Unit tests: review-reminder lifecycle — Version 3.3 Milestone M5C
 * Phase 5. Covers the sprint brief's explicit requirements: post-
 * purchase reminder timing, one reminder per purchase, opt-out
 * support, audit logging.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { sendDueReviewReminders, optOutOfReviewReminders } from '../../services/customer/reviewReminderService';
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

describe('reviewReminderService.sendDueReviewReminders', () => {
  let customerId: number;

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM audit_logs');
    await env.DB.exec('DELETE FROM review_reminder_attempts');
    await env.DB.exec('DELETE FROM email_log');
    await env.DB.exec('DELETE FROM product_reviews');
    await env.DB.exec('DELETE FROM purchase_sessions');
    await cleanupTestProduct(env as any);
    await env.DB.exec('DELETE FROM customer_profiles');
    await env.DB.exec('DELETE FROM customers');

    await seedTestProduct(env as any);
    const created = await findOrCreateCustomer(env as any, `review-reminder-${Date.now()}@example.com`, false);
    customerId = created.customerId;
  });

  afterEach(async () => {
    await clearResendResponseStickyOverride(env as any);
  });

  it('sends a reminder for a verified purchase past the delay window', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-REMIND-0001', 6);

    const result = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(result.eligible).toBe(1);
    expect(result.sent).toBe(1);

    const logged = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_log WHERE template = 'customer-review-reminder'`
    ).first<{ n: number }>();
    expect(logged?.n).toBe(1);
  });

  it('does not remind a purchase verified too recently', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-REMIND-0002', 1);

    const result = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(result.eligible).toBe(0);
  });

  it('one reminder per purchase: a second run does not re-remind the same purchase', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-REMIND-0003', 6);

    const first = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(first.sent).toBe(1);

    const second = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(second.eligible).toBe(0);

    const logCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_log WHERE template = 'customer-review-reminder'`
    ).first<{ n: number }>();
    expect(logCount?.n).toBe(1);
  });

  it('never reminds a purchase the customer already reviewed', async () => {
    const purchaseId = await seedVerifiedPurchase(customerId, 'RWL-REMIND-0004', 6);
    const product = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(TEST_PRODUCT_SLUG).first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO product_reviews (product_id, customer_id, purchase_session_id, rating, body, status) VALUES (?, ?, ?, 5, 'Great guide', 'pending')`
    )
      .bind(product!.id, customerId, purchaseId)
      .run();

    const result = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(result.eligible).toBe(0);
  });

  it('never reminds a customer who has opted out', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-REMIND-0005', 6);
    await env.DB.prepare('UPDATE customer_profiles SET review_reminder_opt_out = 1 WHERE customer_id = ?').bind(customerId).run();

    const result = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(result.eligible).toBe(0);
  });

  it('never reminds an orphaned (no customer_id) purchase', async () => {
    await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
       VALUES ('RWL-REMIND-0006', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '-6 days'), datetime('now', '+30 minutes'))`
    )
      .bind(TEST_PRODUCT_SLUG)
      .run();

    const result = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(result.eligible).toBe(0);
  });

  it('writes an audit log entry for each reminder actually sent', async () => {
    const purchaseId = await seedVerifiedPurchase(customerId, 'RWL-REMIND-0007', 6);

    await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);

    const audit = await env.DB.prepare(
      `SELECT actor_type, entity_id FROM audit_logs WHERE action = 'customer.review_reminder_sent'`
    ).first<{ actor_type: string; entity_id: number }>();
    expect(audit?.actor_type).toBe('system');
    expect(audit?.entity_id).toBe(purchaseId);
  });

  it('generates an opt-out token lazily on first send', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-REMIND-0008', 6);

    const before = await env.DB.prepare('SELECT review_reminder_opt_out_token AS token FROM customer_profiles WHERE customer_id = ?')
      .bind(customerId)
      .first<{ token: string | null }>();
    expect(before?.token).toBeNull();

    await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);

    const after = await env.DB.prepare('SELECT review_reminder_opt_out_token AS token FROM customer_profiles WHERE customer_id = ?')
      .bind(customerId)
      .first<{ token: string | null }>();
    expect(after?.token).toMatch(/^[a-f0-9]{64}$/);
  });

  // ============================================================
  // Version 3.3 Milestone M5D.1 (Acceptance Remediation) — permanent
  // regression coverage for the Blocking finding in
  // docs/v3.3-m5d-review-reminder-validation-report.md. Every test in
  // this block fails against the pre-remediation implementation (the
  // one gated only by a NOT EXISTS against email_log) and passes
  // against the atomic-claim implementation in
  // services/customer/reviewReminderService.ts.
  // ============================================================

  it('M5D.1: genuinely concurrent scheduled runs send exactly one reminder for the same purchase, not two', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-REMIND-M5D1-CONCURRENT', 6);

    const [resultA, resultB] = await Promise.all([
      sendDueReviewReminders(env as any, logger, SITE_BASE_URL),
      sendDueReviewReminders(env as any, logger, SITE_BASE_URL),
    ]);

    // Exactly one of the two concurrent invocations actually won the
    // atomic claim and sent — never both, never neither.
    expect(resultA.sent + resultB.sent).toBe(1);

    const logCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM email_log WHERE template = 'customer-review-reminder'`
    ).first<{ n: number }>();
    expect(logCount?.n).toBe(1);
  });

  it('M5D.1: a transient (non-permanent) send failure remains eligible on a later run and succeeds once the outage clears', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-REMIND-M5D1-TRANSIENT', 6);

    // Both of sendEmail()'s own internal attempts see this sticky 500 —
    // a genuine, fully-failed (not internally-recovered) send.
    await queueResendResponseStickyOverride(env as any, { status: 500, body: { message: 'simulated transient outage' } });
    const first = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(first.eligible).toBe(1);
    expect(first.claimed).toBe(1);
    expect(first.sent).toBe(0);

    const attemptRow = await env.DB.prepare(`SELECT status FROM review_reminder_attempts WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = 'RWL-REMIND-M5D1-TRANSIENT')`).first<{ status: string }>();
    expect(attemptRow?.status).toBe('failed'); // retry-eligible, not permanently_failed

    // Outage clears — the very next scheduled run should retry and
    // succeed, exactly the behavior the pre-remediation implementation
    // could never produce (any email_log row at all, success or
    // failure, permanently excluded the purchase).
    await clearResendResponseStickyOverride(env as any);
    const second = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(second.eligible).toBe(1);
    expect(second.sent).toBe(1);

    const finalStatus = await env.DB.prepare(`SELECT status FROM review_reminder_attempts WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = 'RWL-REMIND-M5D1-TRANSIENT')`).first<{ status: string }>();
    expect(finalStatus?.status).toBe('sent');
  });

  it('M5D.1: a persistently-failing send stops retrying after MAX_SEND_ATTEMPTS and is marked permanently_failed with an audit trail', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-REMIND-M5D1-MAXATTEMPTS', 6);
    await queueResendResponseStickyOverride(env as any, { status: 500, body: { message: 'simulated persistent outage' } });

    // Three consecutive scheduled runs, each seeing the same ongoing
    // (simulated) outage.
    await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    const third = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(third.claimed).toBe(1); // still retried a 3rd time

    const attemptRow = await env.DB.prepare(`SELECT status, attempt_count AS attemptCount FROM review_reminder_attempts WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = 'RWL-REMIND-M5D1-MAXATTEMPTS')`).first<{ status: string; attemptCount: number }>();
    expect(attemptRow?.status).toBe('permanently_failed');
    expect(attemptRow?.attemptCount).toBe(3);

    // A 4th run must not retry it again — it has given up for good.
    const fourth = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(fourth.eligible).toBe(0);

    // The failure is no longer invisible — closes the audit-visibility
    // gap Sprint M5D also found.
    const audit = await env.DB.prepare(`SELECT actor_type FROM audit_logs WHERE action = 'customer.review_reminder_failed'`).first<{ actor_type: string }>();
    expect(audit?.actor_type).toBe('system');
  });

  it('M5D.1: an immediately-permanent (4xx) send failure is marked permanently_failed on the very first attempt, not retried', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-REMIND-M5D1-PERMANENT', 6);
    await queueResendResponseStickyOverride(env as any, { status: 400, body: { message: 'simulated invalid recipient' } });

    const result = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(0);

    const attemptRow = await env.DB.prepare(`SELECT status, attempt_count AS attemptCount FROM review_reminder_attempts WHERE purchase_session_id = (SELECT id FROM purchase_sessions WHERE purchase_reference = 'RWL-REMIND-M5D1-PERMANENT')`).first<{ status: string; attemptCount: number }>();
    expect(attemptRow?.status).toBe('permanently_failed');
    expect(attemptRow?.attemptCount).toBe(1); // never retried past the first attempt
  });

  it('M5D.1: repeated (sequential) scheduled execution after a genuine success remains a clean no-op', async () => {
    await seedVerifiedPurchase(customerId, 'RWL-REMIND-M5D1-REPEATED', 6);

    const first = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(first.sent).toBe(1);

    const second = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    const third = await sendDueReviewReminders(env as any, logger, SITE_BASE_URL);
    expect(second.eligible).toBe(0);
    expect(third.eligible).toBe(0);

    const logCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_log WHERE template = 'customer-review-reminder'`).first<{ n: number }>();
    expect(logCount?.n).toBe(1);
  });
});

describe('reviewReminderService.optOutOfReviewReminders', () => {
  let customerId: number;

  beforeEach(async () => {
    // Cleans up leftover purchase_sessions/product_reviews from the
    // sendDueReviewReminders describe block above too — customers has
    // FK-referencing children in both tables, so deleting customers
    // first fails with a foreign-key error otherwise, exactly as this
    // project's own test run caught.
    await env.DB.exec('DELETE FROM review_reminder_attempts');
    await env.DB.exec('DELETE FROM product_reviews');
    await env.DB.exec('DELETE FROM purchase_sessions');
    await env.DB.exec('DELETE FROM customer_profiles');
    await env.DB.exec('DELETE FROM customers');
    const created = await findOrCreateCustomer(env as any, `opt-out-${Date.now()}@example.com`, false);
    customerId = created.customerId;
    await env.DB.prepare('UPDATE customer_profiles SET review_reminder_opt_out_token = ? WHERE customer_id = ?')
      .bind('a'.repeat(64), customerId)
      .run();
  });

  it('sets the opt-out flag for a valid token', async () => {
    await optOutOfReviewReminders(env as any, logger, 'a'.repeat(64));

    const row = await env.DB.prepare('SELECT review_reminder_opt_out AS optOut FROM customer_profiles WHERE customer_id = ?')
      .bind(customerId)
      .first<{ optOut: number }>();
    expect(row?.optOut).toBe(1);
  });

  it('is a silent no-op for an unrecognized token (never throws)', async () => {
    await expect(optOutOfReviewReminders(env as any, logger, 'not-a-real-token')).resolves.toBeUndefined();

    const row = await env.DB.prepare('SELECT review_reminder_opt_out AS optOut FROM customer_profiles WHERE customer_id = ?')
      .bind(customerId)
      .first<{ optOut: number }>();
    expect(row?.optOut).toBe(0);
  });

  it('is idempotent — opting out twice does not error', async () => {
    await optOutOfReviewReminders(env as any, logger, 'a'.repeat(64));
    await expect(optOutOfReviewReminders(env as any, logger, 'a'.repeat(64))).resolves.toBeUndefined();
  });
});
