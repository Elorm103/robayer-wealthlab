/**
 * Unit tests for routes/staticPageRelay.ts's shouldRelayToStaticPages()
 * — the pure routing predicate that decides whether a request falls
 * into the four GitHub-Pages-relayed path groups. The actual relayed
 * fetch to elorm103.github.io is a real external HTTPS call and is
 * verified live post-deploy (security audit follow-up, 2026-09-16),
 * not mocked here — this file only proves the routing decision itself
 * is correct, and specifically that it can never intercept an /api/*
 * request (matchedRoute in worker/index.ts is always checked first,
 * but this predicate's own scope is asserted directly too, as a second
 * layer of proof it could never plausibly match an API path).
 */
import { describe, it, expect } from 'vitest';
import { shouldRelayToStaticPages } from '../../routes/staticPageRelay';

describe('shouldRelayToStaticPages', () => {
  it('matches GET requests under each of the four relayed prefixes', () => {
    expect(shouldRelayToStaticPages('/admin/login/', 'GET')).toBe(true);
    expect(shouldRelayToStaticPages('/checkout/callback/', 'GET')).toBe(true);
    expect(shouldRelayToStaticPages('/checkout/sign-in/', 'GET')).toBe(true);
    expect(shouldRelayToStaticPages('/dashboard/', 'GET')).toBe(true);
    expect(shouldRelayToStaticPages('/affiliate/', 'GET')).toBe(true);
  });

  it('matches HEAD requests the same way as GET', () => {
    expect(shouldRelayToStaticPages('/admin/login/', 'HEAD')).toBe(true);
  });

  it('never matches any other HTTP method, even under a relayed prefix', () => {
    expect(shouldRelayToStaticPages('/admin/login/', 'POST')).toBe(false);
    expect(shouldRelayToStaticPages('/dashboard/', 'PUT')).toBe(false);
    expect(shouldRelayToStaticPages('/affiliate/', 'DELETE')).toBe(false);
  });

  it('never matches /api/* — the real access-control boundary for every state-changing action stays untouched', () => {
    expect(shouldRelayToStaticPages('/api/admin/auth/login', 'GET')).toBe(false);
    expect(shouldRelayToStaticPages('/api/admin/auth/login', 'POST')).toBe(false);
    expect(shouldRelayToStaticPages('/api/checkout/sessions', 'POST')).toBe(false);
    expect(shouldRelayToStaticPages('/api/purchases/RWL-2026-000001', 'GET')).toBe(false);
  });

  it('never matches the Worker-rendered paths (/, /books/*, /blog/*, /resources/*, /free-guide/*)', () => {
    expect(shouldRelayToStaticPages('/', 'GET')).toBe(false);
    expect(shouldRelayToStaticPages('/books/fixed-deposits-in-ghana/', 'GET')).toBe(false);
    expect(shouldRelayToStaticPages('/blog/some-post/', 'GET')).toBe(false);
    expect(shouldRelayToStaticPages('/resources/', 'GET')).toBe(false);
    expect(shouldRelayToStaticPages('/free-guide/', 'GET')).toBe(false);
  });

  it('never matches unrelated static paths like /js/* or /css/* or /about/', () => {
    expect(shouldRelayToStaticPages('/js/main.js', 'GET')).toBe(false);
    expect(shouldRelayToStaticPages('/css/tokens.css', 'GET')).toBe(false);
    expect(shouldRelayToStaticPages('/about/', 'GET')).toBe(false);
  });

  it('requires a trailing slash on the prefix — a lookalike path must not match', () => {
    expect(shouldRelayToStaticPages('/administration/', 'GET')).toBe(false);
    expect(shouldRelayToStaticPages('/dashboardish/', 'GET')).toBe(false);
  });
});
