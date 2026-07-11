/**
 * Generates the single-use unsubscribe token `unsubscribe_tokens.token`
 * (docs/newsletter-unsubscribe-design.md's "Security" section).
 *
 * A pure computation with no D1/network dependency — same pattern as
 * `generateDownloadToken()`, which this deliberately mirrors: Web
 * Crypto (`crypto.getRandomValues`), no Node `crypto` dependency.
 */

/** 256 bits of entropy — same as generateDownloadToken(); a randomly-guessed token is not a realistic attack vector regardless of this token's (much longer) expiry window. */
const TOKEN_BYTES = 32;

export function generateUnsubscribeToken(): string {
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
