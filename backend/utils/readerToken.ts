/**
 * Reader session token generation and hashing - Secure Digital
 * Library. Mirrors downloadToken.ts's own 256-bit Web Crypto
 * generation exactly (same entropy, same hex encoding, no Node
 * `crypto` dependency), plus a SHA-256 hash step: unlike
 * download_tokens.token (stored and matched as the literal string),
 * reader_sessions.session_token_hash never stores the raw token, per
 * the explicit "hash it where practical" requirement - the real token
 * is returned to the customer exactly once, at mint time, and never
 * persisted anywhere in that form again.
 */

const TOKEN_BYTES = 32;

export function generateReaderSessionToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** SHA-256 via Web Crypto (`crypto.subtle`), a native Workers API - no external hashing dependency. Deterministic: the same token always hashes to the same value, so a lookup by hash works exactly like a lookup by the raw token would, without ever storing the raw value. */
export async function hashReaderSessionToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
