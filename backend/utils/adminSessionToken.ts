/**
 * Generates the two random secrets an admin session needs —
 * `admin_sessions.token` (the session identifier, carried in the
 * HttpOnly session cookie) and `admin_sessions.csrf_secret` (carried in
 * a separate, readable cookie, backing the double-submit CSRF pattern —
 * see docs/v2-authentication-design.md's "CSRF").
 *
 * Same shape/pattern as `generateDownloadToken()`/`generateUnsubscribeToken()`
 * deliberately mirrored, per docs/v2-authentication-design.md's login
 * flow step 5a: Web Crypto (`crypto.getRandomValues`), no Node `crypto`
 * dependency, no new package.
 */

/** 256 bits of entropy — same as every other token in this codebase. */
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

export function generateSessionToken(): string {
  return randomHex();
}

export function generateCsrfSecret(): string {
  return randomHex();
}
