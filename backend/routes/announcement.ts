/**
 * GET /api/announcement — Phase C (Announcement / Notification
 * System). Public, unauthenticated, read-only: mirrors routes/hero.ts
 * exactly (same reasoning, same shape) — a narrow, dedicated public
 * endpoint so no code path other than this one can expose any other
 * site_settings value to an unauthenticated visitor.
 *
 * Deliberately not cached (no-store) — an admin edit or an
 * enable/disable toggle must be visible on the visitor's next page
 * load, not delayed by a cache TTL.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonSuccess } from '../utils/responses';
import * as settingsService from '../services/admin/settingsService';

export async function handleGetPublicAnnouncement(_request: Request, env: Env, _logger: Logger): Promise<Response> {
  const announcement = await settingsService.getAnnouncement(env);
  const response = jsonSuccess(announcement);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
