/**
 * POST /api/customer/reviews, GET /api/customer/reviews — Version 3.2
 * Milestone M4 (Commerce & Trust Foundations). Thin HTTP layer only;
 * all real logic (including the purchase-gating check) lives in
 * services/reviewService.ts.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireCustomerAuth } from '../../middleware/requireCustomerAuth';
import { requireCustomerCsrf } from '../../middleware/customerCsrf';
import { isPlausibleSlug } from '../../services/productCatalogService';
import { submitOrUpdateReview, listCustomerOwnReviews, isValidRating, isValidReviewBody } from '../../services/reviewService';

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(response.body, { status: response.status, headers });
}

const READ_RATE_LIMIT = { endpoint: 'customer-reviews-read', limit: 60, windowSeconds: 15 * 60 };
const WRITE_RATE_LIMIT = { endpoint: 'customer-reviews-write', limit: 20, windowSeconds: 15 * 60 };

export async function handleListCustomerOwnReviews(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);

  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  const reviews = await listCustomerOwnReviews(env, auth.auth.customerId);
  return withNoStore(jsonSuccess({ reviews }));
}

export async function handleSubmitReview(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);
  const csrfFailure = await requireCustomerCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return withNoStore(csrfFailure);

  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) {
    return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withNoStore(jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.'));
  }
  const { productSlug, rating, body: reviewBody } = (body ?? {}) as { productSlug?: unknown; rating?: unknown; body?: unknown };

  if (!isPlausibleSlug(productSlug)) return withNoStore(jsonError('VALIDATION_ERROR', 'A valid productSlug is required.'));
  if (!isValidRating(rating)) return withNoStore(jsonError('VALIDATION_ERROR', 'A rating between 1 and 5 is required.'));
  if (!isValidReviewBody(reviewBody)) return withNoStore(jsonError('VALIDATION_ERROR', 'A review between 1 and 3000 characters is required.'));

  const result = await submitOrUpdateReview(env, logger, auth.auth.customerId, { productSlug, rating, body: reviewBody });

  if (!result.ok) {
    if (result.reason === 'product_not_found') return withNoStore(jsonError('PRODUCT_NOT_FOUND', 'This product could not be found.'));
    return withNoStore(jsonError('NO_VERIFIED_PURCHASE', "We couldn't find a completed purchase of this product on your account."));
  }

  return withNoStore(jsonSuccess({ reviewId: result.reviewId, status: 'pending' }, 201));
}
