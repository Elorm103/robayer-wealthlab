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
import { isValidEmail, sanitizeUtmValue } from '../utils/validation';
import { parseCookies } from '../utils/cookies';

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

  const { productId, marketingOptIn, couponCode, email, utmSource, utmMedium, utmCampaign, utmContent } = body as {
    productId: string;
    marketingOptIn?: unknown;
    couponCode?: unknown;
    email: string;
    utmSource?: unknown;
    utmMedium?: unknown;
    utmCampaign?: unknown;
    utmContent?: unknown;
  };

  // Version 5.0 (Customer Acquisition Phase 1, Event Match Quality) —
  // this request IS the one direct, real request from the customer's
  // own browser anywhere in the purchase flow (the later Paystack
  // webhook that completes the purchase is server-to-server, with no
  // customer request to read these from). CF-Connecting-IP matches
  // this codebase's existing convention (middleware/rateLimit.ts) —
  // set by Cloudflare's edge itself, not client-supplied, so it can't
  // be spoofed. `_fbc`/`_fbp` are Meta's own first-party cookies,
  // already set automatically by fbevents.js
  // (js/components/meta-pixel.js) on every page load; read here from
  // the Cookie header of this same-origin request, never generated.
  // All four are genuinely optional — absent (null) whenever they
  // simply don't exist for this visitor, never a fabricated fallback.
  const cookies = parseCookies(request.headers.get('Cookie'));
  const clientIpAddress = request.headers.get('CF-Connecting-IP');
  const clientUserAgent = request.headers.get('User-Agent');
  const fbc = cookies['_fbc'] ?? null;
  const fbp = cookies['_fbp'] ?? null;

  // Affiliate Programme: the rwl_ref attribution cookie, set by
  // POST /api/affiliates/click. Re-validated in full by
  // services/affiliateAttributionService.ts's resolveAffiliateForCheckout()
  // (real code? currently approved? not a self-referral?); never
  // trusted just because it's present.
  const affiliateRefCode = cookies['rwl_ref'] ?? null;

  // P0-C (Attribution Continuity) — the UTM values buy-button.js
  // forwards from the sessionStorage js/components/analytics.js
  // already captured on the landing page. Untrusted client input:
  // sanitizeUtmValue() trims, caps length, and degrades anything
  // malformed to null rather than rejecting the checkout — see its
  // own doc comment in utils/validation.ts. The client never supplies
  // attribution_confidence; that's computed server-side in
  // createCheckoutSession(), from whichever of these plus fbc actually
  // survived to this request.
  const utmSourceValue = sanitizeUtmValue(utmSource);
  const utmMediumValue = sanitizeUtmValue(utmMedium);
  const utmCampaignValue = sanitizeUtmValue(utmCampaign);
  const utmContentValue = sanitizeUtmValue(utmContent);

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
      clientIpAddress,
      clientUserAgent,
      fbc,
      fbp,
      utmSource: utmSourceValue,
      utmMedium: utmMediumValue,
      utmCampaign: utmCampaignValue,
      utmContent: utmContentValue,
      affiliateRefCode,
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
