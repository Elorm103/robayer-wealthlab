/**
 * Payment Provider Abstraction — Version 1.2 Sprint 2.3 (Commerce Foundation),
 * extended Sprint 2.4 (Payment Verification).
 *
 * Every payment provider this project ever integrates implements this
 * one shape. commerceService.ts (the only caller) depends on
 * `PaymentProvider`, never on a specific provider's SDK or API shape
 * directly — adding a second provider later (or swapping Paystack for
 * something else in one region) means writing one more file in this
 * folder and one more case in `index.ts`'s selector, not touching
 * commerceService.ts or any route. See docs/commerce-foundation.md's
 * "Payment provider abstraction" section.
 *
 * `createCheckoutSession()` (Sprint 2.3) and `verifyPayment()`
 * (Sprint 2.4) are implemented. `refundPayment()` remains typed and
 * stubbed — see docs/payment-verification.md's "Future refunds."
 */

import type { Env } from '../../worker/env';

export interface CreateCheckoutSessionRequest {
  /** This project's own internal purchase reference — generated before the provider is ever contacted. See docs/commerce-foundation.md's "Internal purchase reference." */
  purchaseReference: string;
  /** Smallest currency unit (pesewas for GHS) — never a display price. */
  amountPesewas: number;
  currency: string;
  /** Shown in the provider's own dashboard / receipt UI, not used for any logic here. */
  productTitle: string;
  /**
   * Identity/version fields locked into the provider's metadata at
   * checkout time, so Sprint 2.4's verification can cross-check them
   * against what the provider echoes back on verify — see
   * docs/payment-verification.md's "Metadata verification." Distinct
   * from `amountPesewas`/`currency` (which the provider itself
   * authoritatively reports at verify time): these three only ever
   * exist because *we* put them in `metadata`, so verification must
   * compare against what was originally locked, not re-derive them.
   */
  productId: string;
  productSlug: string;
  productVersion: string | null;
  /** Where the provider should send the visitor back to after checkout completes (success or cancel). */
  callbackUrl: string;
}

export interface CreateCheckoutSessionResult {
  /** The URL to redirect the visitor to. */
  checkoutUrl: string;
  /** The provider's own transaction reference, if it returns one synchronously at initialization — null if not. Never treated as the primary business identifier — see docs/commerce-foundation.md. */
  providerReference: string | null;
}

/**
 * Mirrors Paystack's own transaction-status vocabulary (also used by
 * `payment_transactions.status` in backend/database/schema.sql) —
 * kept as the provider's own words rather than translated into this
 * project's purchase_sessions vocabulary, since verifyPayment() is a
 * thin, faithful wrapper around what the provider actually reports;
 * commerceService.ts is what decides how a given PaymentStatus maps
 * onto a purchase_sessions state transition.
 */
export type PaymentStatus = 'success' | 'failed' | 'abandoned' | 'pending';

export interface VerifyPaymentResult {
  status: PaymentStatus;
  amountPesewas: number;
  currency: string;
  /** The buyer's email, as confirmed by the provider — never trusted from the client. See docs/commerce-foundation.md's email-collection note. */
  customerEmail: string | null;
  /**
   * The provider's own reference for this transaction — should equal
   * the `purchaseReference` verifyPayment() was called with, since
   * Standard/Redirect initialize passes our reference straight
   * through; re-confirmed here as a defense-in-depth check rather than
   * assumed.
   */
  providerReference: string;
  /**
   * Whatever `metadata` object the provider echoes back — the same
   * shape `createCheckoutSession()` sent at initialize time. Verified
   * field-by-field in commerceService.ts against the purchase_sessions
   * row's own locked values before anything is trusted — see
   * docs/payment-verification.md's "Metadata verification."
   */
  metadata: Record<string, unknown> | null;
}

export type RefundStatus = 'refunded' | 'failed' | 'pending';

export interface RefundResult {
  status: RefundStatus;
}

export interface PaymentProvider {
  /**
   * Implemented this sprint. Prepares a payment request with the
   * provider and returns a checkout URL to redirect the visitor to.
   * Must never be passed anything the caller hasn't already validated
   * server-side (amount/currency come from the Product Platform via
   * commerceService.ts, never from the frontend).
   */
  createCheckoutSession(request: CreateCheckoutSessionRequest, env: Env): Promise<CreateCheckoutSessionResult>;

  /**
   * Implemented Sprint 2.4. Calls the provider's own server-side
   * verify endpoint — the only trusted source of truth for whether a
   * payment genuinely succeeded. Never called with anything from the
   * client; always called with the reference commerceService.ts looked
   * up from purchase_sessions. See docs/payment-verification.md.
   */
  verifyPayment(reference: string, env: Env): Promise<VerifyPaymentResult>;

  /**
   * Not implemented this sprint — see docs/commerce-foundation.md's
   * "Future refunds" section. A future sprint implements this to call
   * the provider's refund endpoint and update the purchase/order
   * record accordingly.
   */
  refundPayment(reference: string, env: Env): Promise<RefundResult>;
}
