/**
 * Admin role authorization — Version 2.0 Phase 0.1 (Authentication
 * Foundation). Companion to `requireAuth.ts` (see that file's header
 * comment); matches the approved docs/v2-architecture.md folder
 * structure. Called after `requireAuth` succeeds, wherever a route
 * needs to restrict itself to specific roles.
 *
 * Per docs/v2-security-review.md's "Authorization": the frontend hiding
 * a button is UX, never the security boundary — every mutating route
 * that isn't open to all authenticated roles must call this, checked
 * server-side, so a lower-privileged admin hitting the route directly
 * (bypassing the UI) is still rejected by the Worker itself.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import type { AdminAuthContext } from './requireAuth';
import { record as recordAudit } from '../services/admin/auditService';
import { jsonError } from '../utils/responses';

/**
 * Records a distinct audit event from `requireAuth`'s rejection, since
 * here the actor IS a known, authenticated admin who attempted
 * something their role doesn't permit — a meaningfully different
 * security signal from an anonymous/expired-session request.
 */
export async function requireRole(request: Request, env: Env, logger: Logger, auth: AdminAuthContext, allowedRoles: readonly string[]): Promise<Response | null> {
  if (allowedRoles.includes(auth.role)) return null;

  await recordAudit(env, logger, {
    actorType: 'admin',
    actorId: auth.adminId,
    action: 'admin.forbidden_access',
    entityType: 'admin_user',
    entityId: auth.adminId,
    metadata: { path: new URL(request.url).pathname, role: auth.role, requiredRoles: allowedRoles },
  });

  return jsonError('FORBIDDEN', 'You do not have permission to perform this action.');
}
