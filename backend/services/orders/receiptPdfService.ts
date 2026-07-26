/**
 * Receipt PDF Service - Version 3.0.2 Milestone M2 (Orders, Receipts
 * & Customer Library). See
 * docs/v3.0.2-m2-receipt-architecture-plan.md's "Receipt rendering"
 * section for the full reasoning this implements.
 *
 * Generates a receipt PDF directly in the Worker using `pdf-lib`'s
 * low-level, pure-JavaScript API - confirmed by a same-day spike
 * (Sprint M2B) to run cleanly inside the real workerd runtime, unlike
 * `puppeteer-core` (used elsewhere in this codebase only in local,
 * Node.js, build-time scripts - it needs a real browser binary this
 * Worker does not have). No HTML-to-PDF conversion, no headless
 * browser, no Cloudflare Browser Rendering binding required.
 *
 * Generated once, stored in R2 (`receipts/{receiptNumber}.pdf`), never
 * regenerated on every download - the same generate-once-serve-many
 * discipline this codebase already uses for every other digital
 * asset. `getOrCreateReceiptPdf()` is idempotent and self-healing: if
 * generation failed at issuance time (network hiccup, transient
 * error), the very next download request regenerates it from the
 * receipt's own already-persisted data, with no separate retry job or
 * scheduled infrastructure needed - consistent with this project's
 * existing "no new Cron Trigger without a specific, narrow, named
 * reason" posture (see the ratified Blueprint's Operational
 * Architecture section).
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { TaxBreakdownEntry } from './taxService';

export interface ReceiptLineItem {
  title: string;
  quantity: number;
  unitPricePesewas: number;
  lineTotalPesewas: number;
}

export interface ReceiptPdfInput {
  receiptNumber: string;
  issuedAt: string;
  purchaseReference: string;
  customerEmail: string | null;
  lineItems: ReceiptLineItem[];
  subtotalPesewas: number;
  /** Version 3.2 Milestone M4 (Commerce & Trust Foundations) - the coupon discount applied, 0 if none. */
  discountPesewas: number;
  taxBreakdown: TaxBreakdownEntry[];
  taxPesewas: number;
  totalPesewas: number;
  currency: string;
}

function formatMoney(pesewas: number, currency: string): string {
  return `${currency} ${(pesewas / 100).toFixed(2)}`;
}

/** Pure function: builds the PDF bytes from already-known receipt data. No D1/R2 access - kept separate from storage so it is trivially unit-testable. */
export async function renderReceiptPdf(input: ReceiptPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 594]); // A5-ish, appropriately small for a one-page receipt
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const black = rgb(0.05, 0.05, 0.08);
  const muted = rgb(0.4, 0.4, 0.45);
  let y = 550;
  const left = 32;

  const drawLine = (text: string, options: { size?: number; useBold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    page.drawText(text, { x: left, y, size: options.size ?? 10, font: options.useBold ? bold : font, color: options.color ?? black });
    y -= (options.size ?? 10) + 8;
  };

  drawLine('Robayer WealthLab', { size: 16, useBold: true });
  drawLine('Receipt', { size: 12, color: muted });
  y -= 6;

  drawLine(`Receipt number: ${input.receiptNumber}`);
  drawLine(`Purchase reference: ${input.purchaseReference}`);
  drawLine(`Issued: ${input.issuedAt}`);
  if (input.customerEmail) drawLine(`Billed to: ${input.customerEmail}`);
  y -= 10;

  drawLine('Item', { useBold: true });
  for (const item of input.lineItems) {
    drawLine(`${item.title} x${item.quantity}  ${formatMoney(item.lineTotalPesewas, input.currency)}`);
  }
  y -= 4;

  drawLine(`Subtotal: ${formatMoney(input.subtotalPesewas, input.currency)}`);
  // Version 3.2 Milestone M4 - only drawn when a coupon was actually
  // applied, to avoid a redundant "discount: 0.00" line on every
  // ordinary receipt.
  if (input.discountPesewas > 0) {
    drawLine(`Discount: -${formatMoney(input.discountPesewas, input.currency)}`);
  }
  if (input.taxBreakdown.length === 0) {
    drawLine('Tax: not applicable', { color: muted });
  } else {
    for (const entry of input.taxBreakdown) {
      drawLine(`${entry.label} (${entry.ratePercent}%): ${formatMoney(entry.amountPesewas, input.currency)}`);
    }
  }
  y -= 4;
  drawLine(`Total: ${formatMoney(input.totalPesewas, input.currency)}`, { size: 12, useBold: true });

  y -= 20;
  drawLine('Thank you for your purchase.', { size: 9, color: muted });
  drawLine('Robayer WealthLab provides financial education, not licensed financial advice.', { size: 8, color: muted });

  return doc.save();
}

