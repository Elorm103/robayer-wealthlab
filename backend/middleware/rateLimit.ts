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
 */

import type { Env } from '../worker/env';

export interface RateLimitOptions {
  /** Distinguishes one endpoint's counters from another's, e.g. "newsletter". */
  endpoint: string;
  /** Max requests allowed from the same IP within windowSeconds. */
  limit: number;
  windowSeconds: number;
}

export async function isRateLimited(
  request: Request,
  env: Env,
  options: RateLimitOptions
): Promise<boolean> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const key = `ratelimit:${options.endpoint}:${ip}`;

  const current = await env.RATE_LIMIT_KV.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= options.limit) {
    return true;
  }

  await env.RATE_LIMIT_KV.put(key, String(count + 1), {
    expirationTtl: options.windowSeconds,
  });
  return false;
}
