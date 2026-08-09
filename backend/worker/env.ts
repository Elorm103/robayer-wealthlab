/**
 * The Worker's environment bindings, declared once here (rather than
 * inline in index.ts) so middleware/ and services/ can import the same
 * `Env` type without importing index.ts itself and risking a circular
 * import back into the entry point.
 *
 * Must match ../wrangler.jsonc's d1_databases/r2_buckets/kv_namespaces/
 * vars bindings exactly.
 */
import type { KnowledgeIndexQueueMessage } from '../services/knowledge/queueTypes';

export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  RATE_LIMIT_KV: KVNamespace;
  RESEND_API_KEY: string;
  /** e.g. "https://api.resend.com" — kept configurable rather than hardcoded, same reasoning as PAYSTACK_BASE_URL below. In production this is always the real Resend URL; tests intercept it via tests/outboundMock.ts's outboundService rather than overriding this binding. */
  RESEND_BASE_URL: string;
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

  // Added in Version 5.0 Milestone 1 (AI Gateway Foundation) — see
  // docs/v5.0-ai-gateway.md. OPENAI_API_KEY is a genuine secret (set via
  // `wrangler secret put`, never here); OPENAI_BASE_URL is not secret,
  // same reasoning as PAYSTACK_BASE_URL/RESEND_BASE_URL above — kept
  // configurable rather than hardcoded so tests can intercept it via
  // tests/outboundMock.ts's outboundService without touching this
  // binding.
  /** Secret — set via `wrangler secret put OPENAI_API_KEY`, never committed. Used server-side only, exclusively by services/ai/providers/openAiProvider.ts — never read anywhere else. */
  OPENAI_API_KEY: string;
  /** e.g. "https://api.openai.com" */
  OPENAI_BASE_URL: string;

  // Added in Version 5.0 Milestone 1.2 (AI Governance & Safety) — see
  // services/ai/promptEncryption.ts. Optional (not every deployment
  // needs encrypted prompt/response storage — the default retention
  // mode, 'metadata_only', never needs this key at all): a base64-
  // encoded 256-bit AES key, set via
  // `wrangler secret put AI_PROMPT_ENCRYPTION_KEY`. Absent or
  // malformed is treated as "encryption unavailable," never as a
  // reason to fall back to storing plaintext.
  /** Secret, optional — set via `wrangler secret put AI_PROMPT_ENCRYPTION_KEY`, never committed. Used server-side only, exclusively by services/ai/promptEncryption.ts. */
  AI_PROMPT_ENCRYPTION_KEY?: string;

  // Added in Version 5.0 Milestone 2 (Knowledge Base) — see
  // wrangler.jsonc's own "vectorize" binding comment for the full
  // reasoning. Stores chunk embeddings only; chunk text/metadata lives
  // in D1 (knowledge_chunks).
  KNOWLEDGE_INDEX: VectorizeIndex;

  // Added in Version 5.0 Milestone 2.1 — see wrangler.jsonc's own
  // "queues" binding comment for why: production's first full rebuild
  // proved a single-invocation indexing design does not scale past a
  // few dozen documents, since D1/Vectorize binding calls count against
  // the same per-invocation subrequest budget as fetch(). Each queue
  // consumer invocation gets its own fresh subrequest budget, which is
  // what actually makes this scale.
  KNOWLEDGE_INDEX_QUEUE: Queue<KnowledgeIndexQueueMessage>;

  // Added in Version 5.0 (Customer Acquisition Phase 1) — see
  // services/analytics/'s AnalyticsProvider abstraction and
  // docs/v5.0-analytics-architecture.md. META_PIXEL_ID is non-secret
  // (the Pixel ID is publicly visible in every page's own network
  // requests once the browser pixel loads — same reasoning as
  // PAYSTACK_PUBLIC_KEY) and doubles as part of the Conversions API
  // URL path (`/{pixel-id}/events`), so the backend needs it too, not
  // just the frontend (which reads its own copy from
  // assets/config/site.json — see js/main.js's loadMetaPixel()).
  /** Non-secret — also embedded in assets/config/site.json for the browser pixel. Real value: the Meta Events Manager Dataset/Pixel ID. */
  META_PIXEL_ID?: string;
  /** Secret — set via `wrangler secret put META_CAPI_ACCESS_TOKEN`, never committed. Used server-side only, exclusively by services/analytics/metaProvider.ts. Absent means Meta's provider.isConfigured() returns false and every dispatch is skipped, never faked. */
  META_CAPI_ACCESS_TOKEN?: string;
  /** e.g. "https://graph.facebook.com" — kept configurable rather than hardcoded, same reasoning as PAYSTACK_BASE_URL/OPENAI_BASE_URL above. */
  META_GRAPH_API_BASE_URL: string;
  /** e.g. "v21.0" — Meta's Graph API version segment, kept configurable so a version bump is a var change, not a code change. */
  META_GRAPH_API_VERSION: string;
  /** Secret-adjacent, optional — set only while verifying in Meta's Test Events tool (Phase 12); never set in real production traffic. Not a true secret (it doesn't grant access to anything) but kept out of wrangler.jsonc anyway since its presence changes real event routing — see docs/v5.0-analytics-architecture.md's "Configuration." */
  META_TEST_EVENT_CODE?: string;
}
