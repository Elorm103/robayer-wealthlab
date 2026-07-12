/**
 * Admin password hashing — Version 2.0 Phase 0.1 (Authentication
 * Foundation). See docs/v2-authentication-design.md's "Password
 * hashing": PBKDF2-SHA256 via Web Crypto's `crypto.subtle`, not
 * bcrypt/argon2 — neither is a native Workers API without a WASM
 * dependency this project has no other reason to add. Matches the
 * zero-runtime-dependency posture already established by
 * `utils/downloadToken.ts`/`utils/unsubscribeToken.ts`.
 *
 * Stored as `salt:iterations:hash` (all hex) in `admin_users.password_hash`
 * — no schema change needed, and `iterations` travels with the hash so a
 * future increase to the constant below never invalidates existing
 * password hashes; verification always uses the iteration count actually
 * stored, not the current constant.
 */

/** ≥600,000 per current OWASP guidance for PBKDF2-SHA256 (docs/v2-authentication-design.md). */
const PBKDF2_ITERATIONS = 600_000;
/** 128 bits — standard, generous salt length; independent of the 256-bit token entropy used elsewhere in this codebase. */
const SALT_BYTES = 16;
/** 256-bit derived key, matching PBKDF2-SHA256's natural output size. */
const KEY_LENGTH_BITS = 256;

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function deriveHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH_BITS
  );
  return new Uint8Array(derived);
}

/** Hashes a new admin password. Result is ready to store directly in `admin_users.password_hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await deriveHash(password, salt, PBKDF2_ITERATIONS);
  return `${toHex(salt)}:${PBKDF2_ITERATIONS}:${toHex(hash)}`;
}

/**
 * Verifies a login attempt's password against a stored `salt:iterations:hash`
 * value. Always re-derives using the iterations recorded in the stored
 * value (not the current constant), so a future iteration-count bump
 * never breaks existing users. Constant-time comparison on the derived
 * bytes — never a `===` string compare, which would leak timing
 * information about how many leading bytes matched.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const [saltHex, iterationsStr, hashHex] = parts;
  const iterations = parseInt(iterationsStr, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromHex(saltHex);
    expected = fromHex(hashHex);
  } catch {
    return false;
  }

  const actual = await deriveHash(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
