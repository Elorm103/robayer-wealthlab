/**
 * The Worker's environment bindings, declared once here (rather than
 * inline in index.ts) so middleware/ and services/ can import the same
 * `Env` type without importing index.ts itself and risking a circular
 * import back into the entry point.
 *
 * Must match ../wrangler.jsonc's d1_databases/r2_buckets/kv_namespaces/
 * vars bindings exactly.
 */
export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  RATE_LIMIT_KV: KVNamespace;
  ALLOWED_ORIGIN: string;
  RESEND_API_KEY: string;
  // Added in Version 1.2 Sprint 2.3 (Commerce Foundation) — see
  // docs/commerce-foundation.md.
  /**
   * Where the live static site (and therefore content/products/*.json,
   * the Product Platform's source of truth) is publicly served. The
   * Commerce Service fetches product data from here rather than from
   * any D1 table — see docs/commerce-foundation.md's "Where product
   * data comes from." Distinct from ALLOWED_ORIGIN (a CORS setting)
   * even though both currently hold the same value — different
   * concerns that happen to coincide today.
   */
  SITE_BASE_URL: string;
  /** Selects a backend/services/payments/ implementation — see that folder's PaymentProvider abstraction. Only "paystack" exists today. */
  PAYMENT_PROVIDER: string;
  /** Secret — set via `wrangler secret put`, never committed. Used server-side only; the frontend never sees this. */
  PAYSTACK_SECRET_KEY: string;
  /** Non-secret. Unused by createCheckoutSession() today (the Standard/Redirect flow only needs the secret key) — reserved for a possible future client-side Paystack.js integration. */
  PAYSTACK_PUBLIC_KEY: string;
  /** e.g. "https://api.paystack.co" — kept configurable rather than hardcoded so a test/sandbox base URL can be swapped in per environment. */
  PAYSTACK_BASE_URL: string;
  // No separate webhook secret: Version 1.2 Sprint 2.4 (Payment
  // Verification) verifies the `x-paystack-signature` header using
  // this same PAYSTACK_SECRET_KEY — see backend/utils/webhookSignature.ts
  // and docs/payment-verification.md's "Webhook security" for why.
  // Unlike some providers (e.g. Stripe), Paystack does not issue a
  // separate per-endpoint webhook signing secret; it signs webhooks
  // with the account's own secret key. This corrects an earlier,
  // pre-Sprint-2.4 assumption in docs/backend-security.md and
  // backend/config/README.md that a distinct PAYSTACK_WEBHOOK_SECRET
  // would exist — see docs/payment-verification.md's "Known
  // limitations" for the confidence caveat (unverified against a live
  // Paystack account).
}
