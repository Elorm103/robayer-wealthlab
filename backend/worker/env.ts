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
  RESEND_API_KEY: string;
  // Added in Version 1.2 Sprint 2.3 (Commerce Foundation) — see
  // docs/commerce-foundation.md.
  /**
   * Where the live static site (and therefore content/products/*.json,
   * the Product Platform's source of truth) is publicly served. The
   * Commerce Service fetches product data from here rather than from
   * any D1 table — see docs/commerce-foundation.md's "Where product
   * data comes from." A server-side fetch *by* this Worker, unrelated
   * to the same-origin routing the frontend itself uses to call this
   * Worker — different relationship entirely.
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

  // Added in Version 2.1 Phase 5 (Settings) — see
  // docs/v2.1-phase5-design.md Section 6. Cloudflare Workers has no
  // built-in way to introspect its own deployed git commit or deploy
  // time at runtime, so these are passed as ad-hoc, non-secret var
  // overrides at deploy time (`wrangler deploy --var DEPLOYED_COMMIT:...
  // --var DEPLOYED_AT:...`), not stored in wrangler.jsonc (they'd be
  // stale the moment they were committed). Optional: a deploy that
  // omits these flags leaves them undefined, and the Settings page
  // reports "Not available" honestly rather than a stale or
  // fabricated value.
  DEPLOYED_COMMIT?: string;
  DEPLOYED_AT?: string;
}
