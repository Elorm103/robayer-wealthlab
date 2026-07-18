/**
 * Pure date-range helpers for filtering/comparing against D1's TEXT
 * datetime columns (SQLite's `datetime('now')` format, 'YYYY-MM-DD
 * HH:MM:SS', no 'T', UTC implied — matching every other timestamp
 * column in this schema).
 *
 * `services/admin/orderService.ts`'s `dateTo` filter and
 * `services/admin/analyticsService.ts`'s period comparison both need
 * the same correct date-range math — found as a real bug in Orders
 * (Phase 3 Stage 3) and fixed here rather than duplicated a second
 * time with the same mistake.
 */

/**
 * A bare `YYYY-MM-DD` upper bound compared with `<=` against a
 * datetime column silently excludes almost every row from that day —
 * `'2026-07-18 08:36:45' <= '2026-07-18'` is `false` under SQLite's
 * plain byte/lexicographic TEXT comparison, since the longer string
 * (with a time component) sorts after the bare-date prefix. The correct
 * pattern is an **exclusive** upper bound: `created_at < exclusiveEndDate(dateTo)`.
 */
export function exclusiveEndDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Whole calendar days spanned by [from, to], inclusive of both ends — a same-day range is 1 day, not 0. */
export function daysBetweenInclusive(from: string, to: string): number {
  const fromMs = new Date(`${from}T00:00:00.000Z`).getTime();
  const toMs = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((toMs - fromMs) / 86_400_000) + 1;
}

/** Subtracts `days` calendar days from a `YYYY-MM-DD` string. */
function subtractDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface PeriodRange {
  from: string;
  to: string;
}

/**
 * The immediately-preceding period of equal length — e.g. current
 * = last 30 days, previous = the 30 days before that, no gap and no
 * overlap. Used for every Analytics KPI's period-over-period
 * `deltaPercent`.
 */
export function previousPeriod(current: PeriodRange): PeriodRange {
  const days = daysBetweenInclusive(current.from, current.to);
  const to = subtractDays(current.from, 1);
  const from = subtractDays(to, days - 1);
  return { from, to };
}

/** `null` when `previous` is 0 — a percentage change from zero is undefined, not infinite or zero, so the frontend must render "New" rather than a fake number. */
export function deltaPercent(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Every `YYYY-MM-DD` date in [from, to], inclusive — used to zero-fill a timeseries so a chart never silently skips a day with no rows. */
export function everyDateInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}
