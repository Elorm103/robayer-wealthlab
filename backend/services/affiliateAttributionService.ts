/**
 * Affiliate Attribution Service: click recording and the last-click,
 * 30-day cookie model. See docs' architecture review (affiliate
 * ecosystem Phase 1 report) for the full model reasoning; this file is
 * the implementation of it.
 *
 * Two separate concerns, deliberately kept apart:
 *   1. recordClick(): durable click ledger (affiliate_clicks), fired
 *      from the public click-tracking endpoint on every visit that
 *      carries a `?ref=` parameter, regardless of whether that code
 *      ever converts.
 *   2. resolveAffiliateForCheckout(): reads the `rwl_ref` cookie (set
 *      by the same click-tracking endpoint) at checkout-session
 *      creation time and re-validates the affiliate is REAL and
 *      currently 'approved' (a cookie can outlive a later suspension/
 *      rejection, so this is checked fresh on every checkout, never
 *      trusted from whatever the cookie said when it was set).
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { getAffiliateByCode } from './affiliateService';

export const AFFILIATE_REF_COOKIE_NAME = 'rwl_ref';
export const AFFILIATE_ATTRIBUTION_WINDOW_SECONDS = 30 * 24 * 60 * 60; // 30 days

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export type ClickResult =
  | { recorded: true; affiliateCode: string; cookieValue: string }
  | { recorded: false; reason: 'invalid_code' | 'not_eligible' };

/**
 * The rwl_ref cookie's value is `CODE.ISSUED_AT_EPOCH_SECONDS`, not the
 * bare code. Max-Age alone only bounds a real browser's cookie jar; it
 * does nothing against a non-browser client that simply sends a fixed
 * `Cookie: rwl_ref=CODE` header on every request forever, which would
 * silently defeat the "30-day window" promise made on the public terms
 * page. Embedding the issue time lets resolveAffiliateForCheckout()
 * enforce the window itself, server-side, independent of what any
 * client claims about cookie freshness. `.` is a safe delimiter:
 * generateUniqueAffiliateCode() only ever produces [A-Za-z0-9].
 */
function buildCookieValue(code: string): string {
  return `${code}.${Math.floor(Date.now() / 1000)}`;
}

function parseCookieValue(raw: string): { code: string; issuedAtSeconds: number } | null {
  const idx = raw.lastIndexOf('.');
  if (idx <= 0 || idx === raw.length - 1) return null;
  const code = raw.slice(0, idx);
  const issuedAtSeconds = Number(raw.slice(idx + 1));
  if (!Number.isInteger(issuedAtSeconds) || issuedAtSeconds <= 0) return null;
  return { code, issuedAtSeconds };
}

/**
 * Validates the code is a real, currently-'approved' affiliate before
 * logging anything: a click against an unknown or not-yet-approved
 * code is deliberately NOT recorded (there is nothing legitimate to
 * attribute, and recording it would let anyone inflate an arbitrary
 * string's "click count" in the ledger). ipHash is SHA-256 of the raw
 * IP; the raw IP itself is never persisted, matching this project's
 * existing hash-not-store privacy posture (services/analytics/hashing.ts).
 */
export async function recordClick(
  env: Env,
  _logger: Logger,
  input: { codeInput: unknown; productSlug: string | null; landingPath: string; referrer: string | null; ip: string | null }
): Promise<ClickResult> {
  const affiliate = await getAffiliateByCode(env, input.codeInput);
  if (!affiliate) return { recorded: false, reason: 'invalid_code' };
  if (affiliate.status !== 'approved') return { recorded: false, reason: 'not_eligible' };

  const ipHash = await sha256Hex(input.ip ?? 'unknown');

  await env.DB.prepare(
    `INSERT INTO affiliate_clicks (affiliate_id, product_slug, landing_path, referrer, ip_hash, data_classification)
     VALUES (?, ?, ?, ?, ?, 'PRODUCTION')`
  )
    .bind(affiliate.id, input.productSlug, input.landingPath, input.referrer, ipHash)
    .run();

  return { recorded: true, affiliateCode: affiliate.affiliateCode, cookieValue: buildCookieValue(affiliate.affiliateCode) };
}

export type ResolveAttributionResult =
  | { attributed: true; affiliateId: number; commissionPercent: number }
  | { attributed: false; reason: 'no_ref' | 'invalid_code' | 'not_approved' | 'self_referral' | 'expired' };

/**
 * Called once, at checkout-session creation (services/commerceService.ts's
 * createCheckoutSession()); never re-resolved later, so the snapshot
 * taken here is what purchase_sessions.affiliate_id/
 * affiliate_commission_percent locks in.
 *
 * No `customers` row necessarily exists yet at this point (guest
 * checkout: the real customer identity is only resolved at payment
 * verification, see commerceService.ts's findOrCreateCustomer()), so
 * self-referral is checked here only as a best-effort match against
 * the checkout email the visitor just typed. This is NOT the
 * authoritative check: affiliateCommissionService.ts's
 * recordCommission() re-checks by the actual resolved customer_id at
 * verification time (the point a real identity exists) and is what
 * ultimately decides whether a commission is ever written.
 */
export async function resolveAffiliateForCheckout(env: Env, refCookieInput: unknown, productId: number, checkoutEmail: string): Promise<ResolveAttributionResult> {
  if (!refCookieInput || typeof refCookieInput !== 'string') return { attributed: false, reason: 'no_ref' };

  const parsed = parseCookieValue(refCookieInput);
  if (!parsed) return { attributed: false, reason: 'invalid_code' };

  const ageSeconds = Math.floor(Date.now() / 1000) - parsed.issuedAtSeconds;
  if (ageSeconds > AFFILIATE_ATTRIBUTION_WINDOW_SECONDS) {
    return { attributed: false, reason: 'expired' };
  }

  const affiliate = await getAffiliateByCode(env, parsed.code);
  if (!affiliate) return { attributed: false, reason: 'invalid_code' };
  if (affiliate.status !== 'approved') return { attributed: false, reason: 'not_approved' };

  const affiliateAccount = await env.DB.prepare(`SELECT email FROM customers WHERE id = ?`).bind(affiliate.customerId).first<{ email: string }>();
  if (affiliateAccount && affiliateAccount.email.toLowerCase() === checkoutEmail.toLowerCase()) {
    return { attributed: false, reason: 'self_referral' };
  }

  const { resolveCommissionPercent } = await import('./affiliateService');
  const commissionPercent = await resolveCommissionPercent(env, affiliate.id, productId);
  return { attributed: true, affiliateId: affiliate.id, commissionPercent };
}
