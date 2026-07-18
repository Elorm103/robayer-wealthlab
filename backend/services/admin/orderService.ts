/**
 * Orders — Version 2.0 Phase 3 (Operational Visibility). See
 * docs/v2.0-phase3-architecture-plan.md's "Orders" section.
 *
 * Read-only over `purchase_sessions`/`payment_transactions`/`deliveries`/
 * `email_log` — this file never writes to any of those tables except via
 * the two resend actions, which don't write to them directly either
 * (they call the existing `emailService.sendEmail()`, which owns its own
 * `email_log` insert, same as every other trigger of that function).
 * `purchase_sessions` itself remains owned by `services/commerceService.ts`
 * (checkout) and `services/fulfilmentService.ts` (verification/fulfilment)
 * — unchanged by this phase.
 *
 * This is also the first Phase 3 module where a real, external,
 * customer-facing consequence exists (an unwanted email) — see the two
 * resend functions' `status === 'verified'` guard.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { sendEmail } from '../emailService';
import * as auditService from './auditService';

export const ORDER_STATUSES = ['pending', 'verified', 'failed', 'expired', 'cancelled', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function isValidOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

/**
 * Flags the known synthetic QA email pattern used throughout this
 * engagement's own test purchases (`checkout+rwl-...@robayerwealthlab.com`
 * — see docs/v1.1-ceo-dashboard.md and docs/analytics-implementation-plan.md's
 * "Mistaking test-mode commerce activity for real traffic" finding) so an
 * admin viewing Orders never mistakes QA activity for a real sale.
 */
const SYNTHETIC_TEST_EMAIL_PATTERN = /^checkout\+rwl-[^@]+@robayerwealthlab\.com$/i;

export function isSyntheticTestEmail(email: string | null): boolean {
  return !!email && SYNTHETIC_TEST_EMAIL_PATTERN.test(email);
}