function storageKeyFor(receiptNumber: string): string {
  return `receipts/${receiptNumber}.pdf`;
}

/**
 * Idempotent: if `receipts.pdf_storage_key` is already set, returns it
 * unchanged without touching R2 again. Otherwise generates the PDF
 * from the receipt's own persisted, immutable data, stores it, records
 * the key, and returns it. Never throws - a generation failure is
 * logged and returns `null`, leaving the receipt row exactly as it
 * was for the next attempt (self-healing, no state to clean up).
 */
export async function getOrCreateReceiptPdf(env: Env, logger: Logger, receiptId: number): Promise<string | null> {
  const receipt = await env.DB.prepare(
    `SELECT receipt_number AS receiptNumber, pdf_storage_key AS pdfStorageKey, issued_at AS issuedAt,
            purchase_session_id AS purchaseSessionId, line_items AS lineItems, subtotal_pesewas AS subtotalPesewas,
            discount_pesewas AS discountPesewas, tax_breakdown AS taxBreakdown, tax_pesewas AS taxPesewas,
            total_pesewas AS totalPesewas, currency
     FROM receipts WHERE id = ?`
  )
    .bind(receiptId)
    .first<{
      receiptNumber: string;
      pdfStorageKey: string | null;
      issuedAt: string;
      purchaseSessionId: number;
      lineItems: string;
      subtotalPesewas: number;
      discountPesewas: number;
      taxBreakdown: string;
      taxPesewas: number;
      totalPesewas: number;
      currency: string;
    }>();

  if (!receipt) return null;
  if (receipt.pdfStorageKey) return receipt.pdfStorageKey;

  try {
    const purchaseRow = await env.DB.prepare(`SELECT purchase_reference AS purchaseReference, customer_email AS customerEmail FROM purchase_sessions WHERE id = ?`)
      .bind(receipt.purchaseSessionId)
      .first<{ purchaseReference: string; customerEmail: string | null }>();

    const bytes = await renderReceiptPdf({
      receiptNumber: receipt.receiptNumber,
      issuedAt: receipt.issuedAt,
      purchaseReference: purchaseRow?.purchaseReference ?? receipt.receiptNumber,
      customerEmail: purchaseRow?.customerEmail ?? null,
      lineItems: JSON.parse(receipt.lineItems) as ReceiptLineItem[],
      subtotalPesewas: receipt.subtotalPesewas,
      discountPesewas: receipt.discountPesewas,
      taxBreakdown: JSON.parse(receipt.taxBreakdown) as TaxBreakdownEntry[],
      taxPesewas: receipt.taxPesewas,
      totalPesewas: receipt.totalPesewas,
      currency: receipt.currency,
    });

    const storageKey = storageKeyFor(receipt.receiptNumber);
    await env.STORAGE.put(storageKey, bytes, { httpMetadata: { contentType: 'application/pdf' } });
    await env.DB.prepare(`UPDATE receipts SET pdf_storage_key = ? WHERE id = ?`).bind(storageKey, receiptId).run();

    logger.info('receipt.pdf_generated', { receiptId, receiptNumber: receipt.receiptNumber });
    return storageKey;
  } catch (err) {
    logger.error('receipt.pdf_generation_failed', {
      receiptId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
