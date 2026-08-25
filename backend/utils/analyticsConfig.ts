/**
 * The first date first-party visitor/session/traffic tracking
 * (analytics_events-derived metrics: unique visitors, sessions,
 * product views, device/country breakdowns) has any real data.
 * Historical revenue/order/customer figures (sourced from
 * purchase_sessions/customers, which predate this) are NOT subject to
 * this cutoff — only analytics_events-derived numbers are clamped to
 * it, so a query never implies visitor data exists before tracking
 * actually started. See backend/services/admin/analyticsService.ts's
 * getGrowthSummary()/getDeviceBreakdown()/getCountryBreakdown() and
 * the admin dashboard's "tracking began" notice.
 */
export const ANALYTICS_TRACKING_START_DATE = '2026-08-25';

/**
 * Clamps a requested range's `from` forward to the tracking start
 * date — never earlier. If the whole requested range predates
 * tracking start, the clamped `from` ends up after `to`; every caller
 * here queries with an exclusive upper bound (`created_at >= from AND
 * created_at < exclusiveEndDate(to)`), so an inverted range naturally
 * and correctly yields zero rows with no special-casing needed.
 * `clamped` tells the UI whether to show the "tracking began" notice.
 */
export function clampToTrackingStart<T extends { from: string; to: string }>(range: T): { range: T; clamped: boolean } {
  if (range.from >= ANALYTICS_TRACKING_START_DATE) {
    return { range, clamped: false };
  }
  return { range: { ...range, from: ANALYTICS_TRACKING_START_DATE }, clamped: true };
}
