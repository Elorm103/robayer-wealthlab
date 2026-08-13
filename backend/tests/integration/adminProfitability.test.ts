/**
 * Integration tests: admin profitability reporting routes — P0-D
 * (Business Intelligence backbone). Exercises GET
 * /api/admin/profitability/summary and /campaigns through the real
 * Worker fetch handler — read-only, open to every authenticated admin
 * role including support (matching routes/admin/executiveDashboard.ts's
 * own precedent), unauthenticated rejected. Calculation correctness
 * itself is covered by tests/unit/profitabilityService.test.ts; this
 * file only covers the HTTP/auth layer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createSession as createAdminSession } from '../../services/admin/sessionService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM admin_sessions');
  await env.DB.exec('DELETE FROM admin_users');
});

async function seedAdmin(role: 'super_admin' | 'editor' | 'support' = 'support'): Promise<{ cookieHeader: string }> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', ?, 1)`)
    .bind(`admin-${role}-${Math.random().toString(36).slice(2)}@example.com`, role)
    .run();
  const adminId = Number(insert.meta.last_row_id);
  const session = await createAdminSession(env as any, adminId, { ip: null, userAgent: null });
  return { cookieHeader: `admin_session=${session.sessionToken}; admin_csrf=${session.csrfSecret}` };
}

describe('GET /api/admin/profitability/summary', () => {
  it('is open to a support-role admin (read-only, no mutation exists on this feature)', async () => {
    const { cookieHeader } = await seedAdmin('support');
    const res = await SELF.fetch('https://example.com/api/admin/profitability/summary', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(typeof body.data.grossRevenuePesewas).toBe('number');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/admin/profitability/summary');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/profitability/campaigns', () => {
  it('is open to a support-role admin', async () => {
    const { cookieHeader } = await seedAdmin('support');
    const res = await SELF.fetch('https://example.com/api/admin/profitability/campaigns', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.campaigns)).toBe(true);
    expect(Array.isArray(body.data.nonGhsSpend)).toBe(true);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/admin/profitability/campaigns');
    expect(res.status).toBe(401);
  });
});
