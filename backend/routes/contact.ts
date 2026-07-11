/**
 * POST /api/contact — added to the API alongside the endpoint list in
 * docs/worker-api-design.md (see docs/email-architecture.md's note on
 * this endpoint being a natural extension of that document, recorded
 * there before it was formally added here). Mirrors contact/index.html's
 * fields exactly: name, email, phone (optional), message.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonError, jsonSuccess } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validate';
import { isNonEmptyString, isValidEmail } from '../utils/validation';
import { submitContactMessage } from '../services/contactService';

const RATE_LIMIT = { endpoint: 'contact', limit: 5, windowSeconds: 60 };

export async function handleContact(request: Request, env: Env, logger: Logger): Promise<Response> {
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
    name: {
      test: (value) => isNonEmptyString(value, 200),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'Name is required.',
    },
    email: {
      test: isValidEmail,
      code: 'INVALID_EMAIL',
      message: 'Please provide a valid email address.',
    },
    message: {
      test: (value) => isNonEmptyString(value, 5000),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'Message is required.',
    },
  });
  if (!validation.valid) {
    return jsonError(validation.code, validation.message);
  }

  const { name, email, phone, message } = body as {
    name: string;
    email: string;
    phone?: unknown;
    message: string;
  };

  const result = await submitContactMessage(env, logger, {
    name: name.trim(),
    email: email.trim(),
    phone: isNonEmptyString(phone, 50) ? phone.trim() : null,
    message: message.trim(),
  });

  return jsonSuccess(result);
}
