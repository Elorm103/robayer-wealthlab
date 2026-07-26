/**
 * POST /api/customer/reconcile-purchases — Version 3.3 Milestone M5C
 * Phase 2 (Activation, Analytics and Customer Reconciliation). See
 * docs/v3.3-m5c-customer-reconciliation-architecture.md.
 *
 * Thin HTTP layer only, per this project's established routes/
 * convention: parses the request, calls
 * services/customer/reconciliationService.ts for all real logic,
 * formats the response via the standard envelope. Never touches D1
 * directly.
 *
 * Deliberately unauthenticated (there is no session yet — that's the
 * whole point) and deliberately no-enumeration, replicating
 * routes/customer/auth.ts's handleCustomerForgotPassword() exactly:
 * the identical generic `jsonSuccess({requested: true})` response is
 * returned whether or not the submitted email had any unclaimed
 * purchase behind it, including under rate-limiting.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { reconcilePurchases } from '../../services/customer/reconciliationService';

// Same reasoning as auth.ts's FORGOT_PASSWORD_RATE_LIMIT — an
// unauthenticated endpoint that sends real email to a real inbox is
// itself a spam/harassment vector even without any credential risk.
const RECONCILE_RATE_LIMIT = { endpoint: 'customer-reconcile-purchases', limit: 3, windowSeconds: 15 * 60 };

/** Same reasoning as routes/customer/auth.ts's withNoStore(). */
function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  headers.set('Pragma', 'no-cache');
  return new Response(response.body, { status: response.status, headers });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

export async function handleCustomerReconcilePurchases(request: Request, env: Env, logger: Logger): Promise<Response> {
  if (await isRateLimited(request, env, RECONCILE_RATE_LIMIT)) {
    // Still the identical generic response — no enumeration signal
    // leaks through rate-limiting either, matching handleCustomerForgotPassword().
    return withNoStore(jsonSuccess({ requested: true }));
  }

  const body = await readJsonBody(request);
  if (body) {
    await reconcilePurchases(env, logger, body.email, env.SITE_BASE_URL);
  }

  return withNoStore(jsonSuccess({ requested: true }));
}
