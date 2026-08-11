/**
 * Analytics/Conversion Provider Abstraction — Version 5.0 (Customer
 * Acquisition Phase 1). Mirrors services/payments/types.ts's own
 * provider-abstraction shape exactly: every ad-platform integration
 * this project ever adds (Meta today; Google/TikTok/etc. later, per
 * docs/v5.0-analytics-architecture.md §3) implements this one
 * interface. `conversionDispatchService.ts` (the only caller) depends
 * on `AnalyticsProvider`, never on a specific platform's API shape
 * directly — adding a second provider means one more file in this
 * folder and one more entry in `index.ts`'s registry, not touching
 * `conversionDispatchService.ts`, `commerceService.ts`, or any route.
 *
 * Deliberately a fan-out registry (`getAnalyticsProviders()` returns
 * an array), not a single-active-provider selector like
 * `getPaymentProvider()` — Meta's own best practice is Pixel + CAPI
 * running *alongside* other ad platforms simultaneously, not instead
 * of them (see the architecture doc's "one dispatch service, not
 * five").
 */

import type { Env } from '../../worker/env';

/** Meta's own standard-event vocabulary this project fires, plus this project's custom events (Phase 6) — kept here, not per-provider, since every provider adapter receives the same logical event name and maps it onto its own vocabulary if needed. */
export type ConversionEventName =
  | 'Purchase'
  | 'Lead'
  | 'InitiateCheckout'
  | 'ViewContent'
  | 'PageView'
  | 'AskAI'
  | 'CouponApplied'
  | 'BookPreview'
  | 'SearchKnowledgeBase'
  | (string & {}); // extensible: a future book/course event needs no change here

export interface ConversionUserData {
  /**
   * Already SHA-256 hashed (services/analytics/hashing.ts's
   * hashEmail()) — hashing happens exactly once, in
   * conversionDispatchService.ts, before any provider or the
   * analytics_conversion_log row ever sees it. Raw email is never
   * threaded this far, and never persisted — both a Phase 9 privacy
   * requirement and what makes a later retry safe: reconstructing a
   * retry from a logged row never needs raw PII again.
   */
  emailHash?: string | null;
  /** Event Match Quality — already SHA-256 hashed (hashing.ts's hashExternalId()), same discipline as emailHash above. This project's own numeric customers.id, never a client-supplied value. */
  externalIdHash?: string | null;
  /** Event Match Quality — Meta's own documented spec: never hashed. Read from the real customer request at checkout time (see migration 0041's header comment). */
  clientIpAddress?: string | null;
  /** Event Match Quality — never hashed. See clientIpAddress above. */
  clientUserAgent?: string | null;
  /** Event Match Quality — Meta's own first-party click-id cookie, never hashed. See clientIpAddress above. */
  fbc?: string | null;
  /** Event Match Quality — Meta's own first-party browser-id cookie, never hashed. See clientIpAddress above. */
  fbp?: string | null;
}

export interface ServerEventInput {
  eventName: ConversionEventName;
  /** Shared with the browser pixel's fire for the same logical event — see migration 0040's header comment on Meta's event-deduplication mechanism. */
  eventId: string;
  /** The page the action happened on, e.g. the fulfilment/callback URL for a Purchase — Meta's `event_source_url`. */
  eventSourceUrl: string;
  userData: ConversionUserData;
  /** Provider-agnostic key/value payload — e.g. { value, currency, content_ids, content_name, transaction_id, coupon } for a Purchase. Each adapter maps these onto its own field names. */
  customData: Record<string, string | number | string[] | null | undefined>;
}

export interface ServerEventResult {
  ok: boolean;
  /** HTTP status from the provider's own API, for logging — 0 if the request never reached the network (e.g. a fetch() throw). */
  status: number;
  /** Raw response body, truncated by the caller before logging — never re-parsed here. */
  body: string;
  /** The provider's own trace/debug id, if its response includes one (e.g. Meta's fbtrace_id) — mirrors email_log's provider_id. */
  traceId?: string;
}

export interface AnalyticsProvider {
  /** 'meta' today — the value stored in analytics_conversion_log.provider. */
  name: string;
  /** True only when this provider has everything it needs configured (Pixel ID + access token) — conversionDispatchService.ts skips (never errors) a provider that isn't configured, matching AI_PROMPT_ENCRYPTION_KEY's own "absent means unavailable, never a fallback to something worse" convention. */
  isConfigured(env: Env): boolean;
  sendServerEvent(input: ServerEventInput, env: Env): Promise<ServerEventResult>;
}
