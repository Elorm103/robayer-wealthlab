/**
 * KV-based fixed-window rate limiting, per docs/backend-security.md:
 * a counter keyed `ratelimit:{endpoint}:{ip}`, incremented per request
 * with a TTL matching the window. IP comes from `CF-Connecting-IP`,
 * set by Cloudflare's edge itself — not a client-supplied header, so
 * it can't be spoofed by the request's sender.
 *
 * This is a simple fixed-window counter, not a perfectly atomic one —
 * two requests arriving in the same instant could both read the same
 * pre-increment count before either write lands. Acceptable at this
 * project's realistic form-submission volume (docs/backend-security.md
 * calls for "a few requests per minute per IP," not a hard security
 * boundary); worth revisiting only if abuse at this exact race is
 * ever actually observed.
 *
 * Production incident (2026-08-26): RATE_LIMIT_KV hit Cloudflare's
 * daily KV write-quota, and every `.get()`/`.put()` here started
 * throwing. Every caller (checkout, analytics, contact, newsletter,
 * ~39 route files) uses the identical `if (await isRateLimited(...))`
 * pattern with no try/catch of its own, so the thrown error propagated
 * up through the route handler to worker/index.ts's top-level
 * `withErrorHandling()` and came back as a real 500 — meaning a KV
 * infrastructure quota problem could crash checkout for a real
 * customer. Fixed below: KV failures are now caught HERE, once, so
 * every one of those ~39 call sites is protected without being
 * touched individually (this project's own "narrow, callers stay
 * blind to it" pattern, matching computeAttributionConfidence()'s
 * doc comment elsewhere in this codebase for the same shape of
 * reasoning). The failure mode is now: rate-limited-for-real (KV read
 * succeeded, count is at or over limit) is UNCHANGED and still blocks
 * the request; only a genuine KV read/write error, distinguished
 * explicitly by the try/catch below, ever falls back — and even then,
 * `isFallbackLimited()`'s in-memory counter keeps some coarse
 * protection in place rather than silently admitting every request
 * unconditionally. Every fallback path logs a structured `warn` so a
 * recurrence is visible in `wrangler tail` / the log viewer, distinct
 * from an ordinary `RATE_LIMITED` response.
 */

import type { Env } from '../worker/env';
import { createLogger } from '../utils/logger';

export interface RateLimitOptions {
  /** Distinguishes one endpoint's counters from another's, e.g. "newsletter". */
  endpoint: string;
  /** Max requests allowed from the same IP within windowSeconds. */
  limit: number;
  windowSeconds: number;
}

/**
 * Coarse, best-effort backstop used ONLY while RATE_LIMIT_KV itself is
 * failing (see the file header comment). Deliberately module-scope,
 * mutable state — not the "leaked per-request data" anti-pattern a
 * bare module-level variable usually signals, but the same kind of
 * intentional, key-scoped, cross-request counter KV itself provides;
 * this is just an in-memory stand-in for the one window while KV is
 * down. It is NOT equivalent to the real limiter: it resets whenever
 * this isolate recycles, and it is never shared across Cloudflare's
 * many edge locations, so a determined abuser spread across enough
 * colos/isolates could still slip past it. Its only job is to make
 * sure a KV outage degrades to "coarser, isolate-local throttling,"
 * never to "zero throttling at all." IP already comes from
 * Cloudflare's own `CF-Connecting-IP` (not client-spoofable, per this
 * file's own header comment), so this Map can only grow as large as
 * the number of distinct real source IPs one isolate actually sees
 * during a KV outage — bounded in practice by real traffic, not by an
 * attacker's choice of fake keys.
 */
const fallbackCounters = new Map<string, { count: number; resetAt: number }>();

/**
 * How much more permissive the in-memory fallback is than the real
 * per-endpoint limit. Deliberately generous: this backstop's job is to
 * blunt a genuine abuse burst during a KV outage, not to be the layer
 * that ever makes a real single customer's real checkout retry fail —
 * that would trade one production incident for another. 3x the
 * configured limit is comfortably above anything a legitimate visitor
 * would trigger (e.g. checkout's own 10/60s becomes 30/60s per IP
 * during an outage) while still cutting off a true flood.
 */
const FALLBACK_LIMIT_MULTIPLIER = 3;

function isFallbackLimited(key: string, limit: number, windowSeconds: number): boolean {
  const now = Date.now();
  const entry = fallbackCounters.get(key);
  if (!entry || entry.resetAt <= now) {
    fallbackCounters.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > limit * FALLBACK_LIMIT_MULTIPLIER;
}

/** Not request-bound (rateLimit.ts's own callers don't all thread a Logger through), so this doesn't share the calling request's requestId — still a structured, `wrangler tail`-filterable line via `route`/`message`/`level`, per utils/logger.ts's own convention. */
function logKvFailure(operation: 'get' | 'put', endpoint: string, err: unknown): void {
  const logger = createLogger('n/a', `rate-limit:${endpoint}`);
  logger.warn('rate_limit.kv_unavailable', {
    operation,
    endpoint,
    error: err instanceof Error ? err.message : String(err),
  });
}

export async function isRateLimited(
  request: Request,
  env: Env,
  options: RateLimitOptions
): Promise<boolean> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const key = `ratelimit:${options.endpoint}:${ip}`;

  let current: string | null;
  try {
    current = await env.RATE_LIMIT_KV.get(key);
  } catch (err) {
    // KV itself is unavailable (quota exhaustion, transient error) —
    // we have no real count to check, so fall back to the coarse
    // in-memory backstop rather than either crashing the request or
    // admitting it with zero throttling at all.
    logKvFailure('get', options.endpoint, err);
    return isFallbackLimited(key, options.limit, options.windowSeconds);
  }

  const count = current ? parseInt(current, 10) : 0;

  if (count >= options.limit) {
    // A real, KV-confirmed over-limit request — unaffected by any of
    // the fallback logic above or below; this is the ordinary,
    // unchanged rate-limited path.
    return true;
  }

  try {
    await env.RATE_LIMIT_KV.put(key, String(count + 1), {
      expirationTtl: options.windowSeconds,
    });
  } catch (err) {
    // The GET above already proved this specific request is under the
    // real limit, so it's still allowed through either way — but the
    // increment failed to persist, meaning the NEXT request on this
    // key can't rely on an accurate KV count either. Warm the
    // in-memory backstop now (ignoring its return value: this
    // request already earned a "not limited" from real KV data) so a
    // persisting outage still has SOME counter state for the requests
    // right after this one.
    logKvFailure('put', options.endpoint, err);
    isFallbackLimited(key, options.limit, options.windowSeconds);
  }
  return false;
}
