/**
 * Commerce Service — Version 1.2 Sprint 2.3 (Commerce Foundation),
 * extended Sprint 2.4 (Payment Verification).
 *
 * Checkout (Sprint 2.3):
 *   1. Validate the requested product against the Product Platform
 *      (productCatalogService.ts) — price/currency/status all come
 *      from there, never from the request.
 *   2. Create an internal purchase session + reference in D1, before
 *      any payment provider is contacted.
 *   3. Ask the configured payment provider (services/payments/) to
 *      prepare a checkout session.
 *   4. Record the result and return the checkout URL.
 *
 * Webhook verification (Sprint 2.4, handlePaymentWebhook()):
 *   1. Record the webhook delivery in payment_transactions
 *      (idempotency layer 1 — see "Idempotency" below).
 *   2. Look up the purchase_sessions row by reference.
 *   3. Reject if not found, already resolved, or expired.
 *   4. For charge.success: call the provider's OWN verifyPayment() —
 *      never trust the webhook payload's business fields directly —
 *      and cross-check status/amount/currency/metadata against the
 *      LOCKED values recorded at checkout time, plus a fresh
 *      product-still-valid check.
 *   5. Atomically transition the session to 'verified' (idempotency
 *      layer 2 — a status-gated conditional UPDATE).
 *
 * Never issues a download (Sprint 2.5) — see
 * docs/payment-verification.md for the full lifecycle, state machine,
 * and trust-boundary reasoning.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { fetchCatalogProduct, isPurchasable } from './productCatalogService';
import { isValidEmail } from '../utils/validation';
import { getPaymentProvider } from './payments';
import { formatPurchaseReference } from '../utils/purchaseReference';
import { fulfilPurchase } from './fulfilmentService';
import { findOrCreateCustomer } from './customer/identityService';
import { createOrderArtifacts } from './orders/orderService';
import { validateCoupon, redeemCoupon, checkFirstPurchaseOnlyViolation } from './couponService';

/** A pending session outlives a genuinely slow checkout, but doesn't sit "pending" forever if the visitor abandons it — see docs/commerce-foundation.md. */
const PURCHASE_SESSION_TTL_MINUTES = 30;

/**
 * Version 3.0.2 Milestone M1 — the Terms of Service / License Agreement
 * versions a checkout locks acceptance against. Server-stamped, never
 * client-supplied (the same "never trust the client for anything that
 * matters" discipline this file already applies to price/currency) —
 * see legal/terms-of-use/index.html and legal/license-agreement/index.html.
 * Bump these constants (and note the change in the M1 documentation)
 * whenever either document's substance changes; a past purchase's
 * locked version must never silently drift to match a newer document.
 */
const CURRENT_TERMS_VERSION = 'v1.0';
const CURRENT_LICENSE_VERSION = 'v1.0';

export type CommerceErrorCode = 'PRODUCT_NOT_FOUND' | 'PRODUCT_NOT_ACTIVE' | 'PAYSTACK_API_ERROR' | 'CONSENT_REQUIRED' | 'COUPON_INVALID' | 'VALIDATION_ERROR';

/**
 * Thrown for every expected failure in this service. routes/checkout.ts
 * catches this and maps `code`/`message` directly onto the standard API
 * envelope — `message` is always safe to show a visitor as-is (never a
 * raw exception or internal detail), per docs/commerce-foundation.md's
 * "Never expose internal error messages" rule.
 */
