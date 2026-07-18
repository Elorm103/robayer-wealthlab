/**
 * Login History Service — Version 2.1 Phase 3 (Identity & Security).
 * The only code that writes to `login_history`, matching this
 * codebase's "one service owns its table" convention. Written
 * alongside (not instead of) `auditService.ts`'s existing
 * `admin.login`/`admin.login_failed` events — see the migration's own
 * header comment for why a dedicated table exists at all.
 */

import type { Env } from '../../worker/env';

export type LoginOutcome = 'success' | 'failed_password' | 'failed_locked' | 'failed_inactive';

export interface RecordLoginHistoryInput {
  adminId: number;
  outcome: LoginOutcome;
  ip: string | null;
  userAgent: string | null;
}

export async function recordLoginHistory(env: Env, input: RecordLoginHistoryInput): Promise<void> {
  await env.DB.prepare(`INSERT INTO login_history (admin_id, outcome, ip_address, user_agent) VALUES (?, ?, ?, ?)`)
    .bind(input.adminId, input.outcome, input.ip, input.userAgent)
    .run();
}

export interface LoginHistoryItem {
  id: number;
  outcome: LoginOutcome;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

/** Own-history only — same reasoning as sessionService.ts's listSessions(). */
export async function listLoginHistory(env: Env, adminId: number, limit = 50): Promise<LoginHistoryItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, outcome, ip_address AS ipAddress, user_agent AS userAgent, created_at AS createdAt
     FROM login_history WHERE admin_id = ? ORDER BY created_at DESC LIMIT ?`
  )
    .bind(adminId, limit)
    .all<LoginHistoryItem>();

  return results;
}
