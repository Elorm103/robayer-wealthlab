/**
 * Robayer WealthLab — Backend Entity Types (Version 1.2 Sprint 2, Phase 7)
 *
 * STATUS: design only. Mirrors backend/database/schema.sql table-for-
 * table — see docs/database-design.md for the full rationale behind
 * every field. Not imported by any running code; no D1 database exists
 * yet to read these shapes from.
 *
 * Convention: fields are camelCase here (idiomatic TypeScript) even
 * though schema.sql uses snake_case (idiomatic SQL) — the mapping
 * between the two happens in whichever future data-access code reads
 * from D1, not by changing either convention to match the other.
 */

export type ProductStatus = 'draft' | 'active' | 'archived';

export interface Product {
  id: number;
  slug: string;
  title: string;
  subtitle: string | null;
  category: string; // matches content/categories/index.json's slug — not a D1 foreign key, see docs/database-design.md
  pricePesewas: number;
  currency: string;
  status: ProductStatus;
  sku: string | null;
  coverImageKey: string | null;
  downloadFileKey: string | null;
  maxDownloads: number;
  downloadExpiresDays: number;
  featured: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Customer {
  id: number;
  email: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OrderStatus = 'pending' | 'paid' | 'failed' | 'refunded';

export interface Order {
  id: number;
  orderReference: string;
  customerId: number;
  productId: number;
  amountPesewas: number;
  currency: string;
  status: OrderStatus;
  paymentTransactionId: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** The provider's own reported transaction status vocabulary — matches PaymentStatus in backend/services/payments/types.ts. */
export type PaymentTransactionStatus = 'pending' | 'success' | 'failed' | 'abandoned';

/**
 * Updated Version 1.2 Sprint 2.4: `orderId` (referencing the
 * deprecated `orders` table, see backend/database/schema.sql) replaced
 * by `purchaseSessionId`. This table is now this project's primary
 * webhook idempotency ledger — `paystackReference` is UNIQUE, and
 * `eventType` records which Paystack event this row represents. See
 * docs/payment-verification.md's "Idempotency."
 */
export interface PaymentTransaction {
  id: number;
  purchaseSessionId: number | null; // nullable: a webhook could arrive for a reference with no matching session — still recorded for audit
  paystackReference: string;
  eventType: string; // e.g. "charge.success", "charge.failed"
  amountPesewas: number;
  currency: string;
  status: PaymentTransactionStatus;
  gatewayResponse: string | null;
  verifiedAt: string | null;
  webhookReceivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // No deletedAt: financial transaction records are never deleted — see docs/database-design.md
}

/**
 * Added in Version 1.2 Sprint 2.3 (Commerce Foundation), revised
 * Sprint 2.4 (Payment Verification) — see docs/commerce-foundation.md
 * and docs/payment-verification.md, and backend/database/schema.sql's
 * purchase_sessions table for the full rationale, including why this
 * keys off `productSlug` rather than a D1 `products` row.
 *
 * `paid` renamed `verified`; `abandoned` removed (never reachable);
 * `cancelled`/`refunded` added (schema-provisioned, not yet reachable
 * by any code — see docs/payment-verification.md's "Purchase state
 * machine").
 */
export type PurchaseSessionStatus = 'pending' | 'verified' | 'failed' | 'expired' | 'cancelled' | 'refunded';

export interface PurchaseSession {
  id: number;
  purchaseReference: string | null; // null only for the brief instant between insert and the follow-up update that sets it — see backend/services/commerceService.ts
  productSlug: string; // content/products/{slug}.json's own slug — the Product Platform is the source of truth, not a D1 products table
  productId: string; // content/products/{slug}.json's own `id` field — locked at checkout time, cross-checked at verification
  productVersion: string | null; // locked at checkout time, cross-checked at verification
  productTitle: string; // snapshotted at session-creation time
  amountPesewas: number;
  currency: string;
  status: PurchaseSessionStatus;
  provider: string; // matches a backend/services/payments/ implementation key, e.g. "paystack"
  providerReference: string | null;
  providerStatus: string | null; // the provider's own raw status string at verification time — audit only
  checkoutUrl: string | null;
  customerEmail: string | null; // unknown until verification confirms it via the provider's own verify response
  verifiedAt: string | null; // set only once status transitions to 'verified'
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Deprecated — see backend/database/schema.sql's note above the `downloads` table. Superseded by `Delivery` below. */
export interface Download {
  id: number;
  orderId: number;
  productId: number;
  maxDownloads: number; // copied from the product's policy at time of purchase
  downloadsUsed: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Added in Version 1.2 Sprint 2.5 (Digital Fulfilment Platform) — see
 * docs/digital-fulfilment.md and backend/database/schema.sql's
 * `deliveries` table for the full rationale. The real entitlement
 * record: one row per (purchase, asset) pair, created once at
 * fulfilment time.
 */
export type DeliveryStatus = 'ready' | 'delivered' | 'revoked';

export interface Delivery {
  id: number;
  purchaseSessionId: number;
  assetId: string; // content/products/{slug}.json's downloadFiles[].assetId
  productSlug: string; // denormalized snapshot
  maxDownloads: number | null; // null = unlimited, snapshotted at fulfilment time
  accessExpiresAt: string | null; // null = lifetime access, snapshotted at fulfilment time
  downloadsUsed: number; // incremented only at actual file-download (token redemption), not token issuance
  lastDownloadAt: string | null;
  status: DeliveryStatus;
  deliveredAt: string | null; // set once the fulfilment email is successfully sent
  createdAt: string;
  updatedAt: string;
}

/** Updated Version 1.2 Sprint 2.5: `downloadId` (referencing the deprecated `downloads` table) replaced by `deliveryId` (referencing `Delivery`). */
export interface DownloadToken {
  id: number;
  token: string;
  deliveryId: number;
  expiresAt: string; // short TTL, independent of Delivery.accessExpiresAt
  usedAt: string | null; // set once redeemed; never valid again after this is set
  createdAt: string;
}

export type NewsletterSubscriberStatus = 'subscribed' | 'unsubscribed';

export interface NewsletterSubscriber {
  id: number;
  email: string;
  status: NewsletterSubscriberStatus;
  source: string | null;
  subscribedAt: string;
  unsubscribedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ConsultationRequestStatus = 'new' | 'reviewed' | 'responded' | 'closed';
export type PreferredContactMethod = 'email' | 'phone';

export interface ConsultationRequest {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  country: string;
  category: string;
  description: string;
  preferredContactMethod: PreferredContactMethod;
  consentGiven: boolean;
  status: ConsultationRequestStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** Added in Version 1.2 Sprint 3 — mirrors contact/index.html's form fields exactly. */
export type ContactMessageStatus = 'new' | 'reviewed' | 'responded' | 'closed';

export interface ContactMessage {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  status: ContactMessageStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type AdminRole = 'super_admin' | 'editor' | 'support';

export interface AdminUser {
  id: number;
  email: string;
  passwordHash: string; // never plain text — see docs/authentication-strategy.md
  role: AdminRole;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type AuditLogActorType = 'admin' | 'system' | 'customer';

export interface AuditLog {
  id: number;
  actorType: AuditLogActorType;
  actorId: number | null; // nullable: system-initiated actions have no actor
  action: string; // e.g. 'product.updated', 'order.refunded', 'admin.login'
  entityType: string | null;
  entityId: number | null;
  metadata: string | null; // free-form JSON blob, parsed by whoever reads it
  createdAt: string;
}
