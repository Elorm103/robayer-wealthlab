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
  MEDIA_IN_USE: 409,
  SLUG_TAKEN: 409,
  SKU_TAKEN: 409,
  INVALID_MEDIA_REFERENCE: 400,
  INVALID_STATUS_TRANSITION: 409,
  MUST_CHANGE_PASSWORD: 403,
  INCORRECT_PASSWORD: 401,
  INVALID_TOKEN: 400,
  SELF_TARGETED: 403,
  LAST_SUPER_ADMIN: 409,
  INVALID_ROLE: 400,
  EMAIL_TAKEN: 409,
  CAMPAIGN_NOT_DRAFT: 409,
  CAMPAIGN_ALREADY_SENDING: 409,
  CAMPAIGN_NOT_SENDING: 409,
  TEST_REQUIRED: 400,
  NO_RECIPIENTS: 400,
  RECIPIENT_CAP_EXCEEDED: 409,
  RECEIPT_NOT_FOUND: 404,
  CANNOT_REVOKE_CURRENT_SESSION: 400,
  NO_VERIFIED_PURCHASE: 403,
  COUPON_INVALID: 400,
  PASSWORD_NOT_SET: 401,
  AI_GATEWAY_ERROR: 502,
  AI_GATEWAY_BUDGET_EXCEEDED: 402,
  AI_GATEWAY_POLICY_VIOLATION: 403,
  AFFILIATE_NOT_FOUND: 404,
  ALREADY_AFFILIATE: 409,
  AFFILIATE_NOT_APPROVED: 403,
  AFFILIATE_SUSPENDED: 403,
  INVALID_STATE_TRANSITION: 409,
  PAYOUT_BELOW_THRESHOLD: 400,
  PAYOUT_NOT_FOUND: 404,
  INSUFFICIENT_PAYABLE_BALANCE: 409,
  SECURE_READER_DISABLED: 503,
  READER_ACCESS_DENIED: 403,
  READER_SESSION_INVALID: 401,
  INVALID_PAGE: 400,
  INVALID_CHAPTER: 400,
};