export class CommerceError extends Error {
  code: CommerceErrorCode;
  constructor(code: CommerceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface CreateCheckoutSessionInput {
  /** The Product Platform's `slug` — the wire field is named `productId` (matching the sprint brief's contract); there is no separate numeric product ID in this project's architecture, see docs/commerce-foundation.md. */
  productSlug: unknown;
  /**
   * Milestone M1 consent capture — see
   * docs/v3.0.2-commerce-architecture-blueprint.md's ratified Checkout
   * Architecture. Both required: `true` means the visitor clicked Buy
   * with the Terms/License consent statement visibly attached (see
   * js/components/buy-button.js) — this is a purchase-time consent
   * record, not a typed form field, so ADR-002's zero-form-checkout
   * decision is unchanged. `marketingOptIn` is the one genuinely
   * optional, separately-rendered checkbox — defaults to `false`
   * (opt-out) if omitted or not strictly `true`.
   */
  termsAccepted: unknown;
  licenseAccepted: unknown;
  marketingOptIn: unknown;
  /**
   * Version 3.2 Milestone M4 (Commerce & Trust Foundations) — a code,
   * never a price. `null`/absent means no coupon. See
   * docs/v3.2-m4c-amendment-2-coupon-security-review.md.
   */
  couponCode: string | null;
  /**
   * Version 3.4.3 Milestone M6.3 (Production Authentication & Email
   * Recovery) — a real, buyer-provided email is now required before
   * checkout starts, not left to the payment provider's own hosted
   * page to collect. A live production purchase proved that
   * assumption false for the mobile_money channel: Paystack never
   * prompts for/returns a different email there, so relying on it
   * alone meant zero real customers were ever reachable by email,
   * could ever set a password, sign in, or leave a review. See
   * services/payments/paystackProvider.ts's updated header comment for
   * the full trace.
   */
  customerEmail: unknown;
}

export interface CreateCheckoutSessionResult {
  purchaseReference: string;
  checkoutUrl: string;
}

export async function createCheckoutSession(
  env: Env,
  logger: Logger,
  input: CreateCheckoutSessionInput
): Promise<CreateCheckoutSessionResult> {
  const product = await fetchCatalogProduct(env, input.productSlug);
  if (!product) {
    throw new CommerceError('PRODUCT_NOT_FOUND', 'This product could not be found.');
  }
  if (!isPurchasable(product)) {
    // One generic message regardless of *why* it's unpurchasable
    // (draft/archived/coming-soon/free) — never reveals internal
    // product state through an error message. See
    // docs/commerce-foundation.md's "Security" section.
    throw new CommerceError('PRODUCT_NOT_ACTIVE', "This product isn't available for purchase right now.");
  }

  // Server-side re-validation — never trust the client's own gating of
  // the Buy button (js/components/buy-button.js already blocks the
  // click client-side, but that is a UX convenience, never the actual
  // enforcement). Strict `=== true`: anything else (missing, a string,
  // a falsy value) is treated as not accepted.
  if (input.termsAccepted !== true || input.licenseAccepted !== true) {
    throw new CommerceError('CONSENT_REQUIRED', 'Please accept the Terms of Service and License Agreement to continue.');
  }
  const marketingOptIn = input.marketingOptIn === true;

  // Version 3.4.3 Milestone M6.3 — a real email is now required before
  // a payment provider is ever contacted (see CreateCheckoutSessionInput's
  // own doc comment for why). Same "never trust the client's own
  // gating" discipline as termsAccepted/licenseAccepted above: routes/
  // checkout.ts already checks this shape, but the actual enforcement
  // lives here.
  if (!isValidEmail(input.customerEmail)) {
    throw new CommerceError('VALIDATION_ERROR', 'A valid email address is required to continue.');
  }
  const customerEmail = (input.customerEmail as string).trim().toLowerCase();

  // product.effectivePrice is a plain display number (e.g. 39 for
  // GH₵39) — converted to the smallest currency unit only here, at the
  // one point that actually calls a payment provider. See
  // docs/paystack-integration.md's "Currency: subunits, not display
  // prices" for why this conversion is isolated to one place.
  //
  // Version 3.4.2 Milestone M6.2 (Dynamic Pricing) - reads
  // effectivePrice, not price: productCatalogService.ts's own
  // fetchCatalogProduct() already computes whether a sale is active
  // right now and returns whichever price actually applies, so this is
  // the one and only place that decision needs to be honored for
  // checkout to charge the sale price during a sale.
  const originalAmountPesewas = Math.round((product.effectivePrice as number) * 100);
  const currency = product.currency as string;

  // Version 3.2 Milestone M4 (Commerce & Trust Foundations) — the
  // discount, if any, is computed and validated here, BEFORE any
  // amount is locked or sent to the payment provider. couponId/
  // discountPesewas are then locked onto the purchase_sessions row
  // alongside the already-discounted amountPesewas, so the existing
  // webhook amount-verification check (unchanged) automatically
  // compares against the correct, discounted value. See
  // docs/v3.2-m4c-amendment-2-coupon-security-review.md.
  let couponId: number | null = null;
  let discountPesewas = 0;
  if (input.couponCode) {
    const couponResult = await validateCoupon(env, input.couponCode, product.slug, originalAmountPesewas);
    if (!couponResult.valid) {
      throw new CommerceError('COUPON_INVALID', 'This coupon is invalid or could not be applied.');
    }
    couponId = couponResult.couponId;
    discountPesewas = couponResult.discountPesewas;
  }
  const amountPesewas = originalAmountPesewas - discountPesewas;

  const session = await insertPurchaseSession(env, {
    productSlug: product.slug,
    productId: product.id,
    productVersion: product.version,
    productTitle: product.title,
    amountPesewas,
    currency,
    marketingOptIn,
    couponId,
    discountPesewas,
    customerEmail,
  });

  const provider = getPaymentProvider(env);

  let checkout;
  try {
    checkout = await provider.createCheckoutSession(
      {
        purchaseReference: session.purchaseReference,
        amountPesewas,
        currency,
        customerEmail,
        productTitle: product.title,
        productId: product.id,
        productSlug: product.slug,
        productVersion: product.version,
        // Sprint 2.4 builds the page this points to.
        callbackUrl: `${env.SITE_BASE_URL}/checkout/callback/?ref=${encodeURIComponent(session.purchaseReference)}`,
      },
      env
    );
  } catch (err) {
    logger.error('checkout.provider_error', {
      purchaseReference: session.purchaseReference,
      error: err instanceof Error ? err.message : String(err),
    });
    await markPurchaseSessionFailed(env, session.id);
    throw new CommerceError('PAYSTACK_API_ERROR', 'We could not start checkout right now. Please try again shortly.');
  }

  await attachCheckoutResult(env, session.id, checkout);

  logger.info('checkout.session_created', { purchaseReference: session.purchaseReference, productSlug: product.slug, amountPesewas, couponId, discountPesewas });

  return { purchaseReference: session.purchaseReference, checkoutUrl: checkout.checkoutUrl };
}

interface InsertPurchaseSessionInput {
  productSlug: string;
  productId: string;
  productVersion: string | null;
  productTitle: string;
  amountPesewas: number;
  currency: string;
  marketingOptIn: boolean;
  /** Version 3.2 Milestone M4 — both purely additive/nullable-or-defaulted; see migration 0020's own header comment. */
  couponId: number | null;
  discountPesewas: number;
  /**
   * Version 3.4.3 Milestone M6.3 — stored immediately at checkout
   * creation, before payment, so a pending/abandoned session and any
   * support lookup have a real email from the very start. Still
   * overwritten by the provider-confirmed email at verification time
   * whenever the provider actually offers one (see
   * verifySessionAtomic()'s own comment) — this is the floor, not the
   * final answer.
   */
  customerEmail: string;
}

/**
 * Two-step insert: the row is created first (with a NULL
 * purchase_reference) to obtain its own D1 AUTOINCREMENT id, then
 * updated with the formatted reference computed from that id — see
 * backend/utils/purchaseReference.ts. NULL (rather than a placeholder
 * string like '') is what makes this race-free: SQLite's UNIQUE
 * constraint never treats two NULLs as duplicates, so two purchase
 * sessions being created in the same instant can never collide during
 * the brief window before each gets its real reference.
 *
 * Terms/License consent is stamped here too — `termsAccepted`/
 * `licenseAccepted` were already validated `=== true` by the caller,
 * so acceptance is unconditional at this point; only the *version*
 * being agreed to (CURRENT_TERMS_VERSION/CURRENT_LICENSE_VERSION) and
 * the timestamp are recorded, same snapshot-at-checkout-time discipline
 * this table already applies to price/title/version.
 */
async function insertPurchaseSession(env: Env, input: InsertPurchaseSessionInput): Promise<{ id: number; purchaseReference: string }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PURCHASE_SESSION_TTL_MINUTES * 60_000);

