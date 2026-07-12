/**
 * CORS — restricts which origins may call this API. Per
 * docs/backend-security.md: `Access-Control-Allow-Origin` is always
 * the exact `env.ALLOWED_ORIGIN`, never a wildcard `*`.
 *
 * `Access-Control-Allow-Credentials`/`X-CSRF-Token` added in Version 2.0
 * Phase 0.2 (Admin Shell) — see docs/v2-admin-shell-architecture.md's
 * "Critical finding". The admin frontend (robayerwealthlab.com) and this
 * Worker (robayer-wealthlab-api.robayerwealthlab.workers.dev) are
 * different origins, so the admin session cookie (`SameSite=None`, see
 * routes/admin/auth.ts) requires the browser to see this header before
 * it will expose a credentialed response to page JS at all — CORS's own
 * spec forbids combining `Allow-Credentials: true` with a wildcard
 * origin, which is exactly why `Access-Control-Allow-Origin` was always
 * a single exact origin here, never `*`. Additive only: every existing
 * public, cookie-less endpoint (newsletter/contact/consultation/
 * checkout/etc.) behaves identically, since none of them send or expect
 * credentials.
 */

import type { Env } from '../worker/env';

function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

/** Handles a CORS preflight request. Returns null for any non-OPTIONS request, so the caller knows to continue normal dispatch. */
export function handlePreflight(request: Request, env: Env): Response | null {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

/** Adds CORS headers to an already-built response (success or error) without altering its body or status. */
export function withCors(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(env))) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}
