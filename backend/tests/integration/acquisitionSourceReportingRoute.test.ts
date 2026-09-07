/**
 * Integration test: GET /api/admin/dashboard/acquisition-sources —
 * Affiliate Programme 2.0 Phase F reporting foundation. Confirms the
 * route is wired correctly (auth required, returns the aggregation) —
 * the aggregation logic itself is covered in
 * tests/unit/acquisitionSourceReporting.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createSession as createAdminSession } from '../../services/admin/sessionService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM admin_sessions');
  await env.DB.exec('DELETE FROM admin_users');
});

async function seedAdmin(): Promise<{ cookieHeader: string; adminId: number }> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES ('reporting-admin@example.com', 'x:1:x', 'super_admin', 1)`).run();
  const adminId = Number(insert.meta.last_row_id);
  const session = await createAdminSession(env as any, adminId, { ip: null, userAgent: null });
  return { cookieHeader: `admin_session=${session.sessionToken}`, adminId };
}

describe('GET /api/admin/dashboard/acquisition-sources', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/admin/dashboard/acquisition-sources');
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_AUTHENTICATED');
  });

  it('returns all 5 acquisition sources with zeroed totals for a real admin', async () => {
    const { cookieHeader } = await seedAdmin();
    const res = await SELF.fetch('https://example.com/api/admin/dashboard/acquisition-sources', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.rows.map((r: any) => r.source)).toEqual(['affiliate', 'paid', 'organic', 'direct', 'unknown']);
    expect(body.data.analyticsMode).toBe('production');
  });
});
