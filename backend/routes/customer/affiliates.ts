/**
 * /api/customer/affiliates/*: the affiliate-facing surface. Every
 * route here scopes by the authenticated affiliate's own id, exactly
 * matching routes/customer/purchases.ts's own "own-data-only" pattern,
 * never a client-supplied affiliate id. Mutating routes require
 * requireCustomerCsrf(), matching every other authenticated customer
 * route.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { isRateLimited } from '../../middleware/rateLimit';
import { requireCustomerAuth } from '../../middleware/requireCustomerAuth';
import { requireCustomerCsrf } from '../../middleware/customerCsrf';
import { requireAffiliateAuth, requireApprovedAffiliate } from '../../middleware/requireAffiliateAuth';
import { applyForAffiliate, CURRENT_AFFILIATE_TERMS_VERSION } from '../../services/affiliateService';
import { getAffiliateOverview, listCommissionsForAffiliate } from '../../services/affiliateCommissionService';
import { requestPayout, listPayoutsForAffiliate, MIN_PAYOUT_PESEWAS } from '../../services/affiliatePayoutService';
import { listPublishedResources } from '../../services/affiliateResourceService';

const READ_RATE_LIMIT = { endpoint: 'customer-affiliate-read', limit: 60, windowSeconds: 60 };
const WRITE_RATE_LIMIT = { endpoint: 'customer-affiliate-write', limit: 10, windowSeconds: 60 };

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  return new Response(response.body, { status: response.status, headers });
}

/** GET /api/customer/affiliates/me: current application/affiliate status; 404 (AFFILIATE_NOT_FOUND) if this customer has never applied. */
export async function handleGetMyAffiliateProfile(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAffiliateAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));

  const { affiliate } = auth.auth;
  return withNoStore(
    jsonSuccess({
      status: affiliate.status,
      affiliateCode: affiliate.status === 'approved' ? affiliate.affiliateCode : null,
      appliedAt: affiliate.appliedAt,
      decidedAt: affiliate.decidedAt,
      rejectionReason: affiliate.rejectionReason,
      suspendedReason: affiliate.suspendedReason,
      payoutMethod: affiliate.payoutMethod,
    })
  );
}

/** POST /api/customer/affiliates/apply: { termsAccepted: true } required, same zero-form-checkout-style consent capture as checkout's own termsAccepted. */
export async function handleApplyForAffiliate(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireCustomerAuth(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);
  const csrfFailure = await requireCustomerCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return withNoStore(csrfFailure);
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withNoStore(jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.'));
  }
  const { termsAccepted } = (body as { termsAccepted?: unknown }) ?? {};
  if (termsAccepted !== true) {
    return withNoStore(jsonError('CONSENT_REQUIRED', 'Please accept the Affiliate Programme Terms to continue.'));
  }

  const result = await applyForAffiliate(env, logger, auth.auth.customerId, auth.auth.email);
  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      already_pending: 'Your affiliate application is already awaiting review.',
      already_approved: "You're already an approved affiliate.",
      suspended: 'Your affiliate account is currently suspended. Please contact support.',
    };
    return withNoStore(jsonError('ALREADY_AFFILIATE', messages[result.reason]));
  }

  return withNoStore(jsonSuccess({ status: result.status, termsVersion: CURRENT_AFFILIATE_TERMS_VERSION }));
}

/** GET /api/customer/affiliates/overview: KPI summary for the dashboard. Requires 'approved'. */
export async function handleGetAffiliateOverview(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireApprovedAffiliate(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));

  const overview = await getAffiliateOverview(env, auth.auth.affiliate.id);
  return withNoStore(
    jsonSuccess({ ...overview, affiliateCode: auth.auth.affiliate.affiliateCode, defaultCommissionPercent: auth.auth.affiliate.defaultCommissionPercent })
  );
}

/** GET /api/customer/affiliates/commissions?page=&pageSize=: commission history, own data only. */
export async function handleListMyCommissions(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireApprovedAffiliate(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '20', 10) || 20));

  const result = await listCommissionsForAffiliate(env, auth.auth.affiliate.id, page, pageSize);
  return withNoStore(jsonSuccess(result));
}

/** GET /api/customer/affiliates/payouts: payout history, own data only. */
export async function handleListMyPayouts(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireApprovedAffiliate(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));

  const payouts = await listPayoutsForAffiliate(env, auth.auth.affiliate.id);
  return withNoStore(jsonSuccess({ payouts, minPayoutPesewas: MIN_PAYOUT_PESEWAS }));
}

/** POST /api/customer/affiliates/payout-details: { method, details } sets where a future payout should be sent. Stores a reference/last-4 only, never a full account number; the field is free text; the admin UI and this route's own validation keep it short, the actual "don't put a full PAN in here" discipline is a UX/policy matter, not a technical redaction this route can enforce. */
export async function handleSetPayoutDetails(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireApprovedAffiliate(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);
  const csrfFailure = await requireCustomerCsrf(request, env, logger, auth.auth.customer);
  if (csrfFailure) return withNoStore(csrfFailure);
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withNoStore(jsonError('VALIDATION_ERROR', 'Request body must be valid JSON.'));
  }
  const { method, details } = (body as { method?: unknown; details?: unknown }) ?? {};
  if (method !== 'mobile_money' && method !== 'bank_transfer') {
    return withNoStore(jsonError('VALIDATION_ERROR', 'A valid payout method is required.'));
  }
  if (typeof details !== 'string' || details.trim().length === 0 || details.length > 200) {
    return withNoStore(jsonError('VALIDATION_ERROR', 'Payout details are required (max 200 characters).'));
  }

  await env.DB.prepare(`UPDATE affiliates SET payout_method = ?, payout_details = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(method, details.trim(), auth.auth.affiliate.id)
    .run();

  return withNoStore(jsonSuccess({ ok: true }));
}

/** POST /api/customer/affiliates/payouts/request: requests a payout for the entire current payable balance. */
export async function handleRequestPayout(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireApprovedAffiliate(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);
  const csrfFailure = await requireCustomerCsrf(request, env, logger, auth.auth.customer);
  if (csrfFailure) return withNoStore(csrfFailure);
  if (await isRateLimited(request, env, WRITE_RATE_LIMIT)) return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));

  const result = await requestPayout(env, logger, auth.auth.affiliate.id);
  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      below_threshold: `Your payable balance must reach at least GH₵${(MIN_PAYOUT_PESEWAS / 100).toFixed(2)} before you can request a payout.`,
      no_payout_method: 'Please add your payout details before requesting a payout.',
      no_payable_balance: "You don't have a payable balance right now.",
    };
    return withNoStore(jsonError('PAYOUT_BELOW_THRESHOLD', messages[result.reason]));
  }

  return withNoStore(jsonSuccess({ payoutId: result.payoutId, amountPesewas: result.amountPesewas }));
}

/** GET /api/customer/affiliates/resources: the marketing-resource centre; published items only. */
export async function handleListAffiliateResources(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireApprovedAffiliate(request, env, logger);
  if (!auth.ok) return withNoStore(auth.response);
  if (await isRateLimited(request, env, READ_RATE_LIMIT)) return withNoStore(jsonError('RATE_LIMITED', 'Too many requests. Please try again shortly.'));

  const resources = await listPublishedResources(env);
  return withNoStore(jsonSuccess({ resources }));
}
