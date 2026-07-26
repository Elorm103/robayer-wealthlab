/**
 * Unit tests: customer purchase reconciliation — Version 3.3 Milestone
 * M5C Phase 2. Covers the sprint brief's explicit requirements:
 * historical guest purchase recovery, verified ownership by payment
 * email, secure account claiming, duplicate prevention, audit logging.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { reconcilePurchases } from '../../services/customer/reconciliationService';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');
const SITE_BASE_URL = 'https://example.com';

async function seedOrphanedPurchase(email: string, reference: string, marketingOptIn = false): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_email, verified_at, expires_at, marketing_opt_in)
     VALUES (?, 'test-guide', 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', ?, datetime('now'), datetime('now', '+30 minutes'), ?)`
  )
    .bind(reference, email, marketingOptIn ? 1 : 0)
    .run();
  return Number(insert.meta.last_row_id);
}

describe('reconciliationService.reconcilePurchases', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM audit_logs');
    await env.DB.exec('DELETE FROM customer_password_tokens');
    await env.DB.exec('DELETE FROM purchase_sessions');
    await env.DB.exec('DELETE FROM customer_profiles');
    await env.DB.exec('DELETE FROM customers');
    await env.DB.exec('DELETE FROM email_log');
  });

  it('links an orphaned verified purchase to a newly-created customer', async () => {
    await seedOrphanedPurchase('orphan-1@example.com', 'RWL-TEST-0001', true);

    await reconcilePurchases(env as any, logger, 'orphan-1@example.com', SITE_BASE_URL);

    const customer = await env.DB.prepare('SELECT id FROM customers WHERE email = ?').bind('orphan-1@example.com').first<{ id: number }>();
    expect(customer).toBeTruthy();

    const purchase = await env.DB.prepare('SELECT customer_id FROM purchase_sessions WHERE purchase_reference = ?')
      .bind('RWL-TEST-0001')
      .first<{ customer_id: number | null }>();
    expect(purchase?.customer_id).toBe(customer!.id);
  });

  it('links every unclaimed purchase for the email, not just one', async () => {
    await seedOrphanedPurchase('orphan-multi@example.com', 'RWL-TEST-0002');
    await seedOrphanedPurchase('orphan-multi@example.com', 'RWL-TEST-0003');

    await reconcilePurchases(env as any, logger, 'orphan-multi@example.com', SITE_BASE_URL);

    const { results } = await env.DB.prepare('SELECT customer_id FROM purchase_sessions WHERE customer_email = ?')
      .bind('orphan-multi@example.com')
      .all<{ customer_id: number | null }>();
    expect(results.every((r) => r.customer_id !== null)).toBe(true);
    expect(new Set(results.map((r) => r.customer_id)).size).toBe(1); // same customer for both
  });

  it('is a silent no-op for an email with no unclaimed verified purchase (no enumeration signal, no customer created)', async () => {
    await reconcilePurchases(env as any, logger, 'no-purchase-here@example.com', SITE_BASE_URL);

    const customer = await env.DB.prepare('SELECT id FROM customers WHERE email = ?').bind('no-purchase-here@example.com').first();
    expect(customer).toBeFalsy();
  });

  it('reuses an existing customer account rather than creating a duplicate', async () => {
    const { customerId: existingId } = await findOrCreateCustomer(env as any, 'existing-account@example.com', false);
    await seedOrphanedPurchase('existing-account@example.com', 'RWL-TEST-0004');

    await reconcilePurchases(env as any, logger, 'existing-account@example.com', SITE_BASE_URL);

    const purchase = await env.DB.prepare('SELECT customer_id FROM purchase_sessions WHERE purchase_reference = ?')
      .bind('RWL-TEST-0004')
      .first<{ customer_id: number | null }>();
    expect(purchase?.customer_id).toBe(existingId);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM customers WHERE email = ?').bind('existing-account@example.com').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('duplicate prevention: calling reconcile again for an already-fully-claimed email is a no-op', async () => {
    await seedOrphanedPurchase('already-claimed@example.com', 'RWL-TEST-0005');
    await reconcilePurchases(env as any, logger, 'already-claimed@example.com', SITE_BASE_URL);

    const auditCountAfterFirst = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.purchases_reconciled'`).first<{ n: number }>();
    expect(auditCountAfterFirst?.n).toBe(1);

    await reconcilePurchases(env as any, logger, 'already-claimed@example.com', SITE_BASE_URL);

    const auditCountAfterSecond = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.purchases_reconciled'`).first<{ n: number }>();
    expect(auditCountAfterSecond?.n).toBe(1); // no second reconciliation event — nothing left unclaimed
  });

  it('never touches a purchase that already belongs to a different customer (no unauthorized ownership transfer)', async () => {
    const { customerId: victimId } = await findOrCreateCustomer(env as any, 'victim@example.com', false);
    const purchaseId = await seedOrphanedPurchase('victim@example.com', 'RWL-TEST-0006');
    await env.DB.prepare('UPDATE purchase_sessions SET customer_id = ? WHERE id = ?').bind(victimId, purchaseId).run();

    // An attacker cannot cause this already-claimed purchase to move by calling reconcile again for the same email.
    await reconcilePurchases(env as any, logger, 'victim@example.com', SITE_BASE_URL);

    const purchase = await env.DB.prepare('SELECT customer_id FROM purchase_sessions WHERE id = ?').bind(purchaseId).first<{ customer_id: number }>();
    expect(purchase?.customer_id).toBe(victimId);
  });

  it('writes an audit log entry naming the reconciled purchase session ids', async () => {
    const purchaseId = await seedOrphanedPurchase('audit-check@example.com', 'RWL-TEST-0007');

    await reconcilePurchases(env as any, logger, 'audit-check@example.com', SITE_BASE_URL);

    const audit = await env.DB.prepare(`SELECT actor_type, metadata FROM audit_logs WHERE action = 'customer.purchases_reconciled'`).first<{
      actor_type: string;
      metadata: string;
    }>();
    expect(audit?.actor_type).toBe('customer');
    const metadata = JSON.parse(audit!.metadata);
    expect(metadata.reconciledSessionIds).toContain(purchaseId);
  });

  it('ignores an unverified (pending/failed) purchase for the same email', async () => {
    await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_email, expires_at)
       VALUES ('RWL-TEST-0008', 'test-guide', 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'pending', 'pending-only@example.com', datetime('now', '+30 minutes'))`
    ).run();

    await reconcilePurchases(env as any, logger, 'pending-only@example.com', SITE_BASE_URL);

    const customer = await env.DB.prepare('SELECT id FROM customers WHERE email = ?').bind('pending-only@example.com').first();
    expect(customer).toBeFalsy();
  });

  it('is case-insensitive on the email, matching identityService\'s own normalization', async () => {
    await seedOrphanedPurchase('mixed-case-recon@example.com', 'RWL-TEST-0009');

    await reconcilePurchases(env as any, logger, 'Mixed-Case-Recon@Example.com', SITE_BASE_URL);

    const purchase = await env.DB.prepare('SELECT customer_id FROM purchase_sessions WHERE purchase_reference = ?')
      .bind('RWL-TEST-0009')
      .first<{ customer_id: number | null }>();
    expect(purchase?.customer_id).not.toBeNull();
  });

  // ============================================================
  // Version 3.3 Milestone M5D.1 (Acceptance Remediation) — permanent
  // regression coverage for the Non-blocking finding in
  // docs/v3.3-m5d-reconciliation-validation-report.md: genuinely
  // concurrent (not sequential) reconciliation calls for the same
  // email previously produced 2 audit log entries and 2 duplicate
  // password-setup emails. This test fails against the
  // pre-remediation implementation (which never checked
  // `meta.changes` before notifying) and passes against the current
  // one.
  // ============================================================

  it('M5D.1: genuinely concurrent reconciliation calls for the same email produce exactly one audit entry and one notification', async () => {
    await seedOrphanedPurchase('m5d1-concurrent-recon@example.com', 'RWL-TEST-M5D1-0001');

    await Promise.all([
      reconcilePurchases(env as any, logger, 'm5d1-concurrent-recon@example.com', SITE_BASE_URL),
      reconcilePurchases(env as any, logger, 'm5d1-concurrent-recon@example.com', SITE_BASE_URL),
    ]);

    const customerCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM customers WHERE email = ?')
      .bind('m5d1-concurrent-recon@example.com')
      .first<{ n: number }>();
    expect(customerCount?.n).toBe(1);

    const auditCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'customer.purchases_reconciled'`).first<{ n: number }>();
    expect(auditCount?.n).toBe(1);

    const tokenCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM customer_password_tokens`).first<{ n: number }>();
    expect(tokenCount?.n).toBe(1);

    const emailCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_log WHERE template = 'customer-purchase-reconciliation'`).first<{ n: number }>();
    expect(emailCount?.n).toBe(1);
  });
});
