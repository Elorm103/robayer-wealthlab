/**
 * Paystack implementation of PaymentProvider (./types.ts).
 *
 * `createCheckoutSession()` (Sprint 2.3) uses Paystack's
 * Standard/Redirect flow (`POST /transaction/initialize`, returning an
 * `authorization_url` to redirect the visitor to), not the Inline/Popup
 * flow docs/paystack-integration.md originally recommended — see
 * docs/commerce-foundation.md's "Reconciling with
 * docs/paystack-integration.md" for the full reasoning.
 *
 * `verifyPayment()` (Sprint 2.4) calls Paystack's own
 * `GET /transaction/verify/:reference` — the only trusted source of
 * truth for whether a payment genuinely succeeded. See
 * docs/payment-verification.md.
 */

import type { Env } from '../../worker/env';
import type {
  PaymentProvider,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResult,
  VerifyPaymentResult,
  PaymentStatus,
  RefundResult,
} from './types';

interface PaystackInitializeResponse {
  status: boolean;
  message: string;
  data?: {
    authorization_url?: string;
    access_code?: string;
    reference?: string;
  };
}

interface PaystackVerifyResponse {
  status: boolean;
  message: string;
  data?: {
    status?: string;
    reference?: string;
    amount?: number;
    currency?: string;
    customer?: { email?: string };
    metadata?: Record<string, unknown> | null;
  };
}

export const paystackProvider: PaymentProvider = {
  async createCheckoutSession(request: CreateCheckoutSessionRequest, env: Env): Promise<CreateCheckoutSessionResult> {
    // Paystack's initialize endpoint requires an `email` field, but this
    // sprint's frontend sends nothing but the product identifier — no
    // email is collected before checkout (see docs/commerce-foundation.md's
    // "Pricing"/"Frontend" sections, matching the sprint brief's "frontend
    // sends only productId, nothing else"). Rather than inventing a way
    // to collect one, a synthetic placeholder scoped to this exact
    // purchase reference is sent instead — it is never treated as a
    // real customer email anywhere in this codebase. Paystack's own
    // hosted checkout page prompts the buyer for their real email during
    // payment; Sprint 2.4 reads the provider-confirmed email back from
    // the verify response rather than ever trusting one collected
    // client-side before payment. This is a stricter security posture
    // than collecting-then-trusting a client email, not a workaround.
    const placeholderEmail = `checkout+${request.purchaseReference}@robayerwealthlab.com`;

    let response: Response;
    try {
      response = await fetch(`${env.PAYSTACK_BASE_URL}/transaction/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: placeholderEmail,
          amount: request.amountPesewas,
          currency: request.currency,
          reference: request.purchaseReference,
          callback_url: request.callbackUrl,
          // purchaseReference/productId/productSlug/productVersion are
          // locked in here and cross-checked against what Paystack
          // echoes back on verify — see docs/payment-verification.md's
          // "Metadata verification." custom_fields is purely cosmetic
          // (Paystack dashboard display), not read by any code here.
          metadata: {
            purchaseReference: request.purchaseReference,
            productId: request.productId,
            productSlug: request.productSlug,
            productVersion: request.productVersion,
            custom_fields: [
              { display_name: 'Product', variable_name: 'product', value: request.productTitle },
            ],
          },
        }),
      });
    } catch (err) {
      throw new Error(`Paystack initialize request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      throw new Error(`Paystack initialize returned HTTP ${response.status}`);
    }

    const body = (await response.json().catch(() => null)) as PaystackInitializeResponse | null;
    if (!body || !body.status || !body.data?.authorization_url) {
      throw new Error(`Paystack initialize did not return a usable checkout URL: ${body?.message ?? 'no response body'}`);
    }

    return {
      checkoutUrl: body.data.authorization_url,
      providerReference: body.data.reference ?? null,
    };
  },

  async verifyPayment(reference: string, env: Env): Promise<VerifyPaymentResult> {
    // The authoritative check — never trusts the webhook payload's own
    // embedded `data` fields for business decisions (only its
    // `event`/`data.reference`, used purely to know *which* reference
    // to verify). This call is what actually decides whether a
    // payment succeeded — see docs/payment-verification.md's "Trust
    // boundaries."
    let response: Response;
    try {
      response = await fetch(`${env.PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` },
      });
    } catch (err) {
      throw new Error(`Paystack verify request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      throw new Error(`Paystack verify returned HTTP ${response.status}`);
    }

    const body = (await response.json().catch(() => null)) as PaystackVerifyResponse | null;
    if (!body || !body.status || !body.data) {
      throw new Error(`Paystack verify did not return a usable response: ${body?.message ?? 'no response body'}`);
    }

    const data = body.data;
    if (typeof data.reference !== 'string' || typeof data.amount !== 'number' || typeof data.currency !== 'string' || typeof data.status !== 'string') {
      throw new Error('Paystack verify response is missing required fields.');
    }

    return {
      status: normalizeStatus(data.status),
      amountPesewas: data.amount,
      currency: data.currency,
      customerEmail: data.customer?.email ?? null,
      providerReference: data.reference,
      metadata: data.metadata ?? null,
    };
  },

  async refundPayment(): Promise<RefundResult> {
    // Not implemented this sprint. See docs/commerce-foundation.md's
    // "Future refunds" section for the planned design
    // (POST /refund, admin-triggered only).
    throw new Error('paystackProvider.refundPayment() is not implemented yet — see docs/commerce-foundation.md.');
  },
};

/**
 * Maps Paystack's raw status string onto this abstraction's own
 * PaymentStatus union. Anything not explicitly recognized maps to
 * `'pending'`, never `'success'` — an unrecognized status string must
 * never be silently treated as a successful payment; `'pending'`
 * causes commerceService.ts to leave the purchase session as-is
 * (retry-able) rather than either wrongly verifying or wrongly failing
 * it. See docs/payment-verification.md.
 */
function normalizeStatus(raw: string): PaymentStatus {
  if (raw === 'success' || raw === 'failed' || raw === 'abandoned') return raw;
  return 'pending';
}
