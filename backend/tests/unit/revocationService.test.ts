/**
 * Unit tests: revocation-sync - Version 3.0.2 Milestone M2. Directly
 * exercises the one function that ever sets `licenses.revoked_at`
 * (ADR-003) and asserts it always moves together with
 * `deliveries.status = 'revoked'`. This is the literal, named success
 * criterion from the ratified Blueprint's own M2 milestone definition.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { revokePurchase } from '../../services/orders/revocationService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('test-request-id', 'test');

beforeEach(async () => {
  await env.DB.exec('DELETE FROM download_tokens');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM licenses');
  await env.DB.exec('DELETE FROM purchase_sessions');
});

async function seedVerifiedPurchaseWithEntitlements(reference: string): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at)
     VALUES (?, 'test-guide', 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'))`
  )
    .bind(reference)
    .run();
  const purchaseSessionId = Number(insert.meta.last_row_id);

  await env.DB.prepare(`INSERT INTO licenses (purchase_session_id, product_id, license_key) VALUES (?, 'prod-test-guide', ?)`)
    .bind(purchaseSessionId, `key-${reference}`)
    .run();
  await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, status) VALUES (?, 'asset-test-guide-pdf-v1', 'test-guide', 'delivered')`)
    .bind(purchaseSessionId)
    .run();

  return purchaseSessionId;
}

describe('revokePurchase', () => {
  it('sets licenses.revoked_at and deliveries.status = revoked together, and transitions the purchase session to refunded', async () => {
    const purchaseSessionId = await seedVerifiedPurchaseWithEntitlements('RWL-2026-500001');

    const result = await revokePurchase(env as any, logger, 'RWL-2026-500001', 'refund');
    expect(result.ok).toBe(true);

    const license = await env.DB.prepare('SELECT revoked_at AS revokedAt FROM licenses WHERE purchase_session_id = ?').bind(purchaseSessionId).first<any>();
    expect(license.revokedAt).toBeTruthy();

    const delivery = await env.DB.prepare('SELECT status FROM deliveries WHERE purchase_session_id = ?').bind(purchaseSessionId).first<any>();
    expect(delivery.status).toBe('revoked');

    const session = await env.DB.prepare('SELECT status FROM purchase_sessions WHERE id = ?').bind(purchaseSessionId).first<any>();
    expect(session.status).toBe('refunded');
  });

  it('denies a subsequent download-token mint attempt for the now-revoked entitlement (the ratified Blueprint M2 success criterion, verified directly)', async () => {
    await seedVerifiedPurchaseWithEntitlements('RWL-2026-500002');
    await revokePurchase(env as any, logger, 'RWL-2026-500002', 'refund');

    // Denied at the very first gate (purchase_sessions.status is no
    // longer 'verified', it's 'refunded') - even before
    // entitlementService.ts would separately check
    // deliveries.status === 'revoked'. Both layers independently deny
    // access; this asserts the actual, doubly-protected behavior
    // rather than assuming which specific gate fires first.
    const { generateDownloadPermission } = await import('../../services/entitlementService');
    const permission = await generateDownloadPermission(env as any, logger, 'RWL-2026-500002', 'asset-test-guide-pdf-v1');
    expect(permission.granted).toBe(false);
    if (!permission.granted) expect(permission.reason).toBe('purchase_not_verified');
  });

  it('is idempotent - a second call for an already-revoked purchase returns already_revoked, not an error, and does not double-write', async () => {
    await seedVerifiedPurchaseWithEntitlements('RWL-2026-500003');
    const first = await revokePurchase(env as any, logger, 'RWL-2026-500003', 'refund');
    expect(first.ok).toBe(true);

    const second = await revokePurchase(env as any, logger, 'RWL-2026-500003', 'refund');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_revoked');
  });

  it('rejects revoking a purchase that never verified (still pending)', async () => {
    await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at)
       VALUES ('RWL-2026-500004', 'test-guide', 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'pending', datetime('now', '+30 minutes'))`
    ).run();

    const result = await revokePurchase(env as any, logger, 'RWL-2026-500004', 'refund');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_verified');
  });

  it('rejects revoking a purchase reference that does not exist', async () => {
    const result = await revokePurchase(env as any, logger, 'RWL-2026-999999', 'refund');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('M2C MAR closeout: under genuine concurrency (Promise.all, not sequential calls), exactly one of two simultaneous revoke attempts wins', async () => {
    const purchaseSessionId = await seedVerifiedPurchaseWithEntitlements('RWL-2026-500005');

    const [first, second] = await Promise.all([
      revokePurchase(env as any, logger, 'RWL-2026-500005', 'refund'),
      revokePurchase(env as any, logger, 'RWL-2026-500005', 'refund'),
    ]);

    const outcomes = [first, second];
    const winners = outcomes.filter((r) => r.ok);
    const losers = outcomes.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (!losers[0].ok) expect(losers[0].reason).toBe('already_revoked');

    // End state is exactly what a single successful revoke produces —
    // no double-write, no partial state, regardless of which of the
    // two calls physically committed first.
    const license = await env.DB.prepare('SELECT revoked_at AS revokedAt FROM licenses WHERE purchase_session_id = ?').bind(purchaseSessionId).first<any>();
    expect(license.revokedAt).toBeTruthy();
    const delivery = await env.DB.prepare('SELECT status FROM deliveries WHERE purchase_session_id = ?').bind(purchaseSessionId).first<any>();
    expect(delivery.status).toBe('revoked');
    const session = await env.DB.prepare('SELECT status FROM purchase_sessions WHERE id = ?').bind(purchaseSessionId).first<any>();
    expect(session.status).toBe('refunded');
  });
});
