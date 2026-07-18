/**
 * Maintenance mode — Version 2.1 Phase 5 (Settings). See
 * docs/v2.1-phase5-design.md Section 5. Checked once per request, in
 * `worker/index.ts`, before route dispatch.
 *
 * Gates exactly the four path groups the user approved and nothing
 * else — `/api/*`, `/books/*`, `/resources/*`, `/blog/*` — since those
 * are the only paths this Worker actually serves (the rest of the
 * site is static GitHub Pages, never proxied through here, and so
 * cannot be gated by this Worker at all). `/api/admin/*` stays
 * reachable so a Super Admin can always turn maintenance mode back
 * off; `/api/webhooks/*` stays reachable so a Paystack webhook for a
 * payment made just before maintenance started is never dropped;
 * `/api/health` stays reachable for monitoring, matching its own
 * existing "no auth, no state" design intent.
 */

import type { Env } from '../worker/env';
import { getMaintenanceMode } from '../services/admin/settingsService';

const EXEMPT_EXACT = new Set(['/api/health']);
const EXEMPT_PREFIXES = ['/api/admin/', '/api/webhooks/'];
const GATED_PREFIXES = ['/api/', '/books/', '/resources/', '/blog/'];

function isExempt(pathname: string): boolean {
  return EXEMPT_EXACT.has(pathname) || EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isGated(pathname: string): boolean {
  return GATED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function maintenanceResponse(pathname: string, message: string): Response {
  const friendlyMessage = message || 'This service is temporarily unavailable for maintenance. Please check back soon.';
  const headers = { 'Retry-After': '300', 'Cache-Control': 'no-store' };

  if (pathname.startsWith('/api/')) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 'MAINTENANCE_MODE', message: friendlyMessage } }),
      { status: 503, headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  }

  // `/books/*`, `/resources/*`, `/blog/*` are real, server-rendered
  // pages a browser navigates to directly — a raw JSON body would
  // render as broken text. A minimal, self-contained HTML page here
  // (not the full site shell, to keep this middleware free of a
  // rendering-helper dependency on routes/blog.ts etc.).
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Temporarily unavailable | Robayer WealthLab</title>
  <meta name="robots" content="noindex">
</head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; text-align: center; color: #16233D;">
  <h1 style="font-size: 1.5rem; margin-bottom: 1rem;">We'll be right back</h1>
  <p>${escapeHtml(friendlyMessage)}</p>
</body>
</html>`;

  return new Response(html, { status: 503, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
}

/** Returns a 503 Response if maintenance mode is enabled and this path is gated by it, or `null` if the request should proceed normally. */
export async function checkMaintenanceMode(request: Request, env: Env): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (isExempt(pathname) || !isGated(pathname)) return null;

  const settings = await getMaintenanceMode(env);
  if (!settings.enabled) return null;

  return maintenanceResponse(pathname, settings.message);
}
