import { describe, it, expect } from 'vitest';
import { clampToTrackingStart, ANALYTICS_TRACKING_START_DATE } from '../../utils/analyticsConfig';

describe('clampToTrackingStart', () => {
  it('leaves a range entirely after the tracking start date untouched', () => {
    const range = { from: '2026-09-01', to: '2026-09-30' };
    const result = clampToTrackingStart(range);
    expect(result.range).toEqual(range);
    expect(result.clamped).toBe(false);
  });

  it('clamps from forward to the tracking start date when the range starts earlier', () => {
    const result = clampToTrackingStart({ from: '2026-01-01', to: '2026-09-30' });
    expect(result.range.from).toBe(ANALYTICS_TRACKING_START_DATE);
    expect(result.range.to).toBe('2026-09-30');
    expect(result.clamped).toBe(true);
  });

  it('produces an inverted (from > to) range when the whole requested range predates tracking start, which a caller\'s exclusive-upper-bound query naturally resolves to zero rows', () => {
    const result = clampToTrackingStart({ from: '2026-01-01', to: '2026-02-01' });
    expect(result.range.from > result.range.to).toBe(true);
    expect(result.clamped).toBe(true);
  });
});
