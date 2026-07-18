/**
 * Robayer WealthLab — Backend API Contracts (Version 1.2 Sprint 2, Phase 7)
 *
 * STATUS: design only. Not imported by any running code — no Worker
 * exists yet. These types have zero runtime behavior; they exist so
 * every future route (backend/routes/) and every future consumer of
 * this API agrees on one response shape from the start, instead of
 * each endpoint inventing its own.
 *
 * See docs/worker-api-design.md for what each endpoint's own `data`
 * shape looks like inside this envelope.
 */

/** Every successful response, from every endpoint, without exception. */
export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

/**
 * Every failed response, from every endpoint, without exception.
 * `error.code` is one of the values in `ApiErrorCode` below — always
 * machine-readable, so a future frontend never has to parse a free-text
 * message to decide what happened. `error.message` is a human-readable
 * explanation, safe to show to an end user (never a raw exception
 * message or stack trace — see docs/backend-security.md's note on
 * never leaking internal errors to a client).
 */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * Every error code named across docs/worker-api-design.md, in one
 * place. Adding a new endpoint later should mean adding its error
 * codes here too, not inventing a one-off string inline.
 */
export type ApiErrorCode =
  // Generic, usable by any endpoint
  | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  | 'NOT_AUTHENTICATED'
  | 'FORBIDDEN'
  | 'INTERNAL_ERROR'
  // Added in Version 1.2 Sprint 3 — the routing layer itself needs a code
  // for "no route matched this path/method," which no endpoint-specific
  // code above covers.
  | 'NOT_FOUND'
  // POST /api/orders
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_NOT_ACTIVE'
  | 'INVALID_EMAIL'
  // POST /api/payments/verify
  | 'ORDER_NOT_FOUND'
  | 'AMOUNT_MISMATCH'
  | 'PAYMENT_NOT_SUCCESSFUL'
  | 'ALREADY_PROCESSED'
  | 'PAYSTACK_API_ERROR'
  // POST /api/consultation
  | 'MISSING_REQUIRED_FIELD'
  | 'CONSENT_REQUIRED'
  // GET /api/download/:token
  | 'TOKEN_NOT_FOUND'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_ALREADY_USED'
  | 'DOWNLOAD_LIMIT_REACHED'
  // POST /api/admin/login
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_INACTIVE'
  // POST /api/webhooks/paystack — added Version 1.2 Sprint 2.4
  | 'INVALID_SIGNATURE'
  // GET /api/purchases/:reference, POST /api/purchases/:reference/downloads
  // — added Version 1.2 Sprint 2.5 (Digital Fulfilment Platform)
  | 'PURCHASE_NOT_FOUND'
  | 'DOWNLOAD_NOT_AVAILABLE'
  // GET /api/download/:token — added Version 1.2 Sprint 2.5. TOKEN_NOT_FOUND/
  // TOKEN_EXPIRED/TOKEN_ALREADY_USED/DOWNLOAD_LIMIT_REACHED above (already
  // present since Phase 4's original design) are reused as-is, unchanged.
  | 'ASSET_UNAVAILABLE'
  // /api/admin/media/* — added Version 2.0 Phase 1 (Media Library)
  | 'MEDIA_NOT_FOUND'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  | 'DUPLICATE_ASSET'
  | 'ALREADY_DELETED'
  | 'NOT_DELETED'
  | 'FILE_REJECTED'
  // /api/admin/products/* — added Version 2.0 Phase 2 (Products Module)
  | 'SLUG_TAKEN'
  | 'SKU_TAKEN'
  | 'INVALID_MEDIA_REFERENCE'
  | 'INVALID_STATUS_TRANSITION'
  // /api/admin/auth/* — added Version 2.1 Phase 3 (Identity & Security)
  | 'MUST_CHANGE_PASSWORD'
  | 'INCORRECT_PASSWORD'
  | 'INVALID_TOKEN'
  // /api/admin/users/* — added Version 2.1 Phase 4 (User Management)
  | 'SELF_TARGETED'
  | 'LAST_SUPER_ADMIN'
  | 'INVALID_ROLE'
  | 'EMAIL_TAKEN'
  // /api/admin/newsletter/campaigns/* — added Version 2.1 Phase 6 (Newsletter Campaigns)
  | 'CAMPAIGN_NOT_DRAFT'
  | 'CAMPAIGN_ALREADY_SENDING'
  | 'CAMPAIGN_NOT_SENDING'
  | 'TEST_REQUIRED'
  | 'NO_RECIPIENTS'
  | 'RECIPIENT_CAP_EXCEEDED';
