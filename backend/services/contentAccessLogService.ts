/**
 * Content Access Log - Controlled Library Reader, audit trail. One
 * append-only INSERT per content-access event; never throws back into
 * the caller (a logging failure must never block a legitimate
 * page/chapter response, the same "log, don't throw" discipline
 * emailService.ts's sendEmail() already guarantees elsewhere in this
 * codebase). Never logs rendered content itself - `metadata` is a
 * small, deliberately narrow JSON object.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';

export type ContentAccessAction = 'view_session_started' | 'page_rendered' | 'chapter_rendered' | 'download';

export interface LogContentAccessInput {
  deliveryId: number;
  customerId: number | null;
  action: ContentAccessAction;
  ip: string | null;
  userAgent: string | null;
  metadata?: Record<string, unknown>;
}

export async function logContentAccess(env: Env, logger: Logger, input: LogContentAccessInput): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO content_access_log (delivery_id, customer_id, action, ip, user_agent, metadata, data_classification)
       VALUES (?, ?, ?, ?, ?, ?, 'PRODUCTION')`
    )
      .bind(input.deliveryId, input.customerId, input.action, input.ip, input.userAgent, input.metadata ? JSON.stringify(input.metadata) : null)
      .run();
  } catch (err) {
    logger.error('content_access_log.write_failed', {
      deliveryId: input.deliveryId,
      action: input.action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
