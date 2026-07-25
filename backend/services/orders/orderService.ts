/**
 * Order Service - Version 3.0.2 Milestone M2 (Orders, Receipts &
 * Customer Library). See
 * docs/v3.0.2-commerce-architecture-blueprint.md's Deliverable 4 step
 * 6 ("Order artifacts created... never blocking fulfilment, same
 * retryable, logged-not-thrown discipline fulfilmentService.ts
 * already uses") and docs/v3.0.2-m2-database-planning-report.md.
 *
 * The one function that creates `order_items`, `licenses`, and
 * `receipts` rows for a purchase - called from
 * commerceService.handlePaymentWebhook() immediately after customer
 * provisioning, before fulfilPurchase(). Never called from anywhere
 * else, so these three tables' write paths can never drift out of
 * sync with each other.
 *
 * Quantity/seat cardinality (ADR-009, binding): `quantity = N`
 * produces N independent `licenses` rows, each with its own
 * `license_key` - never one shared license with a seat count. Every
 * product in this catalog is single-item today (quantity always 1 in
 * practice), but the loop below is written for the general case, not
 * hardcoded to 1, so a future multi-seat product needs no change here.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { formatReceiptNumber } from '../../utils/receiptNumber';
import { generateLicenseKey } from '../../utils/orderToken';
import { computeTaxBreakdown, sumTaxBreakdown } from './taxService';
import { getOrCreateReceiptPdf, type ReceiptLineItem } from './receiptPdfService';

export interface CreateOrderArtifactsInput {
  purchaseSessionId: number;
  productId: string;
  productTitle: string;
  amountPesewas: number;
  currency: string;
  taxBehavior: string;
  licenseTermsVersion: string | null;
  customerId: number | null;
  /** Always 1 today - no cart/quantity selection UI exists yet. Written as a real parameter, not hardcoded, so a future multi-seat purchase needs no change to this function. */
  quantity?: number;
}

export interface OrderArtifactsResult {
  orderItemId: number;
  licenseIds: number[];
  receiptId: number;
  receiptNumber: string;
}

/**
 * Creates the order/license/receipt records for one verified purchase.
 * Never throws back into the caller - every step is wrapped so a
 * failure here can never undo the payment-verification outcome
 * already recorded by commerceService.ts. Returns `null` on any
 * failure; the caller logs and moves on, exactly like
 * fulfilPurchase()'s own established pattern.
 */
export async function createOrderArtifacts(env: Env, logger: Logger, input: CreateOrderArtifactsInput): Promise<OrderArtifactsResult | null> {
  const quantity = input.quantity ?? 1;

  try {
    const unitPricePesewas = Math.round(input.amountPesewas / quantity);

    const orderItemInsert = await env.DB.prepare(
      `INSERT INTO order_items (purchase_session_id, product_id, product_title, unit_price_pesewas, quantity)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(input.purchaseSessionId, input.productId, input.productTitle, unitPricePesewas, quantity)
      .run();
    const orderItemId = Number(orderItemInsert.meta.last_row_id);

    // ADR-009: quantity independent licenses, each its own key, each
    // its own row - a loop, not a single row with a seat count.
    const licenseIds: number[] = [];
    for (let seat = 0; seat < quantity; seat++) {
      const licenseKey = generateLicenseKey();
      const licenseInsert = await env.DB.prepare(
        `INSERT INTO licenses (purchase_session_id, product_id, customer_id, license_key, terms_version)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(input.purchaseSessionId, input.productId, input.customerId, licenseKey, input.licenseTermsVersion)
        .run();
      licenseIds.push(Number(licenseInsert.meta.last_row_id));
    }

    // M2C MAR closeout fix: lineTotalPesewas is the actual charged
    // amount directly, never unitPricePesewas * quantity recomputed
    // from a rounded per-seat price. createOrderArtifacts() only ever
    // creates one order_items row per call (single-product-per-order
    // today), so this one line item's total must equal the exact
    // amount charged - recomputing it from a Math.round()'d unit price
    // could drift by up to (quantity - 1) pesewas whenever
    // amountPesewas doesn't divide evenly by quantity (e.g. 10000/3).
    // unitPricePesewas itself stays a rounded, informational per-seat
    // display value only (order_items.unit_price_pesewas is not a
    // financial-total field), never the source the line total is
    // derived from.
    const lineItems: ReceiptLineItem[] = [
      {
        title: input.productTitle,
        quantity,
        unitPricePesewas,
        lineTotalPesewas: input.amountPesewas,
      },
    ];
    const subtotalPesewas = input.amountPesewas;
    const taxBreakdown = await computeTaxBreakdown(env, input.amountPesewas, input.taxBehavior);
    const taxPesewas = sumTaxBreakdown(taxBreakdown);
    // Total always equals the actual charged amount - tax is
    // decomposed FROM it (a future inclusive-VAT computation splits
    // the already-charged total into base + tax), never added on top,
    // so a receipt's total can never disagree with what was actually
    // charged. See docs/v3.0.2-m2-risk-assessment.md's "Technical
    // risks" for why this invariant matters.
    const totalPesewas = input.amountPesewas;

    // receipts.receipt_number needs the row's own id, so the row is
    // inserted once with a placeholder-free two-step pattern mirroring
    // purchase_sessions' own reference-generation approach exactly
    // (utils/purchaseReference.ts's header comment): insert first,
    // then UPDATE the formatted number in using the row's own id.
    const receiptInsert = await env.DB.prepare(
      `INSERT INTO receipts (receipt_number, purchase_session_id, customer_id, line_items, subtotal_pesewas, tax_breakdown, tax_pesewas, total_pesewas, tax_behavior, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        null, // NULL, not a placeholder string — a duplicate '' would collide under the UNIQUE constraint on concurrent inserts; NULL never does (see the receipts.receipt_number column's own comment in migration 0019)
        input.purchaseSessionId,
        input.customerId,
        JSON.stringify(lineItems),
        subtotalPesewas,
        JSON.stringify(taxBreakdown),
        taxPesewas,
        totalPesewas,
        input.taxBehavior,
        input.currency
      )
      .run();
    const receiptId = Number(receiptInsert.meta.last_row_id);
    const receiptNumber = formatReceiptNumber(receiptId, new Date());
    await env.DB.prepare(`UPDATE receipts SET receipt_number = ? WHERE id = ?`).bind(receiptNumber, receiptId).run();

    logger.info('order.artifacts_created', {
      purchaseSessionId: input.purchaseSessionId,
      orderItemId,
      licenseCount: licenseIds.length,
      receiptId,
      receiptNumber,
    });

    // PDF generation is best-effort at issuance time - getOrCreateReceiptPdf()
    // is idempotent and self-healing, so a failure here is logged and
    // simply retried on the next download request, never blocking or
    // retrying the order-artifact creation itself.
    await getOrCreateReceiptPdf(env, logger, receiptId);

    return { orderItemId, licenseIds, receiptId, receiptNumber };
  } catch (err) {
    logger.error('order.artifacts_creation_failed', {
      purchaseSessionId: input.purchaseSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
