/**
 * CSRF protection for admin mutations — Version 2.0 Phase 0.1
 * (Authentication Foundation). Implements this folder's own
 * long-planned `csrf.ts` entry (see middleware/README.md). Applies to
 * every `/api/admin/*` state-changing route (POST/PATCH/DELETE),
 * called after `requireAuth` succeeds — mirrors exactly where
 * docs/v2-authentication-design.md's "CSRF" section places it in the
 * chain.
 *
 * Double-submit cookie pattern: the frontend reads the readable
 * `admin_csrf` cookie and echoes it back as the `X-CSRF-Token` header.
 * The check compares that header against `admin_sessions.csrf_secret`
 * (the server's own record for this exact session, resolved by
 * `requireAuth` and passed in as `auth.csrfSecret`) — not merely
 * cookie-equals-header, which would be checkable by anyone who can set
 * cookies. An attacker who can trigger a cross-site request carries the
 * victim's session cookie automatically but cannot read its value (or
 * the CSRF cookie's value) to forge a matching header — that's the
 * entire protection this pattern provides.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import type { AdminAuthContext } from './requireAuth';
import { record as recordAudit } from '../services/admin/auditService';
import { jsonError } from '../utils/responses';

const CSRF_HEADER_NAME = 'X-CSRF-Token';

export async function requireCsrf(request: Request, env: Env, logger: Logger, auth: AdminAuthContext): Promise<Response | null> {
  const header = request.headers.get(CSRF_HEADER_NAME);

  if (!header || !constantTimeEqual(header, auth.csrfSecret)) {
    await recordAudit(env, logger, {
      actorType: 'admin',
      actorId: auth.adminId,
      action: 'admin.csrf_rejected',
      entityType: 'admin_user',
      entityId: auth.adminId,
      metadata: { path: new URL(request.url).pathname },
    });
    return jsonError('FORBIDDEN', 'Request could not be verified. Please refresh and try again.');
  }

  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
