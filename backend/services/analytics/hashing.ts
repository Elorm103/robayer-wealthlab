/**
 * Meta Conversions API PII hashing — Version 5.0 (Customer
 * Acquisition Phase 1, Phase 9 Privacy). Meta requires every
 * `user_data` identifier (email, phone) sent to CAPI to be SHA-256
 * hashed, lowercased and trimmed first — see Meta's own Conversions
 * API documentation. Uses Web Crypto (`crypto.subtle`), the exact
 * same native API `backend/utils/mediaValidation.ts`'s `hashBytes()`
 * and `backend/utils/passwordHash.ts` already rely on — no new
 * dependency, no third-party hashing library.
 */

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Meta's documented normalization for an email identifier: lowercase, trimmed, then SHA-256 hex. Returns null for an absent/empty email — never hashes an empty string, which would produce a real but meaningless hash Meta could still attempt to match against. */
export async function hashEmail(email: string | null | undefined): Promise<string | null> {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  return sha256Hex(normalized);
}

/**
 * Meta's `external_id` field only recommends hashing (unlike em/ph,
 * which require it) — hashed anyway here, matching this project's own
 * existing privacy discipline of never sending a raw internal
 * identifier to a third party when a hash serves the same matching
 * purpose. Takes this project's own numeric `customers.id`, never a
 * client-supplied value, so a stable hash always refers to the same
 * real, already-provisioned customer.
 */
export async function hashExternalId(customerId: number | null | undefined): Promise<string | null> {
  if (customerId === null || customerId === undefined) return null;
  return sha256Hex(String(customerId));
}
