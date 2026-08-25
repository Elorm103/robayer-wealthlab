/**
 * Coarse device-type bucketing from a User-Agent header — used only to
 * populate analytics_events.device_type (migration 0045). The raw UA
 * string is never stored; this collapses it to one of five buckets
 * immediately. Pure function, no I/O, mirrors dateRange.ts's own
 * "pure helper extracted because more than one caller needs identical
 * logic" precedent.
 */

export type DeviceType = 'mobile' | 'tablet' | 'desktop' | 'bot' | 'unknown';

const BOT_PATTERN = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegrambot|preview/i;
const TABLET_PATTERN = /ipad|tablet|(android(?!.*mobile))/i;
const MOBILE_PATTERN = /mobile|iphone|ipod|android|blackberry|iemobile|opera mini/i;

export function bucketDeviceType(userAgent: string | null): DeviceType {
  if (!userAgent) return 'unknown';
  if (BOT_PATTERN.test(userAgent)) return 'bot';
  if (TABLET_PATTERN.test(userAgent)) return 'tablet';
  if (MOBILE_PATTERN.test(userAgent)) return 'mobile';
  return 'desktop';
}