  const inserted = await env.DB.prepare(
    `INSERT INTO purchase_sessions
       (purchase_reference, product_slug, product_id, product_version, product_title, amount_pesewas, currency, status, provider, expires_at,
        terms_accepted_at, terms_version, license_accepted_at, license_version, marketing_opt_in, coupon_id, discount_pesewas, customer_email)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'), ?, datetime('now'), ?, ?, ?, ?, ?)`
  )
    .bind(
      input.productSlug,
      input.productId,
      input.productVersion,
      input.productTitle,
      input.amountPesewas,
      input.currency,
      env.PAYMENT_PROVIDER,
      expiresAt.toISOString(),
      CURRENT_TERMS_VERSION,
      CURRENT_LICENSE_VERSION,
      input.marketingOptIn ? 1 : 0,
      input.couponId,
      input.discountPesewas,
      input.customerEmail
    )
    .run();

  const id = Number(inserted.meta.last_row_id);
  const purchaseReference = formatPurchaseReference(id, now);

  await env.DB.prepare(`UPDATE purchase_sessions SET purchase_reference = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(purchaseReference, id)
    .run();

  return { id, purchaseReference };
}

async function attachCheckoutResult(env: Env, id: number, checkout: { checkoutUrl: string; providerReference: string | null }): Promise<void> {
  await env.DB.prepare(
    `UPDATE purchase_sessions SET checkout_url = ?, provider_reference = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(checkout.checkoutUrl, checkout.providerReference, id)
    .run();
}

async function markPurchaseSessionFailed(env: Env, id: number): Promise<void> {
  await env.DB.prepare(`UPDATE purchase_sessions SET status = 'failed', updated_at = datetime('now') WHERE id = ?`)
    .bind(id)
    .run();
}

// ============================================================
// Webhook verification — Version 1.2 Sprint 2.4 (Payment Verification)
// ============================================================

export interface HandlePaymentWebhookInput {
  /** Paystack's own event name, e.g. "charge.success" / "charge.failed". Anything else is acknowledged and ignored. */
  event: string;
  /** Paystack's transaction reference — should equal this project's own purchase_reference (Standard/Redirect passes our reference straight through). */
  providerReference: string;
  /** As reported in the webhook payload itself — used only to record payment_transactions (an unverified, raw audit record); never used to decide whether a payment succeeded. See "Trust boundaries" below. */
  amountPesewas: number;
  currency: string;
  /** The exact raw request body, stored verbatim in payment_transactions.gateway_response for support/audit. */
  rawPayload: string;
}

interface PurchaseSessionRow {
  id: number;
  productSlug: string;
  productId: string;
  productVersion: string | null;
  amountPesewas: number;
  currency: string;
  status: string;
  expiresAt: string;
  /** Milestone M1 — the marketing-consent checkbox state locked at checkout time, seeded into the new customer_profiles row at provisioning. */
  marketingOptIn: boolean;
  /** Milestone M1 — the License Agreement version accepted at checkout time. Milestone M2 copies this onto the licenses row it creates, rather than capturing a fresh value. */
  licenseVersion: string | null;
  /** Version 3.2 Milestone M4 — both locked at checkout-session creation time; amountPesewas above already reflects the discount. */
  couponId: number | null;
  discountPesewas: number;
}

/**
 * Orchestrates webhook-driven payment verification end to end. Never
 * throws for an expected, business-level outcome (duplicate, not
 * found, expired, verification failure) — each is logged and handled
 * internally; routes/webhooks.ts always acknowledges the webhook with
 * 200 once the request itself was well-formed and signed, regardless
 * of what this function decided. See docs/payment-verification.md's
 * "Trust boundaries" for why: the webhook payload's own `data` fields
 * (amount/currency/status/metadata) are NEVER used to decide whether a
 * payment succeeded — only `provider.verifyPayment()`, a fresh,
 * authenticated call to Paystack's own verify endpoint, is trusted for
 * that decision. The webhook is a signed *trigger*, not itself the
 * source of truth.
 */
export async function handlePaymentWebhook(env: Env, logger: Logger, input: HandlePaymentWebhookInput): Promise<void> {
  const { event, providerReference, amountPesewas, currency, rawPayload } = input;

  const session = await getPurchaseSessionByReference(env, providerReference);

  // Idempotency layer 1: paystack_reference is UNIQUE — a duplicate
  // webhook delivery for a transaction we've already recorded fails to
  // insert (INSERT OR IGNORE), atomically, with no read-then-write
  // race window. See docs/payment-verification.md's "Idempotency."
  const isNewTransaction = await recordPaymentTransaction(env, {
    purchaseSessionId: session?.id ?? null,
    paystackReference: providerReference,
    eventType: event,
    amountPesewas,
    currency,
    rawPayload,
  });
  if (!isNewTransaction) {
    logger.info('webhook.duplicate', { reference: providerReference, event });
    return;
  }

  if (!session) {
    logger.warn('verification.failed', { reference: providerReference, event, reason: 'purchase_session_not_found' });
    await markTransactionOutcome(env, providerReference, 'failed');
    return;
  }

  if (session.status !== 'pending') {
    logger.info('webhook.already_processed', { reference: providerReference, event, status: session.status });
    await markTransactionOutcome(env, providerReference, 'failed');
    return;
  }

  if (Date.now() > new Date(session.expiresAt).getTime()) {
    const transitioned = await transitionSessionAtomic(env, session.id, 'expired');
    if (transitioned && event === 'charge.success') {
      // Money genuinely moved for a session we're declining to honor
      // (its checkout TTL passed before verification could complete)
      // — this is a legitimate anomaly needing manual reconciliation,
      // never silently dropped. See docs/payment-verification.md's
      // "Failure handling."
      logger.error('verification.expired_but_paid_needs_review', { reference: providerReference });
    } else {
      logger.warn('verification.expired', { reference: providerReference, event });
    }
    await markTransactionOutcome(env, providerReference, 'failed');
    return;
  }

  if (event === 'charge.failed') {
    await transitionSessionAtomic(env, session.id, 'failed');
    logger.info('verification.failed', { reference: providerReference, reason: 'provider_reported_charge_failed' });
    await markTransactionOutcome(env, providerReference, 'failed');
    return;
  }

  if (event !== 'charge.success') {
    // A validly-signed webhook for an event type this Worker doesn't
    // act on (Paystack sends many event types to the same endpoint) —
    // acknowledged, never an error.
    logger.info('webhook.unhandled_event', { reference: providerReference, event });
    return;
  }

  logger.info('verification.started', { reference: providerReference });

  const provider = getPaymentProvider(env);
  let verifyResult;
  try {
    verifyResult = await provider.verifyPayment(providerReference, env);
  } catch (err) {
    // A transient failure to even reach Paystack's verify endpoint —
    // deliberately does NOT fail the session. Paystack's own webhook
    // retry (or a later manual check) gets another chance; a genuine
    // purchase should never be permanently rejected because of a
    // network blip talking to the provider's own API. See
    // docs/payment-verification.md's "Failure handling."
    logger.error('verification.provider_error', {
      reference: providerReference,
      error: err instanceof Error ? err.message : String(err),
    });
    await markTransactionOutcome(env, providerReference, 'failed');
    return;
  }

  if (verifyResult.status !== 'success') {
    await transitionSessionAtomic(env, session.id, 'failed');
    logger.warn('verification.failed', {
      reference: providerReference,
      reason: 'provider_status_not_success',
      providerStatus: verifyResult.status,
    });
    await markTransactionOutcome(env, providerReference, 'failed');
    return;
  }

  if (verifyResult.amountPesewas !== session.amountPesewas || verifyResult.currency !== session.currency) {
    await transitionSessionAtomic(env, session.id, 'failed');
    // High-severity: an amount/currency mismatch between what we
    // locked at checkout and what the provider's own verify call
    // reports is the classic payment-tampering signal, never ignored
    // or silently reconciled.
    logger.error('verification.failed', {
      reference: providerReference,
      reason: 'amount_or_currency_mismatch',
      expectedAmountPesewas: session.amountPesewas,
      actualAmountPesewas: verifyResult.amountPesewas,
      expectedCurrency: session.currency,
      actualCurrency: verifyResult.currency,
    });
    await markTransactionOutcome(env, providerReference, 'failed');
    return;
  }

  if (!metadataMatches(verifyResult.metadata, session, providerReference)) {
    await transitionSessionAtomic(env, session.id, 'failed');
    logger.error('verification.failed', { reference: providerReference, reason: 'metadata_mismatch' });
    await markTransactionOutcome(env, providerReference, 'failed');
    return;
  }

  // Re-fetch the product to confirm it's still purchasable — even
  // though the amount was already validated against the LOCKED
  // checkout-time value (a legitimate price change mid-checkout is
  // tolerated), a product pulled from sale entirely (archived/
  // discontinued) between checkout and payment should not silently
  // proceed to a "verified" state. See docs/payment-verification.md's
  // "Verification rules."
  const product = await fetchCatalogProduct(env, session.productSlug);
  if (!product || !isPurchasable(product)) {
    await transitionSessionAtomic(env, session.id, 'failed');
    logger.warn('verification.failed', { reference: providerReference, reason: 'product_no_longer_valid' });
    await markTransactionOutcome(env, providerReference, 'failed');
    return;
  }

  // Idempotency layer 2: status-gated conditional UPDATE — even though
  // layer 1 (payment_transactions' UNIQUE constraint) already prevents
  // reprocessing the same webhook delivery, this closes a narrower
  // race: two DIFFERENT payment_transactions rows (e.g. a retried
  // charge with a new Paystack-side attempt) somehow both resolving to
  // this same purchase_sessions row concurrently. WHERE status =
  // 'pending' means only the first one to reach this UPDATE wins.
  const verified = await verifySessionAtomic(env, session.id, verifyResult.customerEmail, verifyResult.status);
  if (!verified) {
    logger.info('webhook.duplicate', { reference: providerReference, event, reason: 'concurrent_resolution' });
    await markTransactionOutcome(env, providerReference, 'success');
    return;
  }

  await markTransactionOutcome(env, providerReference, 'success');
  logger.info('verification.passed', { reference: providerReference, productSlug: session.productSlug });

  // Milestone M1 (Customer Identity & Guest Checkout) — "inside the
  // same verification transaction," per the ratified
  // docs/v3.0.2-commerce-architecture-blueprint.md's Checkout
  // Architecture step 5. Runs immediately after verification succeeds
  // and before fulfilment, so fulfilPurchase() can send the
  // conditional welcome/password-setup email (only for a newly-created
  // customer) alongside the existing receipt/download emails in one
  // pass. Never blocks or fails the verification outcome already
  // recorded above — mirrors fulfilPurchase()'s own "log, don't throw"
  // discipline exactly, for the same reason: a provisioning hiccup must
  // never undo an already-successful payment.
  let customerId: number | null = null;
  let isNewCustomer = false;
  if (verifyResult.customerEmail) {
    try {
      const provisioned = await findOrCreateCustomer(env, verifyResult.customerEmail, session.marketingOptIn);
      customerId = provisioned.customerId;
      isNewCustomer = provisioned.isNewCustomer;
      await env.DB.prepare(`UPDATE purchase_sessions SET customer_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(customerId, session.id)
        .run();
      logger.info('customer.provisioned', { purchaseReference: providerReference, customerId, isNewCustomer });
    } catch (err) {
      // Same "should not happen, but never let a provisioning failure
      // undo a real payment" reasoning fulfilmentService.ts already
      // applies to a missing customer email — logged at error severity,
      // fulfilment still proceeds (download entitlement/receipt do not
      // depend on customerId existing).
      logger.error('customer.provisioning_failed', {
        purchaseReference: providerReference,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    logger.error('customer.provisioning_skipped_no_email', { purchaseReference: providerReference });
  }

  // Version 3.2 Milestone M4 (Commerce & Trust Foundations) — coupon
  // redemption happens here, only now that a real payment has been
  // confirmed (verifySessionAtomic() already succeeded above) - never
  // at checkout-session creation, where a customer could abandon the
  // checkout and never pay. Same "never block or undo a real payment"
  // discipline as customer provisioning above: redeemCoupon() never
  // throws and never reverses this already-successful verification.
  // See docs/v3.2-m4c-amendment-2-coupon-security-review.md.
  if (session.couponId) {
    await redeemCoupon(env, logger, session.couponId, session.id, verifyResult.customerEmail ?? '', session.discountPesewas);
    if (customerId) {
      await checkFirstPurchaseOnlyViolation(env, logger, session.couponId, customerId, session.id);
    }
  }

  // Milestone M2 (Orders, Receipts & Customer Library) — order_items /
  // licenses / receipts creation, immediately after customer
  // provisioning and before fulfilment, per the ratified Blueprint's
  // Deliverable 4 step 6. Same "never block or undo a real payment"
  // discipline as the provisioning block above — createOrderArtifacts()
  // itself never throws (see services/orders/orderService.ts).
  const orderArtifacts = await createOrderArtifacts(env, logger, {
    purchaseSessionId: session.id,
    productId: session.productId,
    productTitle: product.title,
    amountPesewas: session.amountPesewas,
    currency: session.currency,
    taxBehavior: product.taxBehavior,
    licenseTermsVersion: session.licenseVersion,
    customerId,
    // Version 3.2 Milestone M4 — the discount applied at checkout time
    // (0 if no coupon), so the receipt can show the original subtotal
    // and the discount as separate line items rather than only the
    // already-discounted total. See services/orders/orderService.ts.
    discountPesewas: session.discountPesewas,
  });
  if (!orderArtifacts) {
    logger.error('order.artifacts_missing', { purchaseReference: providerReference });
  }

  // Fulfilment (Version 1.2 Sprint 2.5, Digital Fulfilment Platform)
  // happens only after verification has fully and atomically
  // succeeded — never any earlier. fulfilPurchase() never throws (see
  // its own doc comment); a fulfilment failure must never affect the
  // verification outcome already recorded above. See
  // docs/digital-fulfilment.md's "Fulfilment flow."
  await fulfilPurchase(env, logger, {
    purchaseSessionId: session.id,
    purchaseReference: providerReference,
    productSlug: session.productSlug,
    customerEmail: verifyResult.customerEmail,
    amountPesewas: session.amountPesewas,
    currency: session.currency,
    customerId,
    isNewCustomer,
  });
}

/**
 * Verifies every metadata field the sprint brief requires: purchase
 * reference, product ID, product slug, product version. Compared
 * against the values LOCKED on the purchase_sessions row at checkout
 * time (never re-derived), so a legitimate content edit mid-checkout
 * (e.g. a product's version bumped) is caught as a genuine
 * inconsistency rather than silently tolerated — see
 * docs/payment-verification.md's "Metadata verification."
 */
function metadataMatches(
  metadata: Record<string, unknown> | null,
  session: PurchaseSessionRow,
  expectedPurchaseReference: string
): boolean {
  if (!metadata) return false;
  return (
    metadata.purchaseReference === expectedPurchaseReference &&
    metadata.productId === session.productId &&
    metadata.productSlug === session.productSlug &&
    normalizeVersionField(metadata.productVersion) === session.productVersion
  );
}

function normalizeVersionField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

async function getPurchaseSessionByReference(env: Env, reference: string): Promise<PurchaseSessionRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, product_slug AS productSlug, product_id AS productId, product_version AS productVersion,
            amount_pesewas AS amountPesewas, currency, status, expires_at AS expiresAt, marketing_opt_in AS marketingOptIn,
            license_version AS licenseVersion, coupon_id AS couponId, discount_pesewas AS discountPesewas
     FROM purchase_sessions WHERE purchase_reference = ?`
  )
    .bind(reference)
    .first<Omit<PurchaseSessionRow, 'marketingOptIn'> & { marketingOptIn: number }>();
  return row ? { ...row, marketingOptIn: row.marketingOptIn === 1 } : null;
}

interface RecordPaymentTransactionInput {
  purchaseSessionId: number | null;
  paystackReference: string;
  eventType: string;
  amountPesewas: number;
  currency: string;
  rawPayload: string;
}

/**
 * Returns `true` only if this call genuinely inserted a new row (the
 * first time this exact paystack_reference has been seen) — `false`
 * means a row with this reference already existed, i.e. a duplicate
 * webhook delivery. `INSERT OR IGNORE` relies on `paystack_reference
 * UNIQUE` to make this atomic at the database layer — no read-then-
 * write race window between two near-simultaneous deliveries of the
 * same webhook.
 */
async function recordPaymentTransaction(env: Env, input: RecordPaymentTransactionInput): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO payment_transactions
       (purchase_session_id, paystack_reference, event_type, amount_pesewas, currency, status, gateway_response, webhook_received_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, datetime('now'))`
  )
    .bind(
      input.purchaseSessionId,
      input.paystackReference,
      input.eventType,
      input.amountPesewas,
      input.currency,
      input.rawPayload
    )
    .run();
  return result.meta.changes === 1;
}

/** Marks the payment_transactions row's final outcome. `verified_at` is set only on success, matching schema.sql's own documented meaning for that column. */
async function markTransactionOutcome(env: Env, paystackReference: string, status: 'success' | 'failed'): Promise<void> {
  if (status === 'success') {
    await env.DB.prepare(
      `UPDATE payment_transactions SET status = ?, verified_at = datetime('now'), updated_at = datetime('now') WHERE paystack_reference = ?`
    )
      .bind(status, paystackReference)
      .run();
  } else {
    await env.DB.prepare(`UPDATE payment_transactions SET status = ?, updated_at = datetime('now') WHERE paystack_reference = ?`)
      .bind(status, paystackReference)
      .run();
  }
}

/**
 * Atomically transitions a purchase session to a terminal
 * non-verified state — `WHERE status = 'pending'` means this is a
 * no-op (returns `false`) if the session was already resolved by a
 * concurrent request, never overwriting an existing outcome.
 */
async function transitionSessionAtomic(env: Env, id: number, newStatus: 'failed' | 'expired' | 'cancelled'): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE purchase_sessions SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending'`
  )
    .bind(newStatus, id)
    .run();
  return result.meta.changes === 1;
}

/**
 * Atomically transitions a purchase session to 'verified' — the one
 * state transition Sprint 2.5 (delivery) will gate on. `WHERE status =
 * 'pending'` is idempotency layer 2 (see handlePaymentWebhook's own
 * comment) — returns `false` if a concurrent request already resolved
 * this session first, in which case the caller treats it as a
 * duplicate rather than double-verifying.
 */
async function verifySessionAtomic(
  env: Env,
  id: number,
  customerEmail: string | null,
  providerStatus: string
): Promise<boolean> {
  // Version 3.4.3 Milestone M6.3 — COALESCE, not a blind overwrite: a
  // real customer email is already stored on this row from checkout
  // creation time (see insertPurchaseSession()). The provider-confirmed
  // email is still preferred whenever the provider actually offers one
  // (e.g. a card payment where the buyer edited it on Paystack's own
  // page), but a channel that echoes back nothing (or the same value
  // unchanged) must never wipe out the real email already on file.
  const result = await env.DB.prepare(
    `UPDATE purchase_sessions
     SET status = 'verified', customer_email = COALESCE(?, customer_email), provider_status = ?, verified_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'`
  )
    .bind(customerEmail, providerStatus, id)
    .run();
  return result.meta.changes === 1;
}

export interface PurchaseVerificationStatus {
  verified: boolean;
  status: string;
  productSlug: string;
  customerEmail: string | null;
}

/**
 * The single question Sprint 2.5 (Secure Ebook Delivery) needs to ask:
 * "has this purchase been verified?" Exposed here, not in Sprint 2.5,
 * because answering it correctly is entirely this sprint's
 * responsibility — Sprint 2.5 should never need its own logic to
 * interpret purchase_sessions.status. Read-only; grants nothing.
 */
export async function getPurchaseVerificationStatus(env: Env, purchaseReference: string): Promise<PurchaseVerificationStatus | null> {
  const row = await env.DB.prepare(
    `SELECT status, product_slug AS productSlug, customer_email AS customerEmail
     FROM purchase_sessions WHERE purchase_reference = ?`
  )
    .bind(purchaseReference)
    .first<{ status: string; productSlug: string; customerEmail: string | null }>();
  if (!row) return null;
  return {
    verified: row.status === 'verified',
    status: row.status,
    productSlug: row.productSlug,
    customerEmail: row.customerEmail,
  };
}
