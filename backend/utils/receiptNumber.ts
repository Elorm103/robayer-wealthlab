/**
 * Formats a receipt number — the customer-facing identifier for a
 * receipt, generated once at issuance. Direct sibling of
 * `utils/purchaseReference.ts`, not a generalization of it — see that
 * file's own header comment for the full reasoning this mirrors
 * exactly: the sequence is the `receipts` row's own D1 AUTOINCREMENT
 * id (not a separate per-year counter reset to 1 every January),
 * which is free, already-atomic, and still strictly increasing.
 *
 * Format: RWL-RCT-{year}-{6-digit sequence}, e.g. "RWL-RCT-2026-000001".
 */

const REFERENCE_PREFIX = 'RWL';
const RECEIPT_INFIX = 'RCT';
const SEQUENCE_DIGITS = 6;

export function formatReceiptNumber(id: number, issuedAt: Date): string {
  const year = issuedAt.getUTCFullYear();
  const sequence = String(id).padStart(SEQUENCE_DIGITS, '0');
  return `${REFERENCE_PREFIX}-${RECEIPT_INFIX}-${year}-${sequence}`;
}
