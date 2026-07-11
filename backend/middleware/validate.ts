/**
 * Per-route input validation, applied as the first step of each route
 * handler (backend/routes/) — before any D1 write or service call —
 * so a route's own logic never has to defensively re-check "is this
 * field even present." Per docs/backend-security.md: whitelist, not
 * blacklist — every field declares its own expected shape and the
 * exact ApiErrorCode/message to return if it doesn't match, rather
 * than trying to enumerate every bad input.
 */

import type { ApiErrorCode } from '../types/api-contracts';

export interface FieldRule {
  test: (value: unknown) => boolean;
  code: ApiErrorCode;
  message: string;
}

export interface ValidationSchema {
  [field: string]: FieldRule;
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; code: ApiErrorCode; message: string };

export function validateBody(body: unknown, schema: ValidationSchema): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      valid: false,
      code: 'VALIDATION_ERROR',
      message: 'Request body must be a JSON object.',
    };
  }

  const record = body as Record<string, unknown>;

  for (const [field, rule] of Object.entries(schema)) {
    if (!rule.test(record[field])) {
      return { valid: false, code: rule.code, message: rule.message };
    }
  }

  return { valid: true };
}
