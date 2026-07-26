/**
 * POST /api/coupons/validate — Version 3.2 Milestone M4 (Commerce &
 * Trust Foundations). Public, unauthenticated, non-mutating - the
 * discount-preview endpoint the buy-button UI calls before checkout
 * even starts, so a customer sees "Coupon applied: -GHc5.00" before
 * clicking Buy. Never mutates redemptions_count (see
 * services/couponService.ts's own header comment on the two-phase
 * redemption design) - createCheckoutSession() re-validates
 * independently and is the only place a discount is actually locked
 * in. Thin HTTP layer only; all real logic lives in
 * services/couponService.ts.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonError, jsonSuccess } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';
import { isPlausibleSlug, fetchCatalogProduct, isPurchasable } from '../services/productCatalogService';
import { validateCoupon } from '../services/couponService';

const RATE_LIMIT = { endpoint: 'coupon-validate', limit: 30, windowSeconds: 60 };

export async function handleValidateCoupon(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again in a minute.');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.');
  }
  const { productId, couponCode } = (body ?? {}) as { productId?: unknown; couponCode?: unknown };

  if (!isPlausibleSlug(productId)) return jsonError('VALIDATION_ERROR', 'A valid productId is required.');

  const product = await fetchCatalogProduct(env, productId);
  if (!product || !isPurchasable(product)) {
    return jsonError('COUPON_INVALID', 'This coupon could not be applied to this product.');
  }

  const amountPesewas = Math.round((product.price as number) * 100);
  const result = await validateCoupon(env, couponCode, product.slug, amountPesewas);

  if (!result.valid) {
    return jsonSuccess({ valid: false, reason: result.reason });
  }

  return jsonSuccess({
    valid: true,
    discountPesewas: result.discountPesewas,
    finalAmountPesewas: result.finalAmountPesewas,
  });
}
