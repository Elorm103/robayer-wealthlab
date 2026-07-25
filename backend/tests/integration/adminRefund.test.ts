/**
 * Integration tests: admin-triggered refund/revocation - Version
 * 3.0.2 Milestone M2 (Orders, Receipts & Customer Library). Exercises
 * POST /api/admin/orders/:reference/refund through the real Worker
 * fetch handler - authorization, the revocation-sync effect, audit
 * logging, and idempotency.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createSession as createAdminSession } from '../../services/admin/sessionService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM download_tokens');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM licenses');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM admin_sessions');
  await env.DB.exec('DELETE FROM admin_users');
});

async function seedAdmin(role: 'super_admin' | 'editor' | 'support' = 'super_admin'): Promise<{ cookieHeader: string; csrfSecret: string; adminId: number }> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', ?, 1)`)
    .bind(`admin-${role}-${Math.random().toString(36).slice(2)}@example.com`, role)
    .run();
  const adminId = Number(insert.meta.last_row_id);
  const session = await createAdminSession(env as any, adminId, { ip: null, userAgent: null });
  return { cookieHeader: `admin_session=${session.sessionToken}; admin_csrf=${session.csrfSecret}`, csrfSecret: session.csrfSecret, adminId };
}

async function seedRevocableOrder(reference: string): Promise<void> {
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
}

describe('POST /api/admin/orders/:reference/refund', () => {
  it('revokes the order and records an audit log entry, as a super_admin with CSRF', async () => {
    await seedRevocableOrder('RWL-2026-800001');
    const { cookieHeader, csrfSecret, adminId } = await seedAdmin('super_admin');

    const res = await SELF.fetch('https://example.com/api/admin/orders/RWL-2026-800001/refund', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret },
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.refunded).toBe(true);

    const session = await env.DB.prepare('SELECT status FROM purchase_sessions WHERE purchase_reference = ?').bind('RWL-2026-800001').first<any>();
    expect(session.status).toBe('refunded');

    const audit = await env.DB.prepare(`SELECT action, actor_id AS actorId FROM audit_logs WHERE action = 'order.refunded'`).first<any>();
    expect(audit).toBeTruthy();
    expect(audit.actorId).toBe(adminId);
  });

  it('rejects without the CSRF header', async () => {
    await seedRevocableOrder('RWL-2026-800002');
    const { cookieHeader } = await seedAdmin('super_admin');

    const res = await SELF.fetch('https://example.com/api/admin/orders/RWL-2026-800002/refund', { method: 'POST', headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');

    const session = await env.DB.prepare('SELECT status FROM purchase_sessions WHERE purchase_reference = ?').bind('RWL-2026-800002').first<any>();
    expect(session.status).toBe('verified'); // unchanged - the rejected request must never have taken effect
  });

  it('rejects a support-role admin (EDITOR_ROLES-gated, matching the existing resend actions)', async () => {
    await seedRevocableOrder('RWL-2026-800003');
    const { cookieHeader, csrfSecret } = await seedAdmin('support');

    const res = await SELF.fetch('https://example.com/api/admin/orders/RWL-2026-800003/refund', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret },
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects an unauthenticated request', async () => {
    await seedRevocableOrder('RWL-2026-800004');
    const res = await SELF.fetch('https://example.com/api/admin/orders/RWL-2026-800004/refund', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('is idempotent - refunding an already-refunded order returns a clean error, not a 500, and does not double-log', async () => {
    await seedRevocableOrder('RWL-2026-800005');
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');

    await SELF.fetch('https://example.com/api/admin/orders/RWL-2026-800005/refund', { method: 'POST', headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret } });
    const second = await SELF.fetch('https://example.com/api/admin/orders/RWL-2026-800005/refund', { method: 'POST', headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret } });
    expect(second.status).toBeLessThan(500);
    const body = await second.json<any>();
    expect(body.success).toBe(false);

    const auditCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'order.refunded'`).first<any>();
    expect(auditCount.n).toBe(1);
  });

  it('the revoked entitlement correctly denies a subsequent download-permission request end to end', async () => {
    await seedRevocableOrder('RWL-2026-800006');
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    await SELF.fetch('https://example.com/api/admin/orders/RWL-2026-800006/refund', { method: 'POST', headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret } });

    const res = await SELF.fetch('https://example.com/api/purchases/RWL-2026-800006/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: 'asset-test-guide-pdf-v1' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('DOWNLOAD_NOT_AVAILABLE');
  });

  it('M2C MAR closeout: two genuinely simultaneous refund requests for the same order (Promise.all, real HTTP, not sequential) produce exactly one audit log entry', async () => {
    await seedRevocableOrder('RWL-2026-800007');
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');

    const [first, second] = await Promise.all([
      SELF.fetch('https://example.com/api/admin/orders/RWL-2026-800007/refund', { method: 'POST', headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret } }),
      SELF.fetch('https://example.com/api/admin/orders/RWL-2026-800007/refund', { method: 'POST', headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret } }),
    ]);
    const [firstBody, secondBody] = await Promise.all([first.json<any>(), second.json<any>()]);

    const successes = [firstBody, secondBody].filter((b) => b.success);
    expect(successes).toHaveLength(1); // exactly one request actually performed the refund

    const auditCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'order.refunded'`).first<any>();
    expect(auditCount.n).toBe(1); // the loser never reached the audit-log call

    const session = await env.DB.prepare('SELECT status FROM purchase_sessions WHERE purchase_reference = ?').bind('RWL-2026-800007').first<any>();
    expect(session.status).toBe('refunded');
  });
});
