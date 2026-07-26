/**
 * Integration tests: Version 3.1 Milestone M3 (Checkout
 * Auto-Provisioning & Dashboard MVP) backend additions. Exercises the
 * four API Gap Analysis additions through the real Worker fetch
 * handler: purchase/receipt `assets` extension, session list/revoke,
 * and change-password. See docs/v3.1-m3-api-gap-analysis.md.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession } from '../../services/customer/sessionService';
import { setPassword } from '../../services/customer/authService';
import { createLogger } from '../../utils/logger';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

const logger = createLogger('test-request-id', 'test');

beforeEach(async () => {
  await env.DB.exec('DELETE FROM receipt_download_tokens');
  await env.DB.exec('DELETE FROM download_tokens');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM receipts');
  await env.DB.exec('DELETE FROM licenses');
  await env.DB.exec('DELETE FROM order_items');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_password_tokens');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

function extractCookie(res: Response, name: string): string | null {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  for (const raw of setCookies) {
    const match = raw.match(new RegExp(`${name}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

async function seedLoggedInCustomer(email: string, password = 'a-real-strong-password-1'): Promise<{ customerId: number; cookieHeader: string; csrfSecret: string }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const token = `${email}-token`.padEnd(64, '5').slice(0, 64);
  await env.DB.prepare('INSERT INTO customer_password_tokens (token, customer_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, customerId, new Date(Date.now() + 30 * 60_000).toISOString())
    .run();
  await setPassword(env as any, logger, token, password);
  const session = await createSession(env as any, customerId, { ip: null, userAgent: null });
  return { customerId, cookieHeader: `customer_session=${session.sessionToken}; customer_csrf=${session.csrfSecret}`, csrfSecret: session.csrfSecret };
}

async function seedVerifiedPurchase(customerId: number, reference: string): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, customer_id)
     VALUES (?, 'test-guide', 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'), ?)`
  )
    .bind(reference, customerId)
    .run();
  const purchaseSessionId = Number(insert.meta.last_row_id);
  await env.DB.prepare(
    `INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, status, max_downloads, downloads_used) VALUES (?, 'asset-test-guide-pdf-v1', 'test-guide', 'delivered', 5, 2)`
  )
    .bind(purchaseSessionId)
    .run();
  return purchaseSessionId;
}

describe('GET /api/customer/purchases* — assets extension (M3 Gap 1/2)', () => {
  it('a ready purchase includes assets with download usage info', async () => {
    const { cookieHeader } = await seedLoggedInCustomer('m3-assets@example.com');
    await seedVerifiedPurchase((await findOrCreateCustomer(env as any, 'm3-assets@example.com', false)).customerId, 'RWL-2026-800101');

    const res = await SELF.fetch('https://example.com/api/customer/purchases/RWL-2026-800101', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.assets).toHaveLength(1);
    expect(body.data.assets[0].assetId).toBe('asset-test-guide-pdf-v1');
    expect(body.data.assets[0].downloadsUsed).toBe(2);
    expect(body.data.assets[0].maxDownloads).toBe(5);
    expect(body.data.assets[0].revoked).toBe(false);
  });

  it('the list endpoint also includes assets per purchase', async () => {
    const { customerId, cookieHeader } = await seedLoggedInCustomer('m3-assets-list@example.com');
    await seedVerifiedPurchase(customerId, 'RWL-2026-800102');

    const res = await SELF.fetch('https://example.com/api/customer/purchases', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.purchases[0].assets).toHaveLength(1);
  });

  it('a still-processing (pending) purchase has an empty assets array, never a partial one', async () => {
    const { customerId, cookieHeader } = await seedLoggedInCustomer('m3-assets-pending@example.com');
    await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, customer_id)
       VALUES ('RWL-2026-800103', 'test-guide', 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'pending', datetime('now', '+30 minutes'), ?)`
    )
      .bind(customerId)
      .run();

    const res = await SELF.fetch('https://example.com/api/customer/purchases/RWL-2026-800103', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.assets).toEqual([]);
  });
});

describe('GET /api/customer/sessions, POST /api/customer/sessions/:sessionId/revoke (M3 Gap 3)', () => {
  it('lists only the authenticated customer\'s own sessions, flagging the current one', async () => {
    const { cookieHeader } = await seedLoggedInCustomer('m3-sessions@example.com');

    const res = await SELF.fetch('https://example.com/api/customer/sessions', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.sessions).toHaveLength(1);
    expect(body.data.sessions[0].isCurrent).toBe(true);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/sessions');
    expect(res.status).toBe(401);
  });

  it('revokes a different (non-current) session belonging to the same customer', async () => {
    const { customerId, cookieHeader, csrfSecret } = await seedLoggedInCustomer('m3-revoke@example.com');
    const otherSession = await createSession(env as any, customerId, { ip: null, userAgent: null });
    const otherCheck = await env.DB.prepare('SELECT id FROM customer_sessions WHERE token = ?').bind(otherSession.sessionToken).first<{ id: number }>();

    const res = await SELF.fetch(`https://example.com/api/customer/sessions/${otherCheck!.id}/revoke`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret },
    });
    expect((await res.json<any>()).success).toBe(true);

    const revokedRow = await env.DB.prepare('SELECT revoked_at FROM customer_sessions WHERE id = ?').bind(otherCheck!.id).first<{ revoked_at: string | null }>();
    expect(revokedRow?.revoked_at).toBeTruthy();
  });

  it('rejects revoking a session without the CSRF header', async () => {
    const { customerId, cookieHeader } = await seedLoggedInCustomer('m3-revoke-nocsrf@example.com');
    const otherSession = await createSession(env as any, customerId, { ip: null, userAgent: null });
    const otherCheck = await env.DB.prepare('SELECT id FROM customer_sessions WHERE token = ?').bind(otherSession.sessionToken).first<{ id: number }>();

    const res = await SELF.fetch(`https://example.com/api/customer/sessions/${otherCheck!.id}/revoke`, { method: 'POST', headers: { Cookie: cookieHeader } });
    expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
  });

  it('a customer cannot revoke a DIFFERENT customer\'s session (cross-customer ownership check)', async () => {
    const victim = await seedLoggedInCustomer('m3-revoke-victim@example.com');
    const attacker = await seedLoggedInCustomer('m3-revoke-attacker@example.com');
    const victimSessionRow = await env.DB.prepare(
      `SELECT id FROM customer_sessions WHERE customer_id = ? ORDER BY id DESC LIMIT 1`
    )
      .bind(victim.customerId)
      .first<{ id: number }>();

    const res = await SELF.fetch(`https://example.com/api/customer/sessions/${victimSessionRow!.id}/revoke`, {
      method: 'POST',
      headers: { Cookie: attacker.cookieHeader, 'X-Customer-CSRF-Token': attacker.csrfSecret },
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');

    // The victim's session must be completely unaffected.
    const stillActive = await env.DB.prepare('SELECT revoked_at FROM customer_sessions WHERE id = ?').bind(victimSessionRow!.id).first<{ revoked_at: string | null }>();
    expect(stillActive?.revoked_at).toBeNull();
  });

  it('rejects an attempt to revoke the caller\'s OWN current session (M3C Acceptance Review finding)', async () => {
    // docs/v3.1-m3-security-review.md's Session handling section: this
    // route must never allow revoking the current session (that is what
    // logout is for). Found missing during the M3C Acceptance Review and
    // fixed in routes/customer/sessions.ts.
    const { cookieHeader, csrfSecret } = await seedLoggedInCustomer('m3-revoke-self@example.com');
    const sessionsRes = await SELF.fetch('https://example.com/api/customer/sessions', { headers: { Cookie: cookieHeader } });
    const currentSessionId = (await sessionsRes.json<any>()).data.sessions[0].id;

    const res = await SELF.fetch(`https://example.com/api/customer/sessions/${currentSessionId}/revoke`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret },
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('CANNOT_REVOKE_CURRENT_SESSION');

    // The session must still be valid — the caller was not locked out.
    const stillValid = await SELF.fetch('https://example.com/api/customer/auth/session', { headers: { Cookie: cookieHeader } });
    expect((await stillValid.json<any>()).success).toBe(true);
  });

  it('rejects a malformed/oversized :sessionId path parameter, mirroring negativeM2.test.ts', async () => {
    const { cookieHeader, csrfSecret } = await seedLoggedInCustomer('m3-revoke-malformed@example.com');

    for (const malformed of ['not-a-number', '99999999999999999999999999999999', '1 OR 1=1', '<script>alert(1)</script>']) {
      const res = await SELF.fetch(`https://example.com/api/customer/sessions/${encodeURIComponent(malformed)}/revoke`, {
        method: 'POST',
        headers: { Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret },
      });
      const body = await res.json<any>();
      expect(body.success).toBe(false);
      expect(['NOT_FOUND', 'CANNOT_REVOKE_CURRENT_SESSION']).toContain(body.error.code);
    }
  });
});

describe('POST /api/customer/auth/change-password (M3 Gap 4)', () => {
  it('changes the password when the current password is correct, keeping the current session valid', async () => {
    const { cookieHeader, csrfSecret } = await seedLoggedInCustomer('m3-change-pw@example.com', 'the-original-password-1');

    const res = await SELF.fetch('https://example.com/api/customer/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret },
      body: JSON.stringify({ currentPassword: 'the-original-password-1', newPassword: 'a-new-strong-password-2' }),
    });
    expect((await res.json<any>()).success).toBe(true);

    // The current session survives the change.
    const sessionCheck = await SELF.fetch('https://example.com/api/customer/auth/session', { headers: { Cookie: cookieHeader } });
    expect((await sessionCheck.json<any>()).success).toBe(true);

    const loginNew = await SELF.fetch('https://example.com/api/customer/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'm3-change-pw@example.com', password: 'a-new-strong-password-2' }),
    });
    expect((await loginNew.json<any>()).success).toBe(true);
  });

  it('rejects an incorrect current password', async () => {
    const { cookieHeader, csrfSecret } = await seedLoggedInCustomer('m3-change-pw-wrong@example.com', 'the-real-password-1');

    const res = await SELF.fetch('https://example.com/api/customer/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret },
      body: JSON.stringify({ currentPassword: 'totally-wrong', newPassword: 'a-new-strong-password-2' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects a weak new password', async () => {
    const { cookieHeader, csrfSecret } = await seedLoggedInCustomer('m3-change-pw-weak@example.com', 'the-real-password-1');

    const res = await SELF.fetch('https://example.com/api/customer/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret },
      body: JSON.stringify({ currentPassword: 'the-real-password-1', newPassword: 'short' }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a request without the CSRF header', async () => {
    const { cookieHeader } = await seedLoggedInCustomer('m3-change-pw-nocsrf@example.com', 'the-real-password-1');

    const res = await SELF.fetch('https://example.com/api/customer/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ currentPassword: 'the-real-password-1', newPassword: 'a-new-strong-password-2' }),
    });
    expect((await res.json<any>()).error.code).toBe('FORBIDDEN');
  });

  it('safely rejects SQL-injection-shaped values in the request body without error, per the M3A Testing Strategy', async () => {
    const { cookieHeader, csrfSecret } = await seedLoggedInCustomer('m3-change-pw-sqli@example.com', 'the-real-password-1');

    const res = await SELF.fetch('https://example.com/api/customer/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, 'X-Customer-CSRF-Token': csrfSecret },
      body: JSON.stringify({ currentPassword: "' OR '1'='1", newPassword: "'; DROP TABLE customers; --" }),
    });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_CREDENTIALS');

    // The customers table must still exist and be queryable — proves the
    // injection-shaped input was safely parameterized, not concatenated.
    const stillThere = await env.DB.prepare('SELECT COUNT(*) AS n FROM customers').first<{ n: number }>();
    expect(stillThere?.n).toBeGreaterThan(0);
  });
});
