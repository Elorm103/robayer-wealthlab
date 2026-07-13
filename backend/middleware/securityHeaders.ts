/**
 * Baseline HTTP security headers — applied to every response this
 * Worker returns, success or error, JSON, binary file, or (since
 * Version 2.0 Phase 2) full HTML page. Added during the Version 1.0
 * Launch Readiness pass (see docs/launch-readiness.md and
 * docs/platform-review-v1.md's "Security headers" finding, which this
 * file resolves).
 *
 * Was deliberately kept as its own file, separate from the former
 * `middleware/cors.ts` (removed in the Version 2.0 Same-Origin Migration
 * — see docs/v2-same-origin-migration-audit.md) rather than folded into
 * it, so this pass had no reason to touch that file. `worker/index.ts`
 * applies this same composable `withXyz(response, env)` wrapper pattern
 * to every response.
 *
 * Updated Version 2.0 Phase 2 (Products Module): this Worker gained a
 * genuine HTML-rendering surface for the first time (routes/books.ts,
 * via the new /books/* Workers Route) — a real regression was found
 * during local verification: the original blanket
 * `Content-Security-Policy: default-src 'none'` (correct when every
 * response really was JSON/binary only) silently blocked every
 * CSS/JS/font asset on the new pages, since a strict `'none'` default
 * applies to stylesheets and scripts too, not just XHR/fetch. The CSP
 * now branches on the response's own Content-Type: an HTML page gets a
 * policy that actually allows this site's real asset origins (same-
 * origin CSS/JS/images plus Google Fonts); every other response
 * (JSON, binary downloads) keeps the original, maximally strict
 * `'none'` policy — those genuinely load nothing.
 */

import type { Env } from '../worker/env';

const HTML_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // 'unsafe-inline' covers this Worker's own inline `style="background-image:...url(cover)"` attributes (routes/books.ts) — a fixed, developer-authored pattern, not user-controllable CSS
  "font-src 'self' https://fonts.gstatic.com",
  "script-src 'self'",
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";

function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get('Content-Type') ?? '';
  return contentType.includes('text/html');
}

function securityHeaders(response: Response): Record<string, string> {
  return {
    // Every legitimate non-HTML response is a JSON envelope or a
    // binary file download (GET /api/download/:token) and gets the
    // original, maximally strict policy — there is no route among
    // those where loosening it would ever be needed. HTML responses
    // (routes/books.ts) get a policy scoped to what that page actually
    // needs to load — still real hardening (no inline scripts, no
    // third-party script origins, no framing), just not `'none'`.
    // frame-ancestors 'none' is present in both variants, additionally
    // covered by the (already syntactically distinct) X-Frame-Options
    // below — kept as two headers for the widest browser compatibility.
    'Content-Security-Policy': isHtmlResponse(response) ? HTML_CONTENT_SECURITY_POLICY : API_CONTENT_SECURITY_POLICY,

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
    // response this Worker returns. Applies equally to the HTML pages
    // added in Phase 2 — an outbound link from a product page (e.g.
    // "Read the full story") still shouldn't leak this site's own URL
    // structure via the Referer header any more than necessary.
    'Referrer-Policy': 'strict-origin-when-cross-origin',

    // Neither the API nor the new HTML pages use any of these browser
    // features, and explicitly disclaiming them means nothing
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
  for (const [key, value] of Object.entries(securityHeaders(response))) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}
