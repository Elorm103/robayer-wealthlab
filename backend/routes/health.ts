/**
 * GET /api/health — Same-Origin Routing Proof of Concept.
 *
 * Exists purely to verify, with zero risk to any real functionality,
 * that a Cloudflare Workers Route on `robayerwealthlab.com/api/*`
 * actually reaches this Worker before anything else is tested through
 * it. See docs/v2-same-origin-routing-poc.md. No auth, no state, no
 * side effects — safe to call from anywhere, repeatedly.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonSuccess } from '../utils/responses';

export async function handleHealth(request: Request, env: Env, logger: Logger): Promise<Response> {
  const url = new URL(request.url);
  return jsonSuccess({
    status: 'ok',
    via: url.hostname === 'robayerwealthlab.com' ? 'same-origin-route' : 'workers-dev',
    timestamp: new Date().toISOString(),
  });
}
