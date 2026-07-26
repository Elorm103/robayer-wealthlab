/**
 * GET /api/products/:slug/reviews — Version 3.2 Milestone M4 (Commerce
 * & Trust Foundations). Public, unauthenticated - approved reviews
 * only, plus the aggregate rating for the product page's summary
 * display. Thin HTTP layer only; all real logic lives in
 * services/reviewService.ts.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import type { RouteParams } from '../worker/index';
import { jsonError, jsonSuccess } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';
import { listPublicReviews } from '../services/reviewService';
import { isPlausibleSlug } from '../services/productCatalogService';

const READ_RATE_LIMIT = { endpoint: 'public-reviews-read', limit: 120, windowSeconds: 15 * 60 };

export async function handleListPublicReviews(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) {
    return jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.');
  }

  const slug = params.slug;
  if (!isPlausibleSlug(slug)) {
    return jsonSuccess({ reviews: [], averageRating: null, count: 0 });
  }

  const result = await listPublicReviews(env, slug);
  return jsonSuccess(result);
}
