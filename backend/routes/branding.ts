/**
 * GET /api/branding — Homepage Modernization, Part 4 (CMS Logo
 * Management). Public, unauthenticated, read-only: the one thing every
 * static page's post-load JS (see js/components/branding.js) fetches to
 * find out which logo/favicon/etc. is currently active, so an admin can
 * replace the logo from the Media Library and have it apply site-wide
 * without a code change or deploy.
 *
 * Deliberately not cached at the edge/browser (`no-store`) — the whole
 * point of this endpoint is that a branding change in the admin panel
 * is visible on the next page load, not up to a cache TTL later. The
 * underlying image files it points to (via Media Library public URLs)
 * are still safely long-cached on their own, since every asset write
 * gets a fresh storage key (see routes/media.ts's header comment).
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonSuccess } from '../utils/responses';
import * as brandingService from '../services/admin/brandingService';

export async function handleGetPublicBranding(_request: Request, env: Env, _logger: Logger): Promise<Response> {
  const branding = await brandingService.getPublicBranding(env);
  const response = jsonSuccess(branding);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
