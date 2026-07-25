/**
 * Unit tests: customer identity — Version 3.0.2 Milestone M1. Covers
 * this sprint's explicit "Customer identity" requirement: first-time
 * customer, existing customer purchasing another product, returning
 * customer using the same email, duplicate purchase protection.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { findOrCreateCustomer, getCustomerById } from '../../services/customer/identityService';

describe('identityService.findOrCreateCustomer', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM customer_profiles');
    await env.DB.exec('DELETE FROM customers');
  });

  it('creates a new customer on first purchase', async () => {
    const result = await findOrCreateCustomer(env as any, 'first-time@example.com', false);
    expect(result.isNewCustomer).toBe(true);
    expect(result.customerId).toBeGreaterThan(0);

    const row = await getCustomerById(env as any, result.customerId);
    expect(row?.email).toBe('first-time@example.com');
    expect(row?.status).toBe('active');
  });

  it('stamps email_verified_at immediately at creation (a successful purchase is itself the identity signal - Sprint 2B MAR gap)', async () => {
    const result = await findOrCreateCustomer(env as any, 'verified-at-creation@example.com', false);
    const row = await env.DB.prepare('SELECT email_verified_at FROM customers WHERE id = ?')
      .bind(result.customerId)
      .first<{ email_verified_at: string | null }>();
    expect(row?.email_verified_at).toBeTruthy();
  });

  it('a genuine concurrent double insert for the same brand-new email resolves to one customer row, not two (Sprint 2B MAR gap: race recovery)', async () => {
    const [first, second] = await Promise.all([
      findOrCreateCustomer(env as any, 'racing-purchase@example.com', false),
      findOrCreateCustomer(env as any, 'racing-purchase@example.com', false),
    ]);

    expect(first.customerId).toBe(second.customerId);
    // Exactly one of the two concurrent calls genuinely inserted the row;
    // the other must have hit the UNIQUE-constraint race-recovery path.
    expect([first.isNewCustomer, second.isNewCustomer].filter(Boolean).length).toBe(1);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM customers WHERE email = ?')
      .bind('racing-purchase@example.com')
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    const profileCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM customer_profiles WHERE customer_id = ?')
      .bind(first.customerId)
      .first<{ n: number }>();
    expect(profileCount?.n).toBe(1); // never a duplicate profile row from the losing side of the race
  });

  it('creates a matching, seeded customer_profiles row', async () => {
    const result = await findOrCreateCustomer(env as any, 'profile-check@example.com', true);
    const profile = await env.DB.prepare('SELECT marketing_opt_in FROM customer_profiles WHERE customer_id = ?')
      .bind(result.customerId)
      .first<{ marketing_opt_in: number }>();
    expect(profile?.marketing_opt_in).toBe(1);
  });

  it('finds the existing customer on a second purchase under the same email (returning customer)', async () => {
    const first = await findOrCreateCustomer(env as any, 'returning@example.com', false);
    const second = await findOrCreateCustomer(env as any, 'returning@example.com', false);

    expect(second.isNewCustomer).toBe(false);
    expect(second.customerId).toBe(first.customerId);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM customers WHERE email = ?')
      .bind('returning@example.com')
      .first<{ n: number }>();
    expect(count?.n).toBe(1); // duplicate purchase protection: never a second row for the same email
  });

  it('is case-insensitive and trims whitespace on the email (same identity either way)', async () => {
    const first = await findOrCreateCustomer(env as any, 'Mixed.Case@Example.com', false);
    const second = await findOrCreateCustomer(env as any, '  mixed.case@example.com  ', false);
    expect(second.customerId).toBe(first.customerId);
  });

  it('never overwrites marketing_opt_in from a later purchase (only seeded once, at creation)', async () => {
    const created = await findOrCreateCustomer(env as any, 'optin-once@example.com', true);
    await findOrCreateCustomer(env as any, 'optin-once@example.com', false); // second purchase, opts out this time

    const profile = await env.DB.prepare('SELECT marketing_opt_in FROM customer_profiles WHERE customer_id = ?')
      .bind(created.customerId)
      .first<{ marketing_opt_in: number }>();
    // Still 1 — a returning customer's profile is not re-seeded on every purchase in M1's scope.
    expect(profile?.marketing_opt_in).toBe(1);
  });
});
