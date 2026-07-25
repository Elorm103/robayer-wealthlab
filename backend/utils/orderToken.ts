/**
 * Generates the random values Milestone M2's ownership layer needs —
 * `licenses.license_key` and `receipt_download_tokens.token`. Direct
 * sibling of `utils/downloadToken.ts` (see that file's own header
 * comment for the full reasoning this mirrors exactly): Web Crypto
 * (`crypto.getRandomValues`), 256 bits of entropy, no Node `crypto`
 * dependency, matching this project's zero-runtime-dependency posture.
 *
 * `license_key` is explicitly never a bearer credential for access
 * (ADR-003) — this generator exists so it is unguessable as a
 * printed/displayed identifier, not because anything is ever
 * authorized by possessing it.
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

export function generateLicenseKey(): string {
  return randomHex();
}

export function generateReceiptDownloadToken(): string {
  return randomHex();
}
