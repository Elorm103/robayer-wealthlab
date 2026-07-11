/**
 * Formats this project's internal purchase reference — the primary
 * business identifier for a purchase attempt, generated before any
 * payment provider is contacted. See docs/commerce-foundation.md's
 * "Internal purchase reference" section.
 *
 * Format: RWL-{year}-{6-digit sequence}, e.g. "RWL-2026-000001".
 *
 * This supersedes `backend/utils/README.md`'s originally-planned
 * `generateReference()` shape (`RWL-{slug}-{timestamp}-{random}`,
 * from docs/paystack-integration.md, written before this table
 * existed). The new shape was chosen because:
 *   - It's shorter and reads as a genuine sequential business ID
 *     (like an invoice number), not a debug string.
 *   - It doesn't embed the product slug, so it stays valid even if a
 *     product is renamed/re-slugged after purchase.
 *   - It's still human-legible and searchable in a support context.
 *
 * The sequence number is the purchase_sessions row's own D1
 * AUTOINCREMENT id — not a separate per-year counter reset to 1 every
 * January. That would need its own atomic counter table/transaction
 * to avoid a race between concurrent inserts; reusing the row's own
 * id is free, already-atomic (SQLite guarantees AUTOINCREMENT
 * uniqueness), and still strictly increasing — the year prefix is
 * purely a human-readable grouping, not a per-year reset. Documented
 * explicitly so a future reader doesn't assume "000001" means "the
 * first purchase of that year."
 */

const REFERENCE_PREFIX = 'RWL';
const SEQUENCE_DIGITS = 6;

export function formatPurchaseReference(id: number, createdAt: Date): string {
  const year = createdAt.getUTCFullYear();
  const sequence = String(id).padStart(SEQUENCE_DIGITS, '0');
  return `${REFERENCE_PREFIX}-${year}-${sequence}`;
}
