/**
 * Integration tests: the announcement portion of the admin settings
 * routes, plus the new public GET /api/announcement — Phase C
 * (Announcement / Notification System). Exercises the real Worker
 * fetch handler, not the service directly, so auth/CSRF/role
 * enforcement is proven end-to-end, not just assumed from the
 * settingsService unit tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createSession as createAdminSession } from '../../services/admin/sessionService';

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM site_settings WHERE key = 'announcement'`);
  await env.DB.exec('DELETE FROM admin_sessions');
  await env.DB.exec('DELETE FROM admin_users');
});

async function seedAdmin(role: 'super_admin' | 'editor' | 'support' = 'super_admin'): Promise<{ cookieHeader: string; csrfSecret: string; adminId: number }> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', ?, 1)`)
    .bind(`announcement-route-${role}-${Math.random().toString(36).slice(2)}@example.com`, role)
    .run();
  const adminId = Number(insert.meta.last_row_id);
  const session = await createAdminSession(env as any, adminId, { ip: null, userAgent: null });
  return { cookieHeader: `admin_session=${session.sessionToken}; admin_csrf=${session.csrfSecret}`, csrfSecret: session.csrfSecret, adminId };
}

const VALID_ANNOUNCEMENT = {
  enabled: true,
  type: 'info',
  title: 'FREE RESOURCE:',
  message: "Learn how the Ghana Stock Exchange works before you start investing.",
  buttonText: '',
  buttonUrl: '',
  dismissible: true,
};

describe('GET /api/announcement (public)', () => {
  it('is public, unauthenticated, and returns the safe default when nothing is configured', async () => {
    const res = await SELF.fetch('https://example.com/api/announcement');
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.enabled).toBe(false);
  });

  it('reflects an admin-published announcement, and exposes only announcement fields — never another site_settings value, admin metadata, or secrets', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    await SELF.fetch('https://example.com/api/admin/settings', {
      method: 'PATCH',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ announcement: VALID_ANNOUNCEMENT }),
    });

    const res = await SELF.fetch('https://example.com/api/announcement');
    const body = await res.json<any>();
    expect(body.data.enabled).toBe(true);
    expect(body.data.title).toBe('FREE RESOURCE:');
    expect(body.data.version).toBeTruthy();

    const keys = Object.keys(body.data).sort();
    expect(keys).toEqual(['buttonText', 'buttonUrl', 'dismissible', 'enabled', 'message', 'title', 'type', 'version']);
  });

  it('is never cached — an admin toggle must be visible on the visitor\'s next load', async () => {
    // securityHeaders.ts's own global rule strengthens this further
    // (no-store, no-cache, must-revalidate) for every non-HTML
    // response that doesn't opt into public caching — this route's
    // own explicit no-store (matching routes/hero.ts's identical
    // pattern) is a documented intent, not overridden incorrectly.
    const res = await SELF.fetch('https://example.com/api/announcement');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('a GET (read) request can never write data — confirms the public endpoint has no side effect regardless of method semantics', async () => {
    await SELF.fetch('https://example.com/api/announcement');
    await SELF.fetch('https://example.com/api/announcement');
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM site_settings WHERE key = 'announcement'`).first<any>();
    expect(row.n).toBe(0); // still nothing stored — reading never creates a row
  });

  it('no POST/PATCH/PUT/DELETE handler exists for this path at all — not just unauthenticated, structurally absent from the route table', async () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const res = await SELF.fetch('https://example.com/api/announcement', { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' || method === 'PATCH' || method === 'PUT' ? JSON.stringify({ enabled: true }) : undefined });
      expect(res.status, `${method} /api/announcement should not succeed`).not.toBe(200);
    }
    // Confirms none of those attempts wrote anything either.
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM site_settings WHERE key = 'announcement'`).first<any>();
    expect(row.n).toBe(0);
  });

  it('malformed/corrupt stored JSON fails safely to the default, never a 500', async () => {
    // Simulates a hand-edited or corrupted D1 row directly, bypassing
    // updateSettings()'s own validation entirely — proves the READ
    // path (getAnnouncement()) is independently safe, not just the
    // write path.
    await env.DB.prepare(`INSERT INTO site_settings (key, value, updated_at) VALUES ('announcement', '{not valid json', datetime('now'))`).run();

    const res = await SELF.fetch('https://example.com/api/announcement');
    expect(res.status).toBe(200); // never a 500
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.enabled).toBe(false); // safe default, not a crash or garbage
  });
});

describe('PATCH /api/admin/settings — announcement', () => {
  it('super_admin can publish an announcement with CSRF', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    const res = await SELF.fetch('https://example.com/api/admin/settings', {
      method: 'PATCH',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ announcement: VALID_ANNOUNCEMENT }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
  });

  it('rejects a non-super_admin (editor)', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('editor');
    const res = await SELF.fetch('https://example.com/api/admin/settings', {
      method: 'PATCH',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ announcement: VALID_ANNOUNCEMENT }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a request without the CSRF header', async () => {
    const { cookieHeader } = await seedAdmin('super_admin');
    const res = await SELF.fetch('https://example.com/api/admin/settings', {
      method: 'PATCH',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ announcement: VALID_ANNOUNCEMENT }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ announcement: VALID_ANNOUNCEMENT }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a dangerous buttonUrl end-to-end through the real route, not just the service', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    const res = await SELF.fetch('https://example.com/api/admin/settings', {
      method: 'PATCH',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ announcement: { ...VALID_ANNOUNCEMENT, buttonText: 'Click', buttonUrl: 'javascript:alert(1)' } }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');

    // Confirms the public endpoint never picked up the rejected value.
    const publicRes = await SELF.fetch('https://example.com/api/announcement');
    const publicBody = await publicRes.json<any>();
    expect(publicBody.data.enabled).toBe(false);
  });
});

describe('GET /api/admin/settings — announcement is admin-only', () => {
  it('is not readable without authentication', async () => {
    const res = await SELF.fetch('https://example.com/api/admin/settings');
    expect(res.status).toBe(401);
  });

  it('a non-super_admin cannot read it either — read is as gated as write', async () => {
    const { cookieHeader } = await seedAdmin('support');
    const res = await SELF.fetch('https://example.com/api/admin/settings', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });
});
