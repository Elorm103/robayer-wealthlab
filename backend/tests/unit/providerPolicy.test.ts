/**
 * Unit tests: provider policy engine — Version 5.0 Milestone 1.2 (AI
 * Governance & Safety), Task 3 + Task 4. Pure logic, no DB — the
 * integration point (an unapproved provider being skipped inside
 * callAi()) is covered by tests/unit/aiGateway.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  isValidSensitivityClassification,
  isProviderApprovedForClassification,
  getApprovedProviders,
  SENSITIVITY_CLASSIFICATIONS,
  POLICY_VERSION,
} from '../../services/ai/providerPolicy';

describe('providerPolicy', () => {
  it('recognizes every documented classification as valid', () => {
    for (const c of SENSITIVITY_CLASSIFICATIONS) {
      expect(isValidSensitivityClassification(c)).toBe(true);
    }
  });

  it('rejects unknown, empty, and non-string classifications', () => {
    expect(isValidSensitivityClassification('NOT_REAL')).toBe(false);
    expect(isValidSensitivityClassification('')).toBe(false);
    expect(isValidSensitivityClassification(undefined)).toBe(false);
    expect(isValidSensitivityClassification(null)).toBe(false);
    expect(isValidSensitivityClassification(123)).toBe(false);
    expect(isValidSensitivityClassification('public')).toBe(false); // case-sensitive — lowercase is not one of the six
  });

  it('approves openai for every classification today (the only reviewed provider)', () => {
    for (const c of SENSITIVITY_CLASSIFICATIONS) {
      expect(isProviderApprovedForClassification('openai', c)).toBe(true);
      expect(getApprovedProviders(c)).toContain('openai');
    }
  });

  it('is default-deny: an unlisted provider is never approved for any classification', () => {
    for (const c of SENSITIVITY_CLASSIFICATIONS) {
      expect(isProviderApprovedForClassification('some-future-unreviewed-provider', c)).toBe(false);
    }
  });

  it('exposes a stable, non-empty policy version', () => {
    expect(typeof POLICY_VERSION).toBe('string');
    expect(POLICY_VERSION.length).toBeGreaterThan(0);
  });
});
