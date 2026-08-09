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
  // Version 5.0 (Customer Acquisition Phase 1) — connect.facebook.net
  // is Meta Pixel's own base-code script origin (js/components/meta-pixel.js,
  // loaded from js/main.js). static.cloudflareinsights.com was already
  // a real, intended origin (js/main.js's pre-existing
  // loadCloudflareWebAnalytics(), Version 3.3 Milestone M5C) but had
  // been silently blocked by this exact same 'self'-only policy since
  // the day it shipped — never caught because analytics.webAnalyticsToken
  // has stayed null (no real Cloudflare Web Analytics site-tag created
  // yet), so that loader has never actually attempted to inject its
  // script until this project's own token is set. Fixed alongside the
  // Meta origin below since it's the identical root cause.
  "script-src 'self' https://connect.facebook.net https://static.cloudflareinsights.com",
  "img-src 'self' https: data:",
  // www.facebook.com — Meta Pixel's own event-send endpoint
  // (https://www.facebook.com/tr), called by fbevents.js for every
  // fbq('track'/'trackCustom') call, not just the <noscript> fallback
  // pixel (which img-src's existing "https:" wildcard already covers).
  // cloudflareinsights.com — the Web Analytics beacon's own event-send
  // endpoint, same reasoning as script-src above.
  "connect-src 'self' https://www.facebook.com https://cloudflareinsights.com",
  "frame-ancestors 'none'",
].join('; ');

const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";

function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get('Content-Type') ?? '';
  return contentType.includes('text/html');
}

function securityHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {
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

  // Every JSON/binary response on this API is either sensitive (admin
  // PII, order/financial data, a signed download) or simply not meant
  // to be cached anywhere — this project has never had a caching layer
  // for any live D1 query (see docs/v2-analytics-spec.md's "Refresh &
  // caching"). Found as a real gap during the Phase 3 Stage 5
  // acceptance audit: only `routes/admin/dashboard.ts`'s own
  // hand-rolled wrapper set this, leaving every other admin endpoint
  // (Orders, Consultations, Contacts, Analytics, Products, Media
  // Library) with no `Cache-Control` at all. That local wrapper has
  // since been removed in favor of this global rule. HTML pages
  // (routes/books.ts) are deliberately excluded — a public product page
  // has no reason to forbid caching.
  //
  // Version 4.2.1 (Hero Cover Flicker Instrumentation) — root cause of
  // the persistent flicker: this rule was unconditionally overwriting
  // routes/media.ts's own `public, max-age=31536000, immutable` header
  // with `no-store` on every media file response, since a served image
  // is non-HTML too. Confirmed live: the cover image (a real, content-
  // addressed, never-changes-at-this-URL file) was being fully
  // re-downloaded — multiple seconds for a ~1.9MB PNG — on every single
  // page view with no caching anywhere, browser or edge, which is what
  // made the placeholder linger and the eventual swap read as a
  // flicker. Only apply the no-store default when the route hasn't
  // already opted into public caching itself.
  const existingCacheControl = response.headers.get('Cache-Control');
  const routeOptedIntoPublicCaching = existingCacheControl?.startsWith('public,') ?? false;
  if (!isHtmlResponse(response) && !routeOptedIntoPublicCaching) {
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
    headers['Pragma'] = 'no-cache';
  }

  return headers;
}

/** Adds baseline security headers to an already-built response, without altering its body or status. */
export function withSecurityHeaders(response: Response, _env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders(response))) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}