function formatAmount(amountPesewas: number, currency: string): string {
  const symbol = currency === 'GHS' ? 'GH₵' : `${currency} `;
  const display = (amountPesewas / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${symbol}${display}`;
}

/** Escapes SQLite LIKE metacharacters — see consultationService.ts's own copy of this helper for the full reasoning. */
function likePattern(search: string): string {
  return `%${search.replace(/[%_\\]/g, '\\$&')}%`;
}

export interface OrderListItem {
  id: number;
  purchaseReference: string | null;
  productSlug: string;
  productTitle: string;
  customerEmail: string | null;
  amountPesewas: number;
  currency: string;
  status: OrderStatus;
  isSyntheticTest: boolean;
  createdAt: string;
}

export interface ListOrdersQuery {
  search: string | null;
  status: string | null;
  productSlug: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  page: number;
  pageSize: number;
}

export interface ListOrdersResult {
  items: OrderListItem[];
  total: number;
  page: number;
  pageSize: number;
}

const LIST_SELECT = `
  SELECT id, purchase_reference, product_slug, product_title, customer_email, amount_pesewas, currency, status, created_at
  FROM purchase_sessions
`;

interface ListRow {
  id: number;
  purchase_reference: string | null;
  product_slug: string;
  product_title: string;
  customer_email: string | null;
  amount_pesewas: number;
  currency: string;
  status: string;
  created_at: string;
}

export async function listOrders(env: Env, query: ListOrdersQuery): Promise<ListOrdersResult> {
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (query.status) {
    conditions.push('status = ?');
    bindings.push(query.status);
  }
  if (query.productSlug) {
    conditions.push('product_slug = ?');
    bindings.push(query.productSlug);
  }
  if (query.dateFrom) {
    conditions.push('created_at >= ?');
    bindings.push(query.dateFrom);
  }
  if (query.dateTo) {
    conditions.push('created_at <= ?');
    bindings.push(query.dateTo);
  }
  if (query.search) {
    conditions.push("(purchase_reference LIKE ? ESCAPE '\\' OR customer_email LIKE ? ESCAPE '\\')");
    const pattern = likePattern(query.search);
    bindings.push(pattern, pattern);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (query.page - 1) * query.pageSize;

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(`${LIST_SELECT} ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, query.pageSize, offset)
      .all<ListRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM purchase_sessions ${whereClause}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);

  return {
    items: rows.results.map((r) => ({
      id: r.id,
      purchaseReference: r.purchase_reference,
      productSlug: r.product_slug,
      productTitle: r.product_title,
      customerEmail: r.customer_email,
      amountPesewas: r.amount_pesewas,
      currency: r.currency,
      status: r.status as OrderStatus,
      isSyntheticTest: isSyntheticTestEmail(r.customer_email),
      createdAt: r.created_at,
    })),
    total: countRow?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export interface OrderPaymentTransaction {
  id: number;
  paystackReference: string;
  eventType: string;
  amountPesewas: number;
  currency: string;
  status: string;
  gatewayResponse: string | null;
  verifiedAt: string | null;
  webhookReceivedAt: string | null;
  createdAt: string;
}

export interface OrderDelivery {
  id: number;
  assetId: string;
  maxDownloads: number | null;
  accessExpiresAt: string | null;
  downloadsUsed: number;
  lastDownloadAt: string | null;
  status: string;
  deliveredAt: string | null;
}

export interface OrderEmailLogEntry {
  id: number;
  template: string;
  recipient: string;
  status: string;
  sentAt: string | null;
  createdAt: string;
}

export interface OrderDetail extends OrderListItem {
  productId: string;
  productVersion: string | null;
  provider: string;
  providerReference: string | null;
  providerStatus: string | null;
  verifiedAt: string | null;
  expiresAt: string;
  updatedAt: string;
  transactions: OrderPaymentTransaction[];
  deliveries: OrderDelivery[];
  emails: OrderEmailLogEntry[];
}

interface DetailRow extends ListRow {
  product_id: string;
  product_version: string | null;
  provider: string;
  provider_reference: string | null;
  provider_status: string | null;
  verified_at: string | null;
  expires_at: string;
  updated_at: string;
}

export async function getOrderByReference(env: Env, reference: string): Promise<OrderDetail | null> {
  const row = await env.DB.prepare(
    `SELECT id, purchase_reference, product_slug, product_id, product_version, product_title,
            amount_pesewas, currency, status, provider, provider_reference, provider_status,
            customer_email, verified_at, expires_at, created_at, updated_at
     FROM purchase_sessions WHERE purchase_reference = ?`
  )
    .bind(reference)
    .first<DetailRow>();

  if (!row) return null;

  const [txRows, deliveryRows, emailRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, paystack_reference, event_type, amount_pesewas, currency, status, gateway_response, verified_at, webhook_received_at, created_at
       FROM payment_transactions WHERE purchase_session_id = ? ORDER BY created_at ASC`
    )
      .bind(row.id)
      .all<{
        id: number;
        paystack_reference: string;
        event_type: string;
        amount_pesewas: number;
        currency: string;
        status: string;
        gateway_response: string | null;
        verified_at: string | null;
        webhook_received_at: string | null;
        created_at: string;
      }>(),
    env.DB.prepare(
      `SELECT id, asset_id, max_downloads, access_expires_at, downloads_used, last_download_at, status, delivered_at
       FROM deliveries WHERE purchase_session_id = ? ORDER BY id ASC`
    )
      .bind(row.id)
      .all<{
        id: number;
        asset_id: string;
        max_downloads: number | null;
        access_expires_at: string | null;
        downloads_used: number;
        last_download_at: string | null;
        status: string;
        delivered_at: string | null;
      }>(),
    env.DB.prepare(
      `SELECT id, template, recipient, status, sent_at, created_at
       FROM email_log WHERE entity_type = 'purchase_session' AND entity_id = ? ORDER BY created_at ASC`
    )
      .bind(row.id)
      .all<{ id: number; template: string; recipient: string; status: string; sent_at: string | null; created_at: string }>(),
  ]);

  return {
    id: row.id,
    purchaseReference: row.purchase_reference,
    productSlug: row.product_slug,
    productId: row.product_id,
    productVersion: row.product_version,
    productTitle: row.product_title,
    customerEmail: row.customer_email,
    amountPesewas: row.amount_pesewas,
    currency: row.currency,
    status: row.status as OrderStatus,
    isSyntheticTest: isSyntheticTestEmail(row.customer_email),
    provider: row.provider,
    providerReference: row.provider_reference,
    providerStatus: row.provider_status,
    verifiedAt: row.verified_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    transactions: txRows.results.map((t) => ({
      id: t.id,
      paystackReference: t.paystack_reference,
      eventType: t.event_type,
      amountPesewas: t.amount_pesewas,
      currency: t.currency,
      status: t.status,
      gatewayResponse: t.gateway_response,
      verifiedAt: t.verified_at,
      webhookReceivedAt: t.webhook_received_at,
      createdAt: t.created_at,
    })),
    deliveries: deliveryRows.results.map((d) => ({
      id: d.id,
      assetId: d.asset_id,
      maxDownloads: d.max_downloads,
      accessExpiresAt: d.access_expires_at,
      downloadsUsed: d.downloads_used,
      lastDownloadAt: d.last_download_at,
      status: d.status,
      deliveredAt: d.delivered_at,
    })),
    emails: emailRows.results.map((e) => ({
      id: e.id,
      template: e.template,
      recipient: e.recipient,
      status: e.status,
      sentAt: e.sent_at,
      createdAt: e.created_at,
    })),
  };
}

export type ResendResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_verified' | 'send_failed' };

interface ResendableSession {
  id: number;
  purchase_reference: string;
  product_title: string;
  amount_pesewas: number;
  currency: string;
  customer_email: string | null;
  status: string;
}

async function loadResendableSession(env: Env, reference: string): Promise<ResendableSession | null> {
  return env.DB.prepare(
    `SELECT id, purchase_reference, product_title, amount_pesewas, currency, customer_email, status
     FROM purchase_sessions WHERE purchase_reference = ?`
  )
    .bind(reference)
    .first<ResendableSession>();
}

/**
 * Re-invokes `emailService.sendEmail()` with the exact same
 * `purchase-receipt` template and data shape `fulfilmentService.ts`'s
 * `sendFulfilmentEmails()` already uses at real fulfilment time — no new
 * send logic, no new template. Rejected for any non-`verified` session:
 * resending a receipt for a pending/failed/expired/cancelled/refunded
 * order has no real-world meaning and would only confuse the recipient.
 */
export async function resendReceipt(env: Env, logger: Logger, actorId: number, reference: string): Promise<ResendResult> {
  const session = await loadResendableSession(env, reference);
  if (!session) return { ok: false, reason: 'not_found' };
  if (session.status !== 'verified' || !session.customer_email) return { ok: false, reason: 'not_verified' };

  const result = await sendEmail(env, logger, {
    template: 'purchase-receipt',
    to: session.customer_email,
    data: {
      purchaseReference: session.purchase_reference,
      productTitle: session.product_title,
      amount: formatAmount(session.amount_pesewas, session.currency),
    },
    entityType: 'purchase_session',
    entityId: session.id,
  });

  if (!result.sent) return { ok: false, reason: 'send_failed' };

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'order.receipt_resent',
    entityType: 'purchase_session',
    entityId: session.id,
  });

  return { ok: true };
}

/**
 * Re-sends the `secure-download` template linking to the fulfilment page
 * — deliberately does NOT mint a new download token itself. A token is
 * only ever minted when the customer actually clicks Download on that
 * page (`services/entitlementService.ts`'s `generateDownloadPermission`),
 * preserving that existing "token minted at point of use" design
 * unchanged. Same `verified`-only guard as `resendReceipt`.
 */
export async function resendDownload(env: Env, logger: Logger, actorId: number, reference: string): Promise<ResendResult> {
  const session = await loadResendableSession(env, reference);
  if (!session) return { ok: false, reason: 'not_found' };
  if (session.status !== 'verified' || !session.customer_email) return { ok: false, reason: 'not_verified' };

  const fulfilmentUrl = `${env.SITE_BASE_URL}/checkout/callback/?ref=${encodeURIComponent(session.purchase_reference)}`;

  const result = await sendEmail(env, logger, {
    template: 'secure-download',
    to: session.customer_email,
    data: {
      purchaseReference: session.purchase_reference,
      productTitle: session.product_title,
      fulfilmentUrl,
    },
    entityType: 'purchase_session',
    entityId: session.id,
  });

  if (!result.sent) return { ok: false, reason: 'send_failed' };

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'order.download_resent',
    entityType: 'purchase_session',
    entityId: session.id,
  });

  return { ok: true };
}
