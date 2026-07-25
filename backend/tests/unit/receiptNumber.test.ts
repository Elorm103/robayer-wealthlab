/**
 * Unit tests: receipt numbering - Version 3.0.2 Milestone M2.
 * formatReceiptNumber() is a direct sibling of
 * utils/purchaseReference.ts's formatPurchaseReference() - same
 * shape of test coverage.
 */
import { describe, it, expect } from 'vitest';
import { formatReceiptNumber } from '../../utils/receiptNumber';

describe('formatReceiptNumber', () => {
  it('formats with the RWL-RCT prefix, the UTC year, and a zero-padded 6-digit sequence', () => {
    expect(formatReceiptNumber(1, new Date('2026-01-15T00:00:00Z'))).toBe('RWL-RCT-2026-000001');
  });

  it('does not zero-pad beyond 6 digits for a large id', () => {
    expect(formatReceiptNumber(1234567, new Date('2026-01-15T00:00:00Z'))).toBe('RWL-RCT-2026-1234567');
  });

  it('uses the UTC year, not local time, matching formatPurchaseReference()', () => {
    // 2025-12-31T23:30:00Z is still 2025 in UTC regardless of the host's local timezone.
    expect(formatReceiptNumber(5, new Date('2025-12-31T23:30:00Z'))).toBe('RWL-RCT-2025-000005');
  });
});
