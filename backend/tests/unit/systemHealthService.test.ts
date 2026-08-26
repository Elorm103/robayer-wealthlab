/**
 * Unit tests: services/admin/systemHealthService.ts — Admin Analytics
 * Dashboard v2 (2026-08-27). Regression coverage for the two real
 * problems that pass fixed: (1) System Health was never wired into
 * admin/analytics/index.html (the endpoint itself already worked —
 * this file's own tests exercise that same endpoint, GET
 * /api/admin/dashboard/health, via the real Worker), and (2) the new
 * RATE_LIMIT_KV/Analytics/Online-Now checks plus the derived Checkout
 * check that must NOT inherit RATE_LIMIT_KV's degraded status —
 * exactly the distinction the 2026-08-26 incident exists to teach
 * this dashboard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { getSystemHealth } from '../../services/admin/systemHealthService';
import { queueSitePageResponse } from '../outboundMock';

const REQUEST = new Request('https://example.com/api/admin/dashboard/health');
/** getSystemHealth() caches its result in RATE_LIMIT_KV for 60s (see that file's own header comment) — a real KV binding in this test environment, not reset between `it()` blocks, so every test that needs a FRESH computation (i.e. almost all of them, since they're each simulating a different live condition) must clear this key first or it will silently see a previous test's cached result instead of its own mocked scenario. */
async function clearHealthCache(): Promise<void> {
  await env.RATE_LIMIT_KV.delete('system-health:v1');
}

async function seedAdmin(): Promise<{ id: number; token: string }> {
  const insert = await env.DB.prepare(
    `INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', 'super_admin', 1)`
  )
    .bind(`health-test-admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  const id = Number(insert.meta.last_row_id);
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare(
    `INSERT INTO admin_sessions (token, admin_id, csrf_secret, expires_at) VALUES (?, ?, 'test-csrf-secret', ?)`
  )
    .bind(token, id, new Date(Date.now() + 30 * 60_000).toISOString())
    .run();
  return { id, token };
}

beforeEach(async () => {
  await clearHealthCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getSystemHealth', () => {
  it('includes the new RATE_LIMIT_KV, Analytics, Online Now, and derived Checkout checks alongside the pre-existing ones', async () => {
    await queueSitePageResponse(env as any, '/', '<html><body>ok</body></html>');
    const health = await getSystemHealth(env as any, REQUEST);
    const keys = health.checks.map((c) => c.key);

    expect(keys).toEqual(
      expect.arrayContaining(['website', 'worker', 'database', 'storage', 'rateLimitKv', 'analytics', 'onlineNow', 'paystack', 'resend', 'checkout', 'cron'])
    );
  });

  it('does not throw when RATE_LIMIT_KV.put() fails — the exact 2026-08-26 incident: a cache-miss health check must not itself crash trying to cache or probe-write to the thing it is reporting on', async () => {
    await queueSitePageResponse(env as any, '/', '<html><body>ok</body></html>');
    vi.spyOn(env.RATE_LIMIT_KV, 'put').mockRejectedValue(new Error('KV put() limit exceeded for the day.'));

    await expect(getSystemHealth(env as any, REQUEST)).resolves.toBeDefined();
  });

  it('reports RATE_LIMIT_KV as degraded (not healthy) when its write probe fails, honestly — never a fabricated green status', async () => {
    await queueSitePageResponse(env as any, '/', '<html><body>ok</body></html>');
    vi.spyOn(env.RATE_LIMIT_KV, 'put').mockRejectedValue(new Error('KV put() limit exceeded for the day.'));

    const health = await getSystemHealth(env as any, REQUEST);
    const rateLimitKv = health.checks.find((c) => c.key === 'rateLimitKv');
    expect(rateLimitKv?.status).toBe('warning');
    expect(rateLimitKv?.detail).toMatch(/Cloudflare KV unavailable or quota exhausted/);

    // The overall status must reflect this honestly too — never "healthy" straight through a real degradation.
    expect(health.overallStatus).not.toBe('healthy');
  });

  it('the derived Checkout check stays HEALTHY when RATE_LIMIT_KV is degraded but Paystack itself is reachable — the exact distinction the fail-open rate-limit fix exists to make true', async () => {
    await queueSitePageResponse(env as any, '/', '<html><body>ok</body></html>');
    vi.spyOn(env.RATE_LIMIT_KV, 'put').mockRejectedValue(new Error('KV put() limit exceeded for the day.'));

    const health = await getSystemHealth(env as any, REQUEST);
    const rateLimitKv = health.checks.find((c) => c.key === 'rateLimitKv');
    const checkout = health.checks.find((c) => c.key === 'checkout');

    expect(rateLimitKv?.status).toBe('warning');
    expect(checkout?.status).toBe('healthy');
    expect(checkout?.detail).toMatch(/fallback mode/);
  });

  it('the derived Checkout check goes DOWN when Paystack itself is unreachable, regardless of RATE_LIMIT_KV state', async () => {
    await queueSitePageResponse(env as any, '/', '<html><body>ok</body></html>');
    const { queuePaystackHealthResponse } = await import('../outboundMock');
    await queuePaystackHealthResponse(env as any, { status: 401, body: { status: false, message: 'Invalid key' } });

    const health = await getSystemHealth(env as any, REQUEST);
    const checkout = health.checks.find((c) => c.key === 'checkout');
    expect(checkout?.status).toBe('error');
  });

  it('reports Online Now as degraded (not healthy, not a crash) when the KV list() lookup fails', async () => {
    await queueSitePageResponse(env as any, '/', '<html><body>ok</body></html>');
    vi.spyOn(env.RATE_LIMIT_KV, 'list').mockRejectedValue(new Error('KV list() limit exceeded for the day.'));

    const health = await getSystemHealth(env as any, REQUEST);
    const onlineNow = health.checks.find((c) => c.key === 'onlineNow');
    expect(onlineNow?.status).toBe('warning');
  });

  it('reports Analytics as healthy when recent events exist, and as a (non-alarming) warning when none do — never a fabricated error from ordinary quiet', async () => {
    await env.DB.exec('DELETE FROM analytics_events');
    await queueSitePageResponse(env as any, '/', '<html><body>ok</body></html>');

    const quiet = await getSystemHealth(env as any, REQUEST);
    expect(quiet.checks.find((c) => c.key === 'analytics')?.status).toBe('warning');

    await env.DB.prepare(
      `INSERT INTO analytics_events (event_type, page_path, session_id, created_at) VALUES ('page_view', '/', 'health-test-session', datetime('now'))`
    ).run();
    await clearHealthCache();
    const active = await getSystemHealth(env as any, REQUEST);
    expect(active.checks.find((c) => c.key === 'analytics')?.status).toBe('healthy');
  });

  it('regression: GET /api/admin/dashboard/health (the real endpoint the Analytics page now calls) responds successfully through the real Worker, authenticated', async () => {
    await queueSitePageResponse(env as any, '/', '<html><body>ok</body></html>');
    const { token } = await seedAdmin();

    const res = await SELF.fetch('https://example.com/api/admin/dashboard/health', {
      headers: { Cookie: `admin_session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.checks)).toBe(true);
    expect(body.data.checks.map((c: any) => c.key)).toEqual(expect.arrayContaining(['rateLimitKv', 'analytics', 'onlineNow', 'checkout']));
  });
});
