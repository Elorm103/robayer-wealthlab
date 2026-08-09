/**
 * Unit tests: services/analytics/hashing.ts — Version 5.0 (Customer
 * Acquisition Phase 1, Phase 9 Privacy). Meta requires every user_data
 * identifier as lowercase-trimmed SHA-256 hex; these tests pin down
 * that exact normalization, not just "produces some hash."
 */
import { describe, it, expect } from 'vitest';
import { hashEmail } from '../../../services/analytics/hashing';

describe('hashing.hashEmail', () => {
  it('returns a 64-character lowercase hex SHA-256 digest for a real email', async () => {
    const hash = await hashEmail('Customer@Example.com');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is case-insensitive and trims whitespace — matches Meta\'s own documented normalization', async () => {
    const a = await hashEmail('Customer@Example.com');
    const b = await hashEmail('  customer@example.com  ');
    const c = await hashEmail('customer@example.com');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('a different email produces a different hash', async () => {
    const a = await hashEmail('one@example.com');
    const b = await hashEmail('two@example.com');
    expect(a).not.toBe(b);
  });

  it('returns null for null, undefined, or an empty/whitespace-only email — never hashes a meaningless value', async () => {
    expect(await hashEmail(null)).toBeNull();
    expect(await hashEmail(undefined)).toBeNull();
    expect(await hashEmail('')).toBeNull();
    expect(await hashEmail('   ')).toBeNull();
  });
});
