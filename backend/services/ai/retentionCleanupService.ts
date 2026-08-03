/**
 * AI Gateway retention cleanup — Version 5.0 Milestone 1.2 (AI
 * Governance & Safety), Task 5's "include scheduled cleanup ...
 * nothing should require manual deletion." Runs from the existing
 * (single) Cron Trigger — see worker/index.ts's `scheduled()` handler
 * — never a new trigger; this is exactly the same
 * reviewReminderService/purchaseFollowupService pattern already
 * established there.
 *
 * Never deletes an `ai_usage_log` ROW — deleting it would destroy
 * real cost/audit history, the same reason `audit_logs` itself has no
 * `deleted_at` (see migration 0001's own header comment: "deleting an
 * audit record would defeat the reason it exists"). Cleanup means
 * "NULL out the sensitive text columns once their retention window has
 * passed," leaving every numeric/metadata column intact forever.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';

export interface RetentionCleanupResult {
  eligible: number;
  purged: number;
}

export async function runScheduledCleanup(env: Env, logger: Logger): Promise<RetentionCleanupResult> {
  const eligibleRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM ai_usage_log WHERE cleanup_eligible_date IS NOT NULL AND cleanup_eligible_date <= datetime('now') AND purged_at IS NULL`
  ).first<{ c: number }>();
  const eligible = eligibleRow?.c ?? 0;

  if (eligible === 0) return { eligible: 0, purged: 0 };

  const result = await env.DB.prepare(
    `UPDATE ai_usage_log SET prompt_text = NULL, response_text = NULL, purged_at = datetime('now')
     WHERE cleanup_eligible_date IS NOT NULL AND cleanup_eligible_date <= datetime('now') AND purged_at IS NULL`
  ).run();
  const purged = result.meta.changes;

  logger.info('ai_gateway.retention_cleanup_completed', { eligible, purged });
  return { eligible, purged };
}
