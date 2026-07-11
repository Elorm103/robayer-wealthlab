/**
 * POST /api/newsletter — see docs/worker-api-design.md. Thin HTTP
 * layer only: parses/validates the request, calls
 * services/newsletterService.ts, formats the response. No D1 or
 * Resend call happens directly in this file.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonError, jsonSuccess } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validate';
import { isNonEmptyString, isValidEmail } from '../utils/validation';
import { subscribeToNewsletter } from '../services/newsletterService';

const RATE_LIMIT = { endpoint: 'newsletter', limit: 5, windowSeconds: 60 };

export async function handleNewsletter(request: Request, env: Env, logger: Logger): Promise<Response> {
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
    email: {
      test: isValidEmail,
      code: 'INVALID_EMAIL',
      message: 'Please provide a valid email address.',
    },
  });
  if (!validation.valid) {
    return jsonError(validation.code, validation.message);
  }

  const { email, source } = body as { email: string; source?: unknown };

  const result = await subscribeToNewsletter(env, logger, {
    email: email.trim(),
    source: isNonEmptyString(source, 100) ? source.trim() : null,
  });

  return jsonSuccess(result);
}
