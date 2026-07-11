/**
 * Generates the single-use, short-lived download token
 * `download_tokens.token` (Version 1.2 Sprint 2.5, Digital Fulfilment
 * Platform — see docs/digital-fulfilment.md's "Security" section on
 * why this must never be guessable).
 *
 * A pure computation with no D1/network dependency — matches
 * backend/utils/README.md's "utilities vs. services" distinction, and
 * finally implements that README's long-planned `generateDownloadToken()`
 * entry (originally deferred across Sprints 2.3/2.4 as belonging to
 * Secure Delivery). Uses Web Crypto (`crypto.getRandomValues`), a
 * native Workers API — no Node `crypto` dependency, matching this
 * project's zero-runtime-dependency posture.
 */

/** 256 bits of entropy — far beyond brute-forceable within any token's short TTL, and independent of `formatPurchaseReference()`'s sequential, deliberately-non-secret business reference. */
const TOKEN_BYTES = 32;

export function generateDownloadToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
