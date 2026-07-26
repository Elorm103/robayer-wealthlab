/**
 * Generates the random secrets customer authentication needs —
 * `customer_sessions.token`, `customer_sessions.csrf_secret`, and
 * `customer_password_tokens.token` (shared by both the initial
 * password-setup flow and any later password reset — see migration
 * 0018_customer_identity.sql).
 *
 * Deliberately identical shape/pattern to
 * `utils/adminSessionToken.ts` — Web Crypto (`crypto.getRandomValues`),
 * 256 bits of entropy, no Node `crypto` dependency, no new package. Per
 * docs/v3.0.2-architecture-decision-register.md's governing philosophy
 * ("every security mechanism a customer-facing feature needs, this
 * codebase has already built once, correctly, for admin auth"), this
 * is the same proven generator reused, not a new one.
 */

const TOKEN_BYTES = 32;

function randomHex(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function generateCustomerSessionToken(): string {
  return randomHex();
}

export function generateCustomerCsrfSecret(): string {
  return randomHex();
}

export function generateCustomerPasswordToken(): string {
  return randomHex();
}

/** Version 3.3 Milestone M5C — the review-reminder opt-out link's token (customer_profiles.review_reminder_opt_out_token). Same generator, same entropy; see services/customer/reviewReminderService.ts for why this one is long-lived rather than single-use/expiring. */
export function generateReviewReminderOptOutToken(): string {
  return randomHex();
}
