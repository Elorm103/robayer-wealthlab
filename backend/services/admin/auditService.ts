/**
 * Audit Service — Version 2.0 Phase 0.1 (Authentication Foundation).
 * See docs/v2-authentication-design.md's "Audit logging" and
 * docs/v2-security-review.md's "Audit logging". Location matches the
 * approved docs/v2-architecture.md folder structure
 * (`services/admin/auditService.ts`).
 *
 * The single function every authenticated mutation (and every
 * security-relevant auth event — login, logout, a rejected session, a
 * rejected authorization check) writes through — never a route or
 * another service issuing a raw `INSERT INTO audit_logs` itself, so the
 * shape can never drift or be accidentally skipped. Writes to the
 * already-existing, already-indexed `audit_logs` table (Version 1.2
 * Sprint 2, never populated by any code until this phase) — no schema
 * change.
 *
 * Deliberately never throws outward: an audit write failing must never
 * silently vanish, but it also must never turn a real security event
 * (e.g. a successful login) into a 500 for the admin performing it. A
 * logged-but-not-fatal `logger.error()` on write failure is the correct
 * middle ground, matching this codebase's existing posture on
 * non-critical side effects (e.g. `emailService.ts`'s send-failure
 * handling).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';

export type AuditActorType = 'admin' | 'system' | 'customer';

export interface AuditEvent {
  actorType: AuditActorType;
  /** The admin_users.id performing the action; null for system-initiated or unauthenticated (e.g. a failed login with no matching user) events. */
  actorId: number | null;
  /** e.g. "admin.login", "admin.login_failed", "admin.logout" — see docs/v2-authentication-design.md's full action vocabulary. */
  action: string;
  entityType?: string | null;
  entityId?: number | null;
  /** Arbitrary JSON-serializable context — e.g. { reason: 'invalid_credentials' }. Never a secret (password, token, session cookie value). */
  metadata?: Record<string, unknown> | null;
}

/**
 * Writes one audit_logs row. Never throws — a failure to write an
 * audit record is logged (structured, via the existing Logger) but does
 * not fail the calling request, since the security event itself (e.g.
 * the login) has already genuinely happened by the time this is called.
 */
export async function record(env: Env, logger: Logger, event: AuditEvent): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        event.actorType,
        event.actorId,
        event.action,
        event.entityType ?? null,
        event.entityId ?? null,
        event.metadata ? JSON.stringify(event.metadata) : null
      )
      .run();
  } catch (err) {
    logger.error('audit.write_failed', {
      action: event.action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
