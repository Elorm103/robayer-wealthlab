/**
 * Prompt/response encryption at rest — Version 5.0 Milestone 1.2 (AI
 * Governance & Safety), Task 5. AES-256-GCM via Web Crypto's
 * `crypto.subtle`, the same native-Workers-API, zero-dependency
 * approach already established by utils/passwordHash.ts (PBKDF2) and
 * utils/webhookSignature.ts (HMAC) — not a new cryptography pattern
 * for this codebase.
 *
 * Requires a new Cloudflare Worker secret, `AI_PROMPT_ENCRYPTION_KEY`
 * — a base64-encoded 256-bit (32-byte) AES key, set via
 * `wrangler secret put AI_PROMPT_ENCRYPTION_KEY`. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * If the secret is absent or malformed, `encryptText()` returns
 * `null` rather than throwing — callers (services/ai/aiGateway.ts)
 * treat that as "encrypted storage is unavailable right now" and fall
 * back to not storing the text at all (never to storing it in
 * plaintext as a silent downgrade). See
 * services/ai/aiGatewayConfig.ts's retention config for how that
 * fallback is decided.
 *
 * Stored format: `enc:v1:<base64 iv>:<base64 ciphertext>`. The `enc:v1:`
 * prefix lets `isEncrypted()`/`decryptText()` distinguish a genuinely
 * encrypted value from a legacy plaintext row written before this
 * milestone (Milestone 1/1.1 stored prompt_text/response_text as
 * plain text) — a legacy row is returned as-is, never double-decrypted
 * or corrupted.
 */

import type { Env } from '../../worker/env';

const ENCRYPTED_PREFIX = 'enc:v1:';
const IV_BYTES = 12; // 96-bit IV, the standard/recommended size for AES-GCM

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(env: Env): Promise<CryptoKey | null> {
  if (typeof env.AI_PROMPT_ENCRYPTION_KEY !== 'string' || env.AI_PROMPT_ENCRYPTION_KEY.length === 0) return null;
  let rawKey: Uint8Array;
  try {
    rawKey = base64ToBytes(env.AI_PROMPT_ENCRYPTION_KEY);
  } catch {
    return null; // not valid base64 — treat as unconfigured rather than throw
  }
  if (rawKey.length !== 32) return null; // wrong key length — fail safe, never encrypt with a malformed key

  try {
    return await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch {
    return null;
  }
}

/** Whether AI_PROMPT_ENCRYPTION_KEY is present and well-formed — used by the dashboard to show real "encryption available" status, and by aiGateway.ts to decide whether an 'encrypted_*' retention mode can actually be honored right now. */
export async function isEncryptionAvailable(env: Env): Promise<boolean> {
  return (await importKey(env)) !== null;
}

/** Encrypts `plaintext`. Returns `null` if AI_PROMPT_ENCRYPTION_KEY is absent/malformed — never throws for a missing key, since "encryption unavailable" is an expected, handled state, not an error. */
export async function encryptText(env: Env, plaintext: string): Promise<string | null> {
  const key = await importKey(env);
  if (!key) return null;

  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `${ENCRYPTED_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

/** True if `stored` is a value this module encrypted (carries the `enc:v1:` marker) — false for null, empty, or legacy plaintext. */
export function isEncrypted(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Decrypts a value previously produced by `encryptText()`. A legacy
 * plaintext value (no `enc:v1:` prefix) is returned unchanged — it was
 * never encrypted, so there is nothing to decrypt. Throws only if the
 * value IS marked encrypted but the key is missing or the ciphertext
 * fails to authenticate (tampered/corrupted) — both genuine error
 * conditions the caller (services/admin/aiUsageService.ts's detail
 * endpoint) must surface, not silently swallow.
 */
export async function decryptText(env: Env, stored: string): Promise<string> {
  if (!isEncrypted(stored)) return stored;

  const key = await importKey(env);
  if (!key) throw new Error('Cannot decrypt: AI_PROMPT_ENCRYPTION_KEY is not configured or is malformed.');

  const [ivB64, dataB64] = stored.slice(ENCRYPTED_PREFIX.length).split(':');
  if (!ivB64 || !dataB64) throw new Error('Cannot decrypt: stored value is not in the expected enc:v1:<iv>:<data> format.');

  const iv = base64ToBytes(ivB64);
  const data = base64ToBytes(dataB64);
  const plaintextBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(plaintextBuffer);
}
