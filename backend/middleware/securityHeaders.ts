/**
 * Baseline HTTP security headers — applied to every response this
 * Worker returns, success or error, JSON or binary file. Added during
 * the Version 1.0 Launch Readiness pass (see docs/launch-readiness.md
 * and docs/platform-review-v1.md's "Security headers" finding, which
 * this file resolves).
 *
 * Was deliberately kept as its own file, separate from the former
 * `middleware/cors.ts` (removed in the Version 2.0 Same-Origin Migration
 * — see docs/v2-same-origin-migration-audit.md) rather than folded into
 * it, so this pass had no reason to touch that file. `worker/index.ts`
 * applies this same composable `withXyz(response, env)` wrapper pattern
 * to every response.
 *
 * Every header below is scoped to what's actually appropriate for a
 * JSON/binary API with no HTML rendering surface of its own — this is
 * not a copy-pasted "best practices" header block. See each header's
 * own comment for the specific reasoning.
 */

import type { Env } from '../worker/env';

function securityHeaders(): Record<string, string> {
  return {
    // This Worker never serves HTML, CSS, or JavaScript to be
    // executed — every legitimate response is either a JSON envelope
    // or a binary file download (GET /api/download/:token). `'none'`
    // is correct, not merely restrictive-by-default: there is no
    // route where loosening this would ever be needed. frame-ancestors
    // 'none' additionally covers the (already syntactically distinct)
    // clickjacking protection X-Frame-Options provides below — kept
    // as two headers for the widest browser compatibility, not
    // because they protect against different things.
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",

    // Belt-and-braces alongside the CSP frame-ancestors directive
    // above — some older browsers only honor this one, not CSP.
    'X-Frame-Options': 'DENY',

    // Prevents a browser from ever guessing a response's content type
    // from its body instead of trusting the Content-Type header this
    // Worker actually sets — relevant specifically for
    // GET /api/download/:token, whose response is a file whose type
    // comes from asset.fileType, not from sniffing.
    'X-Content-Type-Options': 'nosniff',

    // No page on this API ever needs another site's referrer
    // information, and this API's own URLs (e.g. a purchase reference
    // in a query string, or a signed download link) should never leak
    // into a third party's server logs via an outbound link from a
    // response this Worker returns. This Worker never returns HTML
    // with outbound links, so this header is defense-in-depth rather
    // than a live requirement — cheap enough to set anyway.
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    // This API grants itself none of these browser features (it isn't
    // a page a browser renders) and explicitly disclaims them so nothing
    // downstream (a proxy, a future embedded use) can assume otherwise.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',

    // Cloudflare Workers are HTTPS-only by construction (no plaintext
    // HTTP listener exists to downgrade to), so this header only ever
    // reinforces behavior that's already guaranteed — but instructing
    // browsers to remember that and never even attempt an HTTP request
    // to this origin is a real, standard hardening step with no
    // downside. `includeSubDomains` extends the same guarantee to any
    // future subdomain of wherever this Worker is actually deployed
    // (e.g. a future api.robayerwealthlab.com); `preload` is
    // deliberately omitted — submitting to the HSTS preload list is a
    // separate, harder-to-reverse decision the domain owner should
    // make explicitly once the production domain is finalized, not
    // something this Worker should default into.
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };
}

/** Adds baseline security headers to an already-built response, without altering its body or status. */
export function withSecurityHeaders(response: Response, _env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}
