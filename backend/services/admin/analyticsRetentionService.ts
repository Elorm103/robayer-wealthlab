/**
 * analytics_events retention sweep — Analytics & User-Activity Baseline
 * (migration 0045). Runs from the existing (single) Cron Trigger — see
 * worker/index.ts's `scheduled()` handler — never a new trigger, same
 * pattern services/ai/retentionCleanupService.ts already established.
 *
 * Never deletes a row — event_type/page_path/product_slug/session_id/
 * created_at have no privacy sensitivity and stay useful for
 * long-horizon trend queries forever. Cleanup means "NULL out the
 * fields with any specificity (referrer, country, device_type) once
 * their retention window has passed" — mirrors
 * retentionCleanupService.ts's ai_usage_log pattern exactly.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';

const RETENTION_DAYS = 365;

export interface AnalyticsRetentionResult {
  eligible: number;
  purged: number;
}

export async function runAnalyticsRetentionSweep(env: Env, logger: Logger): Promise<AnalyticsRetentionResult> {
  const eligibleRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM analytics_events WHERE created_at <= datetime('now', ?) AND purged_at IS NULL`
  )
    .bind(`-${RETENTION_DAYS} days`)
    .first<{ c: number }>();
  const eligible = eligibleRow?.c ?? 0;

  if (eligible === 0) return { eligible: 0, purged: 0 };

  const result = await env.DB.prepare(
    `UPDATE analytics_events SET referrer = NULL, country = NULL, device_type = NULL, purged_at = datetime('now')
     WHERE created_at <= datetime('now', ?) AND purged_at IS NULL`
  )
    .bind(`-${RETENTION_DAYS} days`)
    .run();
  const purged = result.meta.changes;

  logger.info('analytics.retention_sweep_completed', { eligible, purged });
  return { eligible, purged };
}
