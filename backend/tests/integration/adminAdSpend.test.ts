/**
 * Integration tests: admin advertising spend ledger — P0-B (Business
 * Intelligence backbone, first component). Exercises GET/POST
 * /api/admin/ad-spend, PATCH and DELETE /api/admin/ad-spend/:id
 * through the real Worker fetch handler — role gating (viewing open to
 * all roles, mutation editor-only), CSRF, and soft-delete are the
 * central concerns, matching adminCoupons.test.ts's established
 * pattern for this codebase's comparable financial-record resource.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createSession as createAdminSession } from '../../services/admin/sessionService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM ad_spend_entries');
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

const VALID_ENTRY = { entryDate: '2026-08-05', source: 'meta', campaignLabel: 'RWL | Book 3 | Ghana | Purchase', amountMinorUnits: 470, currency: 'USD', notes: null };

describe('POST /api/admin/ad-spend', () => {
  it('creates a spend entry as super_admin with CSRF, preserving its original currency, and writes an audit log entry', async () => {
    const { cookieHeader, csrfSecret, adminId } = await seedAdmin('super_admin');

    const res = await SELF.fetch('https://example.com/api/admin/ad-spend', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_ENTRY),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const row = await env.DB.prepare('SELECT currency, amount_minor_units AS amountMinorUnits FROM ad_spend_entries WHERE id = ?').bind(body.data.id).first<any>();
    expect(row.currency).toBe('USD');
    expect(row.amountMinorUnits).toBe(470);

    const audit = await env.DB.prepare(`SELECT actor_id AS actorId FROM audit_logs WHERE action = 'ad_spend.created'`).first<any>();
    expect(audit.actorId).toBe(adminId);
  });

  it('creates a spend entry as editor', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('editor');
    const res = await SELF.fetch('https://example.com/api/admin/ad-spend', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_ENTRY),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
  });

  it('rejects an invalid source with VALIDATION_ERROR', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    const res = await SELF.fetch('https://example.com/api/admin/ad-spend', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_ENTRY, source: 'tiktok' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a support-role admin (editor-only, matching the coupons convention)', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('support');
    const res = await SELF.fetch('https://example.com/api/admin/ad-spend', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_ENTRY),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a request without the CSRF header', async () => {
    const { cookieHeader } = await seedAdmin('super_admin');
    const res = await SELF.fetch('https://example.com/api/admin/ad-spend', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_ENTRY),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/admin/ad-spend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_ENTRY),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/ad-spend', () => {
  it('is open to every authenticated admin role, including support', async () => {
    const { cookieHeader } = await seedAdmin('support');
    const res = await SELF.fetch('https://example.com/api/admin/ad-spend', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/admin/ad-spend');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/admin/ad-spend/:id', () => {
  it('updates only the supplied fields, never converting currency', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    const createRes = await SELF.fetch('https://example.com/api/admin/ad-spend', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_ENTRY),
    });
    const { data } = await createRes.json<any>();

    const res = await SELF.fetch(`https://example.com/api/admin/ad-spend/${data.id}`, {
      method: 'PATCH',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountMinorUnits: 999 }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const row = await env.DB.prepare('SELECT amount_minor_units AS amountMinorUnits, currency FROM ad_spend_entries WHERE id = ?').bind(data.id).first<any>();
    expect(row.amountMinorUnits).toBe(999);
    expect(row.currency).toBe('USD'); // untouched
  });

  it('rejects a support-role admin', async () => {
    const admin = await seedAdmin('super_admin');
    const createRes = await SELF.fetch('https://example.com/api/admin/ad-spend', {
      method: 'POST',
      headers: { Cookie: admin.cookieHeader, 'X-CSRF-Token': admin.csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_ENTRY),
    });
    const { data } = await createRes.json<any>();

    const support = await seedAdmin('support');
    const res = await SELF.fetch(`https://example.com/api/admin/ad-spend/${data.id}`, {
      method: 'PATCH',
      headers: { Cookie: support.cookieHeader, 'X-CSRF-Token': support.csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountMinorUnits: 999 }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });
});

describe('DELETE /api/admin/ad-spend/:id', () => {
  it('soft-deletes an entry — hidden from the list, but the row is never removed', async () => {
    const { cookieHeader, csrfSecret } = await seedAdmin('super_admin');
    const createRes = await SELF.fetch('https://example.com/api/admin/ad-spend', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_ENTRY),
    });
    const { data } = await createRes.json<any>();

    const res = await SELF.fetch(`https://example.com/api/admin/ad-spend/${data.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfSecret },
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);

    const listRes = await SELF.fetch('https://example.com/api/admin/ad-spend', { headers: { Cookie: cookieHeader } });
    const listBody = await listRes.json<any>();
    expect(listBody.data.items.find((i: any) => i.id === data.id)).toBeUndefined();

    const row = await env.DB.prepare('SELECT deleted_at FROM ad_spend_entries WHERE id = ?').bind(data.id).first<any>();
    expect(row).toBeTruthy(); // row still exists — soft delete only
    expect(row.deleted_at).toBeTruthy();
  });

  it('rejects a support-role admin', async () => {
    const admin = await seedAdmin('super_admin');
    const createRes = await SELF.fetch('https://example.com/api/admin/ad-spend', {
      method: 'POST',
      headers: { Cookie: admin.cookieHeader, 'X-CSRF-Token': admin.csrfSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_ENTRY),
    });
    const { data } = await createRes.json<any>();

    const support = await seedAdmin('support');
    const res = await SELF.fetch(`https://example.com/api/admin/ad-spend/${data.id}`, {
      method: 'DELETE',
      headers: { Cookie: support.cookieHeader, 'X-CSRF-Token': support.csrfSecret },
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });
});
