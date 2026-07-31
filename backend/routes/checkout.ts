/**
 * POST /api/checkout/sessions — see docs/commerce-foundation.md and
 * docs/worker-api-design.md. Thin HTTP layer only: parses/validates
 * the request, calls services/commerceService.ts, formats the
 * response. No D1 write or payment-provider call happens directly in
 * this file — see backend/routes/README.md's "routes stay thin" rule.
 *
 * Accepts `{ productId: "<slug>" }` plus, since Version 3.2 Milestone
 * M4 (Commerce & Trust Foundations), an optional `couponCode`. Never
 * accepts price, currency, title, or a discount amount from the
 * client — see docs/commerce-foundation.md's "Pricing" section for
 * why, and productCatalogService.ts for where those values actually
 * come from. `couponCode` is a code, not a price: the discount it
 * produces is always computed server-side inside
 * services/commerceService.ts's createCheckoutSession(), from the
 * coupon's own stored data, before any amount is locked — this
 * invariant is unchanged by M4, only extended. See
 * docs/v3.2-m4c-amendment-2-coupon-security-review.md.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonError, jsonSuccess } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validate';
import { isPlausibleSlug } from '../services/productCatalogService';
import { createCheckoutSession, CommerceError } from '../services/commerceService';
import { isValidEmail } from '../utils/validation';

// Slightly more generous than the form endpoints (newsletter/contact/
// consultation: 5/min) since a visitor legitimately retrying checkout
// after a declined card or a closed tab shouldn't get rate-limited on
// their second or third genuine attempt — see docs/commerce-foundation.md.
const RATE_LIMIT = { endpoint: 'checkout', limit: 10, windowSeconds: 60 };

export async function handleCreateCheckoutSession(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again in a minute.');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.');
  }

  const validation = validateBody(body, {
    productId: {
      test: isPlausibleSlug,
      code: 'VALIDATION_ERROR',
      message: 'A valid productId is required.',
    },
    // Milestone M1 (Customer Identity & Guest Checkout) — see
    // docs/v3.0.2-commerce-architecture-blueprint.md's ratified
    // Checkout Architecture. Strict `=== true`: this is the same
    // consent statement rendered next to the Buy button (see
    // js/components/buy-button.js), never a typed form field — ADR-002's
    // zero-form checkout is unchanged. marketingOptIn is validated
    // separately below since it's genuinely optional (any non-`true`
    // value, including absence, means opted out).
    termsAccepted: {
      test: (value) => value === true,
      code: 'CONSENT_REQUIRED',
      message: 'Please accept the Terms of Service and License Agreement to continue.',
    },
    licenseAccepted: {
      test: (value) => value === true,
      code: 'CONSENT_REQUIRED',
      message: 'Please accept the Terms of Service and License Agreement to continue.',
    },
    // Version 3.4.3 Milestone M6.3 (Production Authentication & Email
    // Recovery) — a real, buyer-provided email is now required before
    // checkout starts. See services/commerceService.ts's
    // CreateCheckoutSessionInput doc comment for the full root-cause
    // trace: relying on the payment provider's own hosted page to
    // collect this meant zero real customers were ever reachable for
    // the mobile_money channel.
    email: {
      test: isValidEmail,
      code: 'VALIDATION_ERROR',
      message: 'A valid email address is required to continue.',
    },
  });
  if (!validation.valid) {
    return jsonError(validation.code, validation.message);
  }

  const { productId, marketingOptIn, couponCode, email } = body as { productId: string; marketingOptIn?: unknown; couponCode?: unknown; email: string };

  try {
    const result = await createCheckoutSession(env, logger, {
      productSlug: productId,
      termsAccepted: true,
      licenseAccepted: true,
      marketingOptIn: marketingOptIn === true,
      customerEmail: email,
      // Version 3.2 Milestone M4 (Commerce & Trust Foundations) — an
      // optional coupon code. Never a price/amount: the discount is
      // always computed server-side by createCheckoutSession() itself,
      // from the coupon's own stored data, preserving this route's
      // existing "never accepts price from the client" invariant
      // unchanged. See docs/v3.2-m4c-amendment-2-coupon-security-review.md.
      couponCode: typeof couponCode === 'string' ? couponCode : null,
    });
    return jsonSuccess({ purchaseReference: result.purchaseReference, checkoutUrl: result.checkoutUrl });
  } catch (err) {
    if (err instanceof CommerceError) {
      // err.message is always safe to show a visitor as-is — see
      // CommerceError's own doc comment in commerceService.ts. Never
      // falls through to the generic error handler's "Reference: {id}"
      // wording, which is reserved for genuinely unexpected failures.
      return jsonError(err.code, err.message);
    }
    throw err; // Genuinely unexpected — let middleware/errorHandler.ts's standard INTERNAL_ERROR envelope handle it.
  }
}
