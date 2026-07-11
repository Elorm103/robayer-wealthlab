/**
 * Selects a PaymentProvider implementation by env.PAYMENT_PROVIDER —
 * the one place this project decides which provider is active. Adding
 * a second provider means adding one more file in this folder and one
 * more case below, not touching commerceService.ts or any route — see
 * docs/commerce-foundation.md's "Payment provider abstraction."
 */

import type { Env } from '../../worker/env';
import type { PaymentProvider } from './types';
import { paystackProvider } from './paystackProvider';

export type {
  PaymentProvider,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResult,
  VerifyPaymentResult,
  RefundResult,
} from './types';

export function getPaymentProvider(env: Env): PaymentProvider {
  switch (env.PAYMENT_PROVIDER) {
    case 'paystack':
      return paystackProvider;
    default:
      // A misconfigured PAYMENT_PROVIDER is a deployment error, not a
      // request-time one — thrown here rather than returned as an API
      // error code, and caught by the Worker's top-level error handler
      // (backend/middleware/errorHandler.ts) like any other unexpected
      // failure.
      throw new Error(`Unknown PAYMENT_PROVIDER: "${env.PAYMENT_PROVIDER}"`);
  }
}
