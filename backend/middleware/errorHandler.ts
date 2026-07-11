/**
 * Top-level error handling — not one of the five middleware files
 * originally planned in this folder's README (auth/rateLimit/cors/
 * validate/csrf), but a genuine need identified while implementing
 * Sprint 3: backend/worker/README.md already promises "an unhandled
 * error in any route still returns the standardized failure shape,
 * never a raw stack trace" — this is that promise's concrete
 * implementation, wrapping route dispatch in worker/index.ts.
 */

import type { Logger } from '../utils/logger';
import { jsonError } from '../utils/responses';

export async function withErrorHandling(
  handler: () => Promise<Response>,
  logger: Logger,
  requestId: string
): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    logger.error('Unhandled error', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    // requestId is included in the message itself (not just logged)
    // so a buyer/subscriber reporting "it broke" gives support one
    // concrete ID to search Worker logs for.
    return jsonError('INTERNAL_ERROR', `Something went wrong on our end. Reference: ${requestId}`, 500);
  }
}
