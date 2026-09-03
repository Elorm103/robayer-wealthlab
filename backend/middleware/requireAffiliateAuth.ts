/**
 * Affiliate authorization: layers on top of requireCustomerAuth(),
 * never a second session/auth system (see affiliateService.ts's own
 * header comment). Confirms the authenticated customer has an
 * `affiliates` row and, for routes that need it, that it is currently
 * 'approved' (an unapproved affiliate can log in and see their own
 * application status but nothing else, matching the same
 * must_change_password-style restricted-view gate already established
 * in requireAuth.ts).
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { requireCustomerAuth, type CustomerAuthContext } from './requireCustomerAuth';
import { getAffiliateByCustomerId, type AffiliateProfile } from '../services/affiliateService';
import { jsonError } from '../utils/responses';

export interface AffiliateAuthContext {
  customer: CustomerAuthContext;
  affiliate: AffiliateProfile;
}

export type RequireAffiliateAuthResult = { ok: true; auth: AffiliateAuthContext } | { ok: false; response: Response };

/** Requires a logged-in customer who has SOME affiliate row (any status), used by the "my application status" read and by requireApprovedAffiliate below. */
export async function requireAffiliateAuth(request: Request, env: Env, logger: Logger): Promise<RequireAffiliateAuthResult> {
  const customerAuth = await requireCustomerAuth(request, env, logger);
  if (!customerAuth.ok) return { ok: false, response: customerAuth.response };

  const affiliate = await getAffiliateByCustomerId(env, customerAuth.auth.customerId);
  if (!affiliate) return { ok: false, response: jsonError('AFFILIATE_NOT_FOUND', 'No affiliate application found for this account.') };

  return { ok: true, auth: { customer: customerAuth.auth, affiliate } };
}

/** Requires status === 'approved'; every route that generates links, records real dashboard data, or requests a payout uses this, never requireAffiliateAuth() alone. */
export async function requireApprovedAffiliate(request: Request, env: Env, logger: Logger): Promise<RequireAffiliateAuthResult> {
  const result = await requireAffiliateAuth(request, env, logger);
  if (!result.ok) return result;
  if (result.auth.affiliate.status === 'suspended') return { ok: false, response: jsonError('AFFILIATE_SUSPENDED', 'Your affiliate account is currently suspended.') };
  if (result.auth.affiliate.status !== 'approved') return { ok: false, response: jsonError('AFFILIATE_NOT_APPROVED', 'Your affiliate application has not been approved yet.') };
  return result;
}
