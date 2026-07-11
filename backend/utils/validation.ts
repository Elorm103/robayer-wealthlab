/**
 * Shared, pure input-validation helpers — no HTTP/D1/network dependency,
 * per backend/utils/README.md's "utilities vs. services" distinction.
 * Used by middleware/validate.ts and directly by services/ for the
 * fields specific to each request shape.
 *
 * Only the checks Version 1.2 Sprint 3's three endpoints (newsletter,
 * contact, consultation) actually need are implemented here.
 * generateReference()/toSubunits()/generateDownloadToken() from
 * backend/utils/README.md's planned list belong to Orders/Payments/
 * Downloads, out of this sprint's explicit scope, and remain
 * unimplemented until the sprint that builds those endpoints.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The same permissive shape check every form component already runs
 * client-side (js/components/*-form.js) — deliberately not stricter.
 * Full deliverability can only be confirmed by actually sending an
 * email, not a regex, so this only rejects obviously-malformed input.
 */
export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_PATTERN.test(value.trim());
}

export function isNonEmptyString(value: unknown, maxLength = 5000): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
