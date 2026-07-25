/**
 * CSRF protection for customer mutations — Version 3.0.2 Milestone M1.
 * Direct mirror of `middleware/csrf.ts` (see that file's own header
 * comment for the full double-submit-cookie reasoning) — applied after
 * `requireCustomerAuth` succeeds, to `POST /api/customer/auth/logout`
 * (the only authenticated, state-changing customer route in M1).
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import type { CustomerAuthContext } from './requireCustomerAuth';
import { jsonError } from '../utils/responses';

export const CSRF_HEADER_NAME = 'X-Customer-CSRF-Token';

export async function requireCustomerCsrf(request: Request, _env: Env, _logger: Logger, auth: CustomerAuthContext): Promise<Response | null> {
  const header = request.headers.get(CSRF_HEADER_NAME);
  if (!header || !constantTimeEqual(header, auth.csrfSecret)) {
    return jsonError('FORBIDDEN', 'Request could not be verified. Please refresh and try again.');
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
