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

  // Version 3.1 Milestone M3 (Checkout Auto-Provisioning & Dashboard MVP) — Account Security's own-sessions list/revoke.

  it('listActiveSessions returns only this customer\'s own active sessions, correctly flagging the current one', async () => {
    const s1 = await sessionService.createSession(env as any, customerId, { ip: '1.1.1.1', userAgent: 'agent-1' });
    const s2 = await sessionService.createSession(env as any, customerId, { ip: '2.2.2.2', userAgent: 'agent-2' });
    const check1 = await sessionService.validateSession(env as any, s1.sessionToken);
    if (!check1.ok) throw new Error('expected session to validate');

    const sessions = await sessionService.listActiveSessions(env as any, customerId, check1.sessionId);
    expect(sessions.length).toBe(2);
    const currentEntry = sessions.find((s) => s.isCurrent);
    expect(currentEntry).toBeTruthy();
    expect(sessions.filter((s) => !s.isCurrent).length).toBe(1);
    void s2;
  });

  it('listActiveSessions never returns a revoked session', async () => {
    const s1 = await sessionService.createSession(env as any, customerId, { ip: null, userAgent: null });
    await sessionService.revokeSession(env as any, s1.sessionToken);
    const s2 = await sessionService.createSession(env as any, customerId, { ip: null, userAgent: null });
    const check2 = await sessionService.validateSession(env as any, s2.sessionToken);
    if (!check2.ok) throw new Error('expected session to validate');

    const sessions = await sessionService.listActiveSessions(env as any, customerId, check2.sessionId);
    expect(sessions.length).toBe(1);
    expect(sessions[0].isCurrent).toBe(true);
  });

  it('revokeSessionById revokes exactly the targeted session, ownership-checked', async () => {
    const s1 = await sessionService.createSession(env as any, customerId, { ip: null, userAgent: null });
    const s2 = await sessionService.createSession(env as any, customerId, { ip: null, userAgent: null });
    const check1 = await sessionService.validateSession(env as any, s1.sessionToken);
    if (!check1.ok) throw new Error('expected session to validate');

    const result = await sessionService.revokeSessionById(env as any, customerId, check1.sessionId);
    expect(result.ok).toBe(true);

    expect((await sessionService.validateSession(env as any, s1.sessionToken)).ok).toBe(false);
    expect((await sessionService.validateSession(env as any, s2.sessionToken)).ok).toBe(true);
  });

  it('revokeSessionById refuses to revoke a session belonging to a DIFFERENT customer (the one new authorization shape M3 introduces, per docs/v3.1-m3-security-review.md)', async () => {
    const otherCustomer = await findOrCreateCustomer(env as any, `session-test-other-${Date.now()}@example.com`, false);
    const victimSession = await sessionService.createSession(env as any, otherCustomer.customerId, { ip: null, userAgent: null });
    const victimCheck = await sessionService.validateSession(env as any, victimSession.sessionToken);
    if (!victimCheck.ok) throw new Error('expected session to validate');

    // customerId (the beforeEach-seeded customer) attempts to revoke a session that belongs to otherCustomer.
    const result = await sessionService.revokeSessionById(env as any, customerId, victimCheck.sessionId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');

    // The victim's session must still be fully valid — the cross-customer attempt had zero effect.
    expect((await sessionService.validateSession(env as any, victimSession.sessionToken)).ok).toBe(true);
  });

  it('revokeAllSessionsExcept revokes every other session but preserves the named one', async () => {
    const s1 = await sessionService.createSession(env as any, customerId, { ip: null, userAgent: null });
    const s2 = await sessionService.createSession(env as any, customerId, { ip: null, userAgent: null });
    const check1 = await sessionService.validateSession(env as any, s1.sessionToken);
    if (!check1.ok) throw new Error('expected session to validate');

    await sessionService.revokeAllSessionsExcept(env as any, customerId, check1.sessionId);

    expect((await sessionService.validateSession(env as any, s1.sessionToken)).ok).toBe(true);
    expect((await sessionService.validateSession(env as any, s2.sessionToken)).ok).toBe(false);
  });
});
