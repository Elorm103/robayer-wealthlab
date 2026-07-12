/**
 * Builds every HTTP Response this API returns, using the standardized
 * envelope from backend/types/api-contracts.ts — no route should ever
 * construct a raw `new Response(JSON.stringify(...))` itself, so the
 * shape can never accidentally drift between endpoints.
 */

import type { ApiErrorCode, ApiErrorResponse, ApiSuccessResponse } from '../types/api-contracts';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export function jsonSuccess<T>(data: T, status = 200): Response {
  const body: ApiSuccessResponse<T> = { success: true, data };
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS } });
}

export function jsonError(code: ApiErrorCode, message: string, status?: number): Response {
  const body: ApiErrorResponse = { success: false, error: { code, message } };
  return new Response(JSON.stringify(body), {
    status: status ?? ERROR_STATUS[code],
    headers: { ...JSON_HEADERS },
  });
}

/**
 * The HTTP status each ApiErrorCode maps to, kept in one place so a
 * route never has to guess or duplicate this mapping. `Record<ApiErrorCode, ...>`
 * deliberately requires every code from the shared union to have an
 * entry here, including ones no route in this sprint returns yet
 * (Orders/Payments/Downloads/Admin) — this keeps the map exhaustive as
 * those endpoints are implemented in future sprints, rather than
 * needing a second pass to add them then.
 */
export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  RATE_LIMITED: 429,
  NOT_AUTHENTICATED: 401,
  FORBIDDEN: 403,
  INTERNAL_ERROR: 500,
  NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  PRODUCT_NOT_ACTIVE: 409,
  INVALID_EMAIL: 400,
  ORDER_NOT_FOUND: 404,
  AMOUNT_MISMATCH: 409,
  PAYMENT_NOT_SUCCESSFUL: 402,
  ALREADY_PROCESSED: 409,
  PAYSTACK_API_ERROR: 502,
  MISSING_REQUIRED_FIELD: 400,
  CONSENT_REQUIRED: 400,
  TOKEN_NOT_FOUND: 404,
  TOKEN_EXPIRED: 410,
  TOKEN_ALREADY_USED: 409,
  DOWNLOAD_LIMIT_REACHED: 429,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_INACTIVE: 403,
  INVALID_SIGNATURE: 401,
  PURCHASE_NOT_FOUND: 404,
  DOWNLOAD_NOT_AVAILABLE: 403,
  ASSET_UNAVAILABLE: 503,
  MEDIA_NOT_FOUND: 404,
  UNSUPPORTED_FILE_TYPE: 415,
  FILE_TOO_LARGE: 413,
  DUPLICATE_ASSET: 409,
  ALREADY_DELETED: 409,
  NOT_DELETED: 409,
  FILE_REJECTED: 422,
};
