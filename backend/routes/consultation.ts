/**
 * POST /api/consultation — see docs/worker-api-design.md. Mirrors
 * every field consultation/index.html already collects, including the
 * server-side re-check of the consent checkbox (the live form already
 * enforces this client-side; this is the same rule enforced again on
 * the server, not a new one — docs/worker-api-design.md's Validation
 * note).
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonError, jsonSuccess } from '../utils/responses';
import { isRateLimited } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validate';
import { isNonEmptyString, isOneOf, isValidEmail } from '../utils/validation';
import { submitConsultationRequest } from '../services/consultationService';
import type { PreferredContactMethod } from '../services/consultationService';

const RATE_LIMIT = { endpoint: 'consultation', limit: 5, windowSeconds: 60 };
const CONTACT_METHODS: readonly PreferredContactMethod[] = ['email', 'phone'];

export async function handleConsultation(request: Request, env: Env, logger: Logger): Promise<Response> {
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
    country: {
      test: (value) => isNonEmptyString(value, 100),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'Country is required.',
    },
    category: {
      test: (value) => isNonEmptyString(value, 100),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'Category is required.',
    },
    description: {
      test: (value) => isNonEmptyString(value, 5000),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'Description is required.',
    },
    preferredContactMethod: {
      test: (value) => isOneOf(value, CONTACT_METHODS),
      code: 'MISSING_REQUIRED_FIELD',
      message: 'Preferred contact method must be "email" or "phone".',
    },
    consent: {
      test: (value) => value === true,
      code: 'CONSENT_REQUIRED',
      message: 'Consent is required to submit a consultation request.',
    },
  });
  if (!validation.valid) {
    return jsonError(validation.code, validation.message);
  }

  const { name, email, phone, country, category, description, preferredContactMethod } = body as {
    name: string;
    email: string;
    phone?: unknown;
    country: string;
    category: string;
    description: string;
    preferredContactMethod: PreferredContactMethod;
  };

  const result = await submitConsultationRequest(env, logger, {
    name: name.trim(),
    email: email.trim(),
    phone: isNonEmptyString(phone, 50) ? phone.trim() : null,
    country: country.trim(),
    category: category.trim(),
    description: description.trim(),
    preferredContactMethod,
    consentGiven: true,
  });

  return jsonSuccess(result);
}
