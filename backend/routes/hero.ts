/**
 * GET /api/hero — Version 3.4 Milestone M6 (CMS Completion). Public,
 * unauthenticated, read-only: the homepage's post-load JS fetches this
 * to fill in the hero headline/subheading/CTA text and destinations,
 * the same way js/components/branding.js already fetches GET /api/branding
 * for the logo. Kept as its own narrow endpoint (rather than folded into
 * the admin-only GET /api/admin/settings) so the public homepage never
 * has a code path that could expose the other site_settings values.
 *
 * Deliberately not cached (no-store) for the same reason as
 * routes/branding.ts and routes/books.ts: an admin edit to the hero
 * copy must be visible on the visitor's next page load, not delayed by
 * a cache TTL.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonSuccess } from '../utils/responses';
import * as settingsService from '../services/admin/settingsService';

export async function handleGetPublicHero(_request: Request, env: Env, _logger: Logger): Promise<Response> {
  const hero = await settingsService.getHeroContent(env);
  const response = jsonSuccess(hero);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
