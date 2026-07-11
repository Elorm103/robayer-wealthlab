/**
 * POST /api/checkout/sessions — see docs/commerce-foundation.md and
 * docs/worker-api-design.md. Thin HTTP layer only: parses/validates
 * the request, calls services/commerceService.ts, formats the
 * response. No D1 write or payment-provider call happens directly in
 * this file — see backend/routes/README.md's "routes stay thin" rule.
 *
 * Accepts only `{ productId: "<slug>" }`. Never accepts price,
 * currency, or title from the client — see docs/commerce-foundation.md's
 * "Pricing" section for why, and productCatalogService.ts for where
 * those values actually come from.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonError, jsonSuccess } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validate';
import { isPlausibleSlug } from '../services/productCatalogService';
import { createCheckoutSession, CommerceError } from '../services/commerceService';

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
  });
  if (!validation.valid) {
    return jsonError(validation.code, validation.message);
  }

  const { productId } = body as { productId: string };

  try {
    const result = await createCheckoutSession(env, logger, { productSlug: productId });
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
