/**
 * Unit tests: utils/paystackEnvironment.ts — the forensic-audit fix
 * (2026-08-28) that classifies new purchase_sessions/customers by the
 * configured Paystack key mode instead of leaving them at migration
 * 0028's 'UNKNOWN' default forever. See
 * database/migrations/0047_data_classification_backfill_v2.sql's
 * header comment for the incident this closes.
 */
import { describe, it, expect } from 'vitest';
import { classifyPaystackEnvironment, paystackKeyToDataClassification } from '../../utils/paystackEnvironment';

describe('classifyPaystackEnvironment', () => {
  it('recognizes a live secret key', () => {
    expect(classifyPaystackEnvironment('sk_live_abc123')).toBe('live');
  });

  it('recognizes a test secret key', () => {
    expect(classifyPaystackEnvironment('sk_test_abc123')).toBe('test');
  });

  it('returns unknown for anything else, including an empty string', () => {
    expect(classifyPaystackEnvironment('')).toBe('unknown');
    expect(classifyPaystackEnvironment('not-a-paystack-key')).toBe('unknown');
  });
});

describe('paystackKeyToDataClassification', () => {
  it('maps a live key to PRODUCTION', () => {
    expect(paystackKeyToDataClassification('sk_live_abc123')).toBe('PRODUCTION');
  });

  it('maps a test key to DEVELOPMENT', () => {
    expect(paystackKeyToDataClassification('sk_test_abc123')).toBe('DEVELOPMENT');
  });

  it('maps an unrecognized key format to UNKNOWN, never guessing PRODUCTION', () => {
    expect(paystackKeyToDataClassification('not-a-paystack-key')).toBe('UNKNOWN');
  });

  it('maps a missing/undefined key to UNKNOWN, never guessing PRODUCTION', () => {
    expect(paystackKeyToDataClassification(undefined)).toBe('UNKNOWN');
  });

  it('never returns INTERNAL — that distinction requires human judgment about who the customer is, not the key mode (see migration 0029/0047)', () => {
    expect(paystackKeyToDataClassification('sk_live_abc123')).not.toBe('INTERNAL');
    expect(paystackKeyToDataClassification('sk_test_abc123')).not.toBe('INTERNAL');
  });
});
