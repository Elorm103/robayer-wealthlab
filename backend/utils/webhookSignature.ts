/**
 * Paystack webhook signature verification — Version 1.2 Sprint 2.4
 * (Payment Verification). See docs/payment-verification.md's "Webhook
 * security" and docs/backend-security.md's "Paystack webhook
 * verification" (design, predates this implementation).
 *
 * A pure computation with no D1/network dependency (only async because
 * the Web Crypto API itself is promise-based) — matches
 * backend/utils/README.md's "utilities vs. services" distinction.
 * Uses Web Crypto (`crypto.subtle`), a native Workers API — no Node
 * `crypto` polyfill, matching this project's zero-runtime-dependency
 * posture (`compatibility_flags: []` in wrangler.jsonc).
 */

/**
 * Computes the HMAC-SHA512 of `rawBody` using `secret`, returned as a
 * lowercase hex string — the same format Paystack's own
 * `x-paystack-signature` header uses. Must be called on the **raw**,
 * unparsed request body: parsing it as JSON and re-serializing can
 * change whitespace/key order, which would change the hash and cause
 * every signature check to fail (docs/backend-security.md).
 */
async function computeHmacSha512Hex(rawBody: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  return toHex(new Uint8Array(signatureBuffer));
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Constant-time string comparison — a naive `===` can leak timing
 * information about how many leading characters matched, a known
 * side-channel risk for signature checks (docs/backend-security.md).
 * The length check short-circuits immediately (length isn't secret —
 * both a real and a forged signature are always the same fixed hex
 * length), but every byte of the *content* comparison always runs,
 * regardless of where the first mismatch is.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Verifies a Paystack webhook request. Returns `false` for anything
 * that isn't an exact, valid signature match — a missing header, a
 * malformed header, or a genuine mismatch are all treated identically
 * by the caller (routes/webhooks.ts): reject, log, never process.
 */
export async function verifyPaystackSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!signatureHeader) return false;
  const expected = await computeHmacSha512Hex(rawBody, secret);
  return constantTimeEqual(expected, signatureHeader.toLowerCase());
}
