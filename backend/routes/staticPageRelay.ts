/**
 * Security remediation (High Finding H1, security audit 2026-09-15;
 * follow-up fix 2026-09-16) — transparently relays the four static
 * page groups still served directly by GitHub Pages
 * (/admin/*, /checkout/*, /dashboard/*, /affiliate/*) through this
 * Worker, purely so they pass through the same withSecurityHeaders()
 * every other response already gets. Nothing else about these pages
 * changes: every actual state-changing action on them (login,
 * checkout, downloads) already posts to /api/*, which this Worker was
 * already routing directly — this relay only ever touches the static
 * HTML document itself.
 *
 * The originally-preferred fix was a Cloudflare Transform Rule
 * (zone-level response-header injection, no code involved) — the
 * account's API token was confirmed to have zone read-only access, not
 * zone write (Rulesets, DNS, and zone settings all return 403), so that
 * path isn't available from this session. This relay achieves the same
 * end result using a permission that IS available (workers_routes
 * write) and requires no change to the GitHub Pages/static frontend
 * architecture — the actual files, and how they're authored/deployed,
 * are completely untouched.
 *
 * GITHUB_PAGES_ORIGIN is this project's real Pages origin — confirmed
 * live (https://elorm103.github.io/robayer-wealthlab/admin/login/
 * serves byte-identical content to the custom-domain URL) before this
 * was written. `redirect: 'manual'` and passing the origin's response
 * straight through (status, body, and every header including any
 * Set-Cookie/Location) keeps this a faithful, transparent relay — the
 * one addition is the security headers `worker/index.ts` already
 * applies to every response on the way out.
 *
 * routes/books.ts's own header comment documents why IT never does
 * this: "a Worker subrequest to a URL matching one of its own zone's
 * Routes re-enters that same Route rather than reaching the static
 * origin directly," and at the time that file was written, this
 * project had "no verified record of the actual GitHub Pages DNS/
 * origin topology to build a safe alternate-hostname proxy against."
 * That blocker doesn't apply here: this fetch targets
 * elorm103.github.io directly — a different hostname entirely, not a
 * URL matching any Route on robayerwealthlab.com's own zone — so there
 * is no re-entry risk, and the origin topology above is now verified
 * (fetched and diffed directly before this file was written).
 */

const RELAY_PATH_PREFIXES = ['/admin/', '/checkout/', '/dashboard/', '/affiliate/'];
const GITHUB_PAGES_ORIGIN = 'https://elorm103.github.io/robayer-wealthlab';

export function shouldRelayToStaticPages(pathname: string, method: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return RELAY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export async function relayStaticPage(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = `${GITHUB_PAGES_ORIGIN}${url.pathname}${url.search}`;

  const originResponse = await fetch(target, {
    method: request.method,
    headers: { Accept: request.headers.get('Accept') ?? '*/*' },
    redirect: 'manual',
  });

  // Response objects from fetch() have read-only headers; rebuild one
  // with the exact same status/body/headers so worker/index.ts's own
  // withSecurityHeaders() call can add to it, same as any other route.
  return new Response(originResponse.body, {
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers: originResponse.headers,
  });
}
