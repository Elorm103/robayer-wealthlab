/**
 * Unit tests: customer session lifecycle — Version 3.0.2 Milestone M1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import * as sessionService from '../../services/customer/sessionService';
import { findOrCreateCustomer } from '../../services/customer/identityService';

describe('customer sessionService', () => {
  let customerId: number;

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM customer_sessions');
    await env.DB.exec('DELETE FROM customer_profiles');
    await env.DB.exec('DELETE FROM customers');
    const created = await findOrCreateCustomer(env as any, `session-test-${Date.now()}@example.com`, false);
    customerId = created.customerId;
  });

  it('creates a session and validates it successfully', async () => {
    const session = await sessionService.createSession(env as any, customerId, { ip: '1.2.3.4', userAgent: 'test-agent' });
    expect(session.sessionToken).toMatch(/^[a-f0-9]{64}$/);

    const check = await sessionService.validateSession(env as any, session.sessionToken);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.customerId).toBe(customerId);
    }
  });

  it('rejects a garbage token without touching the database', async () => {
    const check = await sessionService.validateSession(env as any, 'not-a-real-token');
    expect(check.ok).toBe(false);
  });

  it('rejects an unknown, well-formed-looking token', async () => {
    const fakeToken = 'a'.repeat(64);
    const check = await sessionService.validateSession(env as any, fakeToken);
    expect(check.ok).toBe(false);
  });

  it('revokes a session, after which it no longer validates', async () => {
    const session = await sessionService.createSession(env as any, customerId, { ip: null, userAgent: null });
    const revoke = await sessionService.revokeSession(env as any, session.sessionToken);
    expect(revoke.revoked).toBe(true);

    const check = await sessionService.validateSession(env as any, session.sessionToken);
    expect(check.ok).toBe(false);
  });

  it('revoking an already-revoked session is idempotent (returns false, not an error)', async () => {
    const session = await sessionService.createSession(env as any, customerId, { ip: null, userAgent: null });
    await sessionService.revokeSession(env as any, session.sessionToken);
    const second = await sessionService.revokeSession(env as any, session.sessionToken);
    expect(second.revoked).toBe(false);
  });

  it('revokeAllSessions invalidates every active session for that customer', async () => {
    const s1 = await sessionService.createSession(env as any, customerId, { ip: null, userAgent: null });
    const s2 = await sessionService.createSession(env as any, customerId, { ip: null, userAgent: null });

    await sessionService.revokeAllSessions(env as any, customerId);

    expect((await sessionService.validateSession(env as any, s1.sessionToken)).ok).toBe(false);
    expect((await sessionService.validateSession(env as any, s2.sessionToken)).ok).toBe(false);
  });
});
