/**
 * Builds the one URL every customer-facing purchase link on this site
 * points to (checkout/callback/index.html) — Paystack's callback_url,
 * the zero-value-coupon checkout result, the post-purchase
 * `secure-download` email, the admin "resend download" action, and the
 * automated purchase-followup reminder all mint this same shape.
 *
 * Security remediation (Critical Finding C1, security audit
 * 2026-09-15): centralized here specifically so every one of those
 * five call sites carries the high-entropy `t` param automatically —
 * a hand-rolled template literal at each site is exactly how one of
 * them could quietly regress back to the reference-only, guessable
 * link this fix closes. `accessToken` is `null` only for a purchase
 * that predates migration 0061 (see that migration's own header
 * comment); the resulting link is then reference-only, matching
 * exactly what that purchase's original email already contained.
 */
export function buildFulfilmentUrl(siteBaseUrl: string, purchaseReference: string, accessToken: string | null): string {
  const params = new URLSearchParams({ ref: purchaseReference });
  if (accessToken) params.set('t', accessToken);
  return `${siteBaseUrl}/checkout/callback/?${params.toString()}`;
}
