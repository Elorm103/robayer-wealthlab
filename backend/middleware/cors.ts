/**
 * CORS — restricts which origins may call this API. Per
 * docs/backend-security.md: `Access-Control-Allow-Origin` is always
 * the exact `env.ALLOWED_ORIGIN`, never a wildcard `*`.
 */

import type { Env } from '../worker/env';

function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
