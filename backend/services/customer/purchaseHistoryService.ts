/**
 * Customer Purchase History Service - Version 3.0.2 Milestone M2
 * (Orders, Receipts & Customer Library). See
 * docs/v3.0.2-m2-api-planning-report.md's "Customer-authenticated"
 * endpoint table and docs/v3.0.2-m2-customer-library-ux-plan.md.
 *
 * Every query here filters by the session's own `customerId`, always
 * server-side, never a client-supplied value - the same ownership
 * discipline `services/customer/*` already established in M1. A
 * purchase/receipt/license belonging to a different customer is
 * indistinguishable, at this layer, from one that doesn't exist -
 * callers (routes/customer/purchases.ts) turn a `null`/empty result
 * into the same `NOT_FOUND`/empty-list response either way, never a
 * distinct "forbidden" signal. See
 * docs/v3.0.2-m2-implementation-roadmap.md's Security Review section.
 */

import type { Env } from '../../worker/env';

export interface CustomerPurchaseSummary {
  purchaseReference: string;
  productTitle: string;
  amountDisplay: string;
  status: 'processing' | 'ready' | 'unavailable' | 'refunded';
  createdAt: string;
  receiptNumber: string | null;
}

export interface ListCustomerPurchasesResult {
  purchases: CustomerPurchaseSummary[];
  total: number;
  page: number;
  limit: number;
}

function formatAmount(amountPesewas: number, currency: string): string {
  const symbol = currency === 'GHS' ? 'GH₵' : `${currency} `;
  return `${symbol}${(amountPesewas / 100).toFixed(2)}`;
}

function toCustomerStatus(internal: string): CustomerPurchaseSummary['status'] {
  if (internal === 'verified') return 'ready';
  if (internal === 'pending') return 'processing';
  if (internal === 'refunded') return 'refunded';
  return 'unavailable';
}

interface PurchaseListRow {
  purchaseReference: string;
  productTitle: string;
  amountPesewas: number;
  currency: string;
  status: string;
  createdAt: string;
  receiptNumber: string | null;
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export async function listCustomerPurchases(env: Env, customerId: number, pageInput: number, limitInput: number): Promise<ListCustomerPurchasesResult> {
  const page = Number.isInteger(pageInput) && pageInput > 0 ? pageInput : 1;
  const limit = Number.isInteger(limitInput) && limitInput > 0 ? Math.min(limitInput, MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = (page - 1) * limit;

  const { results } = await env.DB.prepare(
    `SELECT ps.purchase_reference AS purchaseReference, ps.product_title AS productTitle,
            ps.amount_pesewas AS amountPesewas, ps.currency, ps.status, ps.created_at AS createdAt,
            r.receipt_number AS receiptNumber
     FROM purchase_sessions ps
     LEFT JOIN receipts r ON r.purchase_session_id = ps.id
     WHERE ps.customer_id = ?
     ORDER BY ps.id DESC
     LIMIT ? OFFSET ?`
  )
    .bind(customerId, limit, offset)
    .all<PurchaseListRow>();

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM purchase_sessions WHERE customer_id = ?`).bind(customerId).first<{ n: number }>();

  return {
    purchases: results.map((row) => ({
      purchaseReference: row.purchaseReference,
      productTitle: row.productTitle,
      amountDisplay: formatAmount(row.amountPesewas, row.currency),
      status: toCustomerStatus(row.status),
      createdAt: row.createdAt,
      receiptNumber: row.receiptNumber,
    })),
    total: totalRow?.n ?? 0,
    page,
    limit,
  };
}

/** Returns `null` both when the reference doesn't exist and when it belongs to a different customer - see this file's own header comment on why that distinction is never surfaced. */
export async function getCustomerPurchase(env: Env, customerId: number, reference: string): Promise<CustomerPurchaseSummary | null> {
  const row = await env.DB.prepare(
    `SELECT ps.purchase_reference AS purchaseReference, ps.product_title AS productTitle,
            ps.amount_pesewas AS amountPesewas, ps.currency, ps.status, ps.created_at AS createdAt,
            r.receipt_number AS receiptNumber
     FROM purchase_sessions ps
     LEFT JOIN receipts r ON r.purchase_session_id = ps.id
     WHERE ps.purchase_reference = ? AND ps.customer_id = ?`
  )
    .bind(reference, customerId)
    .first<PurchaseListRow>();

  if (!row) return null;

  return {
    purchaseReference: row.purchaseReference,
    productTitle: row.productTitle,
    amountDisplay: formatAmount(row.amountPesewas, row.currency),
    status: toCustomerStatus(row.status),
    createdAt: row.createdAt,
    receiptNumber: row.receiptNumber,
  };
}

export interface CustomerReceiptSummary {
  receiptNumber: string;
  purchaseReference: string;
  productTitle: string;
  issuedAt: string;
  totalDisplay: string;
}

interface ReceiptListRow {
  receiptNumber: string;
  purchaseReference: string;
  productTitle: string;
  issuedAt: string;
  totalPesewas: number;
  currency: string;
}

export async function listCustomerReceipts(env: Env, customerId: number): Promise<CustomerReceiptSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.receipt_number AS receiptNumber, ps.purchase_reference AS purchaseReference, ps.product_title AS productTitle,
            r.issued_at AS issuedAt, r.total_pesewas AS totalPesewas, r.currency
     FROM receipts r
     JOIN purchase_sessions ps ON ps.id = r.purchase_session_id
     WHERE r.customer_id = ?
     ORDER BY r.id DESC`
  )
    .bind(customerId)
    .all<ReceiptListRow>();

  return results.map((row) => ({
    receiptNumber: row.receiptNumber,
    purchaseReference: row.purchaseReference,
    productTitle: row.productTitle,
    issuedAt: row.issuedAt,
    totalDisplay: formatAmount(row.totalPesewas, row.currency),
  }));
}

/** Returns the receipt's `id` (for PDF generation/streaming) only if it belongs to the given customer - the direct ownership check `routes/customer/purchases.ts`'s download handler relies on. */
export async function findOwnedReceiptId(env: Env, customerId: number, receiptNumber: string): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT id FROM receipts WHERE receipt_number = ? AND customer_id = ?`).bind(receiptNumber, customerId).first<{ id: number }>();
  return row?.id ?? null;
}

export interface CustomerLicenseSummary {
  licenseKey: string;
  productTitle: string;
  licenseType: string;
  issuedAt: string;
  status: 'active' | 'revoked';
}

interface LicenseListRow {
  licenseKey: string;
  productTitle: string | null;
  licenseType: string;
  issuedAt: string;
  revokedAt: string | null;
}

export async function listCustomerLicenses(env: Env, customerId: number): Promise<CustomerLicenseSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT l.license_key AS licenseKey, ps.product_title AS productTitle, l.license_type AS licenseType,
            l.issued_at AS issuedAt, l.revoked_at AS revokedAt
     FROM licenses l
     JOIN purchase_sessions ps ON ps.id = l.purchase_session_id
     WHERE l.customer_id = ?
     ORDER BY l.id DESC`
  )
    .bind(customerId)
    .all<LicenseListRow>();

  return results.map((row) => ({
    licenseKey: row.licenseKey,
    productTitle: row.productTitle ?? 'Unknown product',
    licenseType: row.licenseType,
    issuedAt: row.issuedAt,
    status: row.revokedAt ? 'revoked' : 'active',
  }));
}
