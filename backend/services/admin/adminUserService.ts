/**
 * Admin User Management Service — Version 2.1 Phase 4 (User
 * Management). See docs/v2.1-phase4-design.md. The only code that
 * writes to `admin_invites` and performs lifecycle actions on OTHER
 * admins' `admin_users` rows (self-service — your own password,
 * sessions, login history — stays in `authService.ts`/`sessionService.ts`/
 * `loginHistoryService.ts`, reused unchanged here).
 *
 * Every mutating function here is called only after the route layer has
 * already run `requireAuth` + `requireRole(['super_admin'])` +
 * `requireCsrf` — this file additionally enforces the two safety rules
 * that don't fit a generic role check: self-targeting and
 * last-active-Super-Admin protection, both re-validated here rather
 * than trusted from the caller, so a bug in the route layer can never
 * silently skip them.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { issuePasswordResetToken } from './authService';
import { generateInviteToken } from '../../utils/adminSessionToken';
import { sendEmail } from '../emailService';
import * as sessionService from './sessionService';
import * as loginHistoryService from './loginHistoryService';
import * as auditService from './auditService';

export const ADMIN_ROLES = ['super_admin', 'editor', 'support'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export function isValidRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

const ROLE_LABEL: Record<AdminRole, string> = { super_admin: 'Super Admin', editor: 'Editor', support: 'Support' };

const INVITE_TTL_DAYS = 7;

export interface ActionContext {
  ip: string | null;
  userAgent: string | null;
}

export type ManagementError =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'self_targeted' }
  | { ok: false; reason: 'last_super_admin' }
  | { ok: false; reason: 'invalid_role' }
  | { ok: false; reason: 'email_taken' }
  | { ok: false; reason: 'invite_not_found' };

// ============================================================
// Shared guards — re-checked in every function below, never trusted
// from the caller.
// ============================================================

async function countActiveSuperAdmins(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM admin_users WHERE role = 'super_admin' AND is_active = 1 AND deleted_at IS NULL`).first<{ count: number }>();
  return row?.count ?? 0;
}

interface TargetAdminRow {
  id: number;
  email: string;
  name: string | null;
  role: string;
  isActive: number;
  deletedAt: string | null;
  lockedUntil: string | null;
}

async function getTargetAdmin(env: Env, targetId: number): Promise<TargetAdminRow | null> {
  const row = await env.DB.prepare(`SELECT id, email, name, role, is_active AS isActive, deleted_at AS deletedAt, locked_until AS lockedUntil FROM admin_users WHERE id = ?`)
    .bind(targetId)
    .first<TargetAdminRow>();
  return row ?? null;
}

/**
 * Rejects an action targeting `1)` the acting admin's own account, or
 * `2)` a target that no longer exists. Every mutating function below
 * calls this first, before doing anything else — the blanket rule the
 * user asked for: "all administrative security actions targeting
 * themselves should be blocked," not a case-by-case judgment about
 * which specific actions would be genuinely dangerous. Editing your
 * own profile continues to happen only through `/admin/account/`,
 * entirely outside this module.
 */
async function guardTarget(env: Env, actorId: number, targetId: number): Promise<{ ok: true; target: TargetAdminRow } | ManagementError> {
  if (targetId === actorId) return { ok: false, reason: 'self_targeted' };
  const target = await getTargetAdmin(env, targetId);
  if (!target) return { ok: false, reason: 'not_found' };
  return { ok: true, target };
}

/**
 * Rejects disable/delete/demote if the target is currently the only
 * active Super Admin. Re-derives the count fresh on every call rather
 * than trusting any cached value — the same read-then-write shape
 * every other status-transition function in this codebase already
 * uses (e.g. `resourceService.ts`'s duplicate-slug check); a
 * theoretical race between two simultaneous requests demoting the
 * last two Super Admins is an accepted, pre-existing class of
 * limitation, not a new gap introduced here.
 */
async function guardLastSuperAdmin(env: Env, target: TargetAdminRow): Promise<ManagementError | null> {
  if (target.role !== 'super_admin' || target.isActive !== 1 || target.deletedAt) return null;
  const count = await countActiveSuperAdmins(env);
  return count <= 1 ? { ok: false, reason: 'last_super_admin' } : null;
}

function auditMetadata(context: ActionContext, extra?: Record<string, unknown>): Record<string, unknown> {
  return { ip: context.ip, userAgent: context.userAgent, ...extra };
}

// ============================================================
// List / detail — super_admin-only visibility into every admin
// account (see docs/v2.1-phase4-design.md Section 5 for why this
// module is closed to editor/support even for reads).
// ============================================================

export interface AdminListItem {
  id: number;
  email: string;
  name: string | null;
  role: string;
  roleLabel: string;
  isActive: boolean;
  deletedAt: string | null;
  lastLoginAt: string | null;
  lastActivityAt: string | null;
  activeSessionCount: number;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  mustChangePassword: boolean;
  createdByName: string | null;
  createdAt: string;
}

interface AdminListRow {
  id: number;
  email: string;
  name: string | null;
  role: string;
  isActive: number;
  deletedAt: string | null;
  lastLoginAt: string | null;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  mustChangePassword: number;
  createdAt: string;
  createdByName: string | null;
  createdByEmail: string | null;
  lastActivityAt: string | null;
  activeSessionCount: number;
}

export async function listAdmins(env: Env, showDeleted: boolean): Promise<AdminListItem[]> {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(
    `SELECT
       u.id, u.email, u.name, u.role, u.is_active AS isActive, u.deleted_at AS deletedAt,
       u.last_login_at AS lastLoginAt, u.failed_login_attempts AS failedLoginAttempts,
       u.locked_until AS lockedUntil, u.must_change_password AS mustChangePassword,
       u.created_at AS createdAt, creator.name AS createdByName, creator.email AS createdByEmail,
       (SELECT MAX(s.last_seen_at) FROM admin_sessions s WHERE s.admin_id = u.id) AS lastActivityAt,
       (SELECT COUNT(*) FROM admin_sessions s WHERE s.admin_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS activeSessionCount
     FROM admin_users u
     LEFT JOIN admin_users creator ON creator.id = u.created_by
     WHERE ${showDeleted ? 'u.deleted_at IS NOT NULL' : 'u.deleted_at IS NULL'}
     ORDER BY u.created_at DESC`
  )
    .bind(now)
    .all<AdminListRow>();

  return results.map(toListItem);
}

function toListItem(row: AdminListRow): AdminListItem {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    roleLabel: ROLE_LABEL[row.role as AdminRole] ?? row.role,
    isActive: row.isActive === 1,
    deletedAt: row.deletedAt,
    lastLoginAt: row.lastLoginAt,
    lastActivityAt: row.lastActivityAt,
    activeSessionCount: row.activeSessionCount,
    failedLoginAttempts: row.failedLoginAttempts,
    lockedUntil: row.lockedUntil,
    mustChangePassword: row.mustChangePassword === 1,
    createdByName: row.createdByName ?? row.createdByEmail ?? null,
    createdAt: row.createdAt,
  };
}

export interface AdminDetail extends AdminListItem {
  sessions: sessionService.SessionListItem[];
  loginHistory: loginHistoryService.LoginHistoryItem[];
}

export async function getAdminDetail(env: Env, targetId: number): Promise<AdminDetail | null> {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT
       u.id, u.email, u.name, u.role, u.is_active AS isActive, u.deleted_at AS deletedAt,
       u.last_login_at AS lastLoginAt, u.failed_login_attempts AS failedLoginAttempts,
       u.locked_until AS lockedUntil, u.must_change_password AS mustChangePassword,
       u.created_at AS createdAt, creator.name AS createdByName, creator.email AS createdByEmail,
       (SELECT MAX(s.last_seen_at) FROM admin_sessions s WHERE s.admin_id = u.id) AS lastActivityAt,
       (SELECT COUNT(*) FROM admin_sessions s WHERE s.admin_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS activeSessionCount
     FROM admin_users u
     LEFT JOIN admin_users creator ON creator.id = u.created_by
     WHERE u.id = ?`
  )
    .bind(now, targetId)
    .first<AdminListRow>();

  if (!row) return null;

  // -1 never matches a real session id — this is a management view of
  // someone else's sessions, not the self-service `/admin/account/`
  // page, so no row is ever meaningfully "this device."
  const [sessions, loginHistory] = await Promise.all([sessionService.listSessions(env, targetId, -1), loginHistoryService.listLoginHistory(env, targetId)]);

  return { ...toListItem(row), sessions, loginHistory };
}

// ============================================================
// Pending invites — listed separately from real admins (an invite has
// no admin_users row until accepted).
// ============================================================

export interface PendingInviteItem {
  id: number;
  email: string;
  name: string | null;
  role: string;
  roleLabel: string;
  invitedByName: string | null;
  expiresAt: string;
  createdAt: string;
}

export async function listPendingInvites(env: Env): Promise<PendingInviteItem[]> {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.email, i.name, i.role, i.expires_at AS expiresAt, i.created_at AS createdAt,
            inviter.name AS invitedByName, inviter.email AS invitedByEmail
     FROM admin_invites i
     LEFT JOIN admin_users inviter ON inviter.id = i.invited_by
     WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
     ORDER BY i.created_at DESC`
  )
    .bind(now)
    .all<{ id: number; email: string; name: string | null; role: string; expiresAt: string; createdAt: string; invitedByName: string | null; invitedByEmail: string | null }>();

  return results.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    roleLabel: ROLE_LABEL[row.role as AdminRole] ?? row.role,
    invitedByName: row.invitedByName ?? row.invitedByEmail ?? null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }));
}

// ============================================================
// Invite / resend / cancel
// ============================================================

export interface InviteInput {
  email: string;
  name: string | null;
  role: string;
}

export type InviteResult = { ok: true; inviteId: number } | ManagementError;

/**
 * Privilege escalation is structurally impossible here, not just
 * checked: only `super_admin` can ever reach this function (every
 * route calling it requires `requireRole(['super_admin'])` first —
 * see routes/admin/users.ts), and `super_admin` is already the ceiling
 * of the 3-role hierarchy — there is no role above it to escalate to.
 * No cross-role comparison is needed beyond the role-enum validation
 * below.
 */
export async function inviteAdmin(env: Env, logger: Logger, actorId: number, input: InviteInput, siteBaseUrl: string, context: ActionContext): Promise<InviteResult> {
  if (!isValidRole(input.role)) return { ok: false, reason: 'invalid_role' };
  const email = input.email.trim().toLowerCase();

  const existing = await env.DB.prepare(`SELECT id FROM admin_users WHERE email = ?`).bind(email).first<{ id: number }>();
  if (existing) return { ok: false, reason: 'email_taken' };

  // Invalidate any previous unused invitation for this email — only
  // one active invitation should exist at a time, per explicit
  // requirement.
  await env.DB.prepare(`UPDATE admin_invites SET revoked_at = datetime('now') WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL`).bind(email).run();

  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60_000).toISOString();

  const insert = await env.DB.prepare(`INSERT INTO admin_invites (token, email, name, role, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(token, email, input.name || null, input.role, actorId, expiresAt)
    .run();
  const inviteId = Number(insert.meta.last_row_id);

  const inviter = await env.DB.prepare(`SELECT name, email FROM admin_users WHERE id = ?`).bind(actorId).first<{ name: string | null; email: string }>();

  await sendEmail(env, logger, {
    template: 'admin-invite',
    to: email,
    data: {
      inviterName: inviter?.name || inviter?.email || 'A Robayer WealthLab administrator',
      roleLabel: ROLE_LABEL[input.role],
      acceptUrl: `${siteBaseUrl}/admin/accept-invite/?token=${token}`,
    },
    entityType: 'admin_invite',
    entityId: inviteId,
  });

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'admin_user.invited',
    entityType: 'admin_invite',
    entityId: inviteId,
    metadata: auditMetadata(context, { email, role: input.role }),
  });

  return { ok: true, inviteId };
}

export async function resendInvite(env: Env, logger: Logger, actorId: number, inviteId: number, siteBaseUrl: string, context: ActionContext): Promise<InviteResult> {
  const now = new Date().toISOString();
  const invite = await env.DB.prepare(`SELECT email, name, role FROM admin_invites WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
    .bind(inviteId, now)
    .first<{ email: string; name: string | null; role: string }>();
  if (!invite) return { ok: false, reason: 'invite_not_found' };

  // Resending reissues a fresh token/expiry rather than re-sending the
  // original — the old link should stop working once a new one exists,
  // the same "one active invitation at a time" rule as a first invite.
  return inviteAdmin(env, logger, actorId, { email: invite.email, name: invite.name, role: invite.role }, siteBaseUrl, context);
}

export async function cancelInvite(env: Env, logger: Logger, actorId: number, inviteId: number, context: ActionContext): Promise<{ ok: true } | ManagementError> {
  const result = await env.DB.prepare(`UPDATE admin_invites SET revoked_at = datetime('now') WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`).bind(inviteId).run();
  if (result.meta.changes !== 1) return { ok: false, reason: 'invite_not_found' };

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'admin_user.invite_cancelled',
    entityType: 'admin_invite',
    entityId: inviteId,
    metadata: auditMetadata(context),
  });

  return { ok: true };
}

// ============================================================
// Edit (name / role)
// ============================================================

export interface EditAdminInput {
  name?: string | null;
  role?: string;
}

export type EditAdminResult = { ok: true } | ManagementError;

export async function editAdmin(env: Env, logger: Logger, actorId: number, targetId: number, input: EditAdminInput, context: ActionContext): Promise<EditAdminResult> {
  const guard = await guardTarget(env, actorId, targetId);
  if (!guard.ok) return guard;
  const { target } = guard;

  const nextName = input.name !== undefined ? input.name : target.name;
  const nextRole = input.role !== undefined ? input.role : target.role;

  if (input.role !== undefined && !isValidRole(input.role)) return { ok: false, reason: 'invalid_role' };

  const roleChanging = nextRole !== target.role;
  if (roleChanging && target.role === 'super_admin') {
    const lastGuard = await guardLastSuperAdmin(env, target);
    if (lastGuard) return lastGuard;
  }

  await env.DB.prepare(`UPDATE admin_users SET name = ?, role = ?, updated_at = datetime('now') WHERE id = ?`).bind(nextName, nextRole, targetId).run();

  // Any role change forces re-authentication under the new
  // permissions — a deliberate simplification over computing whether
  // this specific change is a "demotion" (this codebase defines no
  // explicit rank ordering between editor/support), and the safer
  // default in either direction.
  if (roleChanging) {
    await sessionService.revokeAllSessions(env, targetId);
  }

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'admin_user.updated',
    entityType: 'admin_user',
    entityId: targetId,
    metadata: auditMetadata(context, { before: { name: target.name, role: target.role }, after: { name: nextName, role: nextRole } }),
  });

  return { ok: true };
}

// ============================================================
// Disable / reactivate / soft delete
// ============================================================

export async function setActive(env: Env, logger: Logger, actorId: number, targetId: number, active: boolean, context: ActionContext): Promise<EditAdminResult> {
  const guard = await guardTarget(env, actorId, targetId);
  if (!guard.ok) return guard;
  const { target } = guard;

  if (!active) {
    const lastGuard = await guardLastSuperAdmin(env, target);
    if (lastGuard) return lastGuard;
  }

  await env.DB.prepare(`UPDATE admin_users SET is_active = ?, updated_at = datetime('now') WHERE id = ?`).bind(active ? 1 : 0, targetId).run();

  if (!active) {
    await sessionService.revokeAllSessions(env, targetId);
  }

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: active ? 'admin_user.reactivated' : 'admin_user.disabled',
    entityType: 'admin_user',
    entityId: targetId,
    metadata: auditMetadata(context, { before: { isActive: target.isActive === 1 }, after: { isActive: active } }),
  });

  return { ok: true };
}

export async function softDeleteAdmin(env: Env, logger: Logger, actorId: number, targetId: number, context: ActionContext): Promise<EditAdminResult> {
  const guard = await guardTarget(env, actorId, targetId);
  if (!guard.ok) return guard;
  const { target } = guard;

  const lastGuard = await guardLastSuperAdmin(env, target);
  if (lastGuard) return lastGuard;

  await env.DB.prepare(`UPDATE admin_users SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(targetId).run();

  await sessionService.revokeAllSessions(env, targetId);

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'admin_user.deleted',
    entityType: 'admin_user',
    entityId: targetId,
    metadata: auditMetadata(context, { email: target.email }),
  });

  return { ok: true };
}

// ============================================================
// Security actions — force password reset / change, force logout, unlock
// ============================================================

export async function forcePasswordReset(env: Env, logger: Logger, actorId: number, targetId: number, siteBaseUrl: string, context: ActionContext): Promise<EditAdminResult> {
  const guard = await guardTarget(env, actorId, targetId);
  if (!guard.ok) return guard;
  const { target } = guard;

  await issuePasswordResetToken(env, logger, targetId, target.email, siteBaseUrl);

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'admin_user.force_password_reset',
    entityType: 'admin_user',
    entityId: targetId,
    metadata: auditMetadata(context, { email: target.email }),
  });

  return { ok: true };
}

export async function forcePasswordChange(env: Env, logger: Logger, actorId: number, targetId: number, context: ActionContext): Promise<EditAdminResult> {
  const guard = await guardTarget(env, actorId, targetId);
  if (!guard.ok) return guard;

  await env.DB.prepare(`UPDATE admin_users SET must_change_password = 1 WHERE id = ?`).bind(targetId).run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'admin_user.force_password_change',
    entityType: 'admin_user',
    entityId: targetId,
    metadata: auditMetadata(context),
  });

  return { ok: true };
}

export async function forceLogout(env: Env, logger: Logger, actorId: number, targetId: number, context: ActionContext): Promise<EditAdminResult> {
  const guard = await guardTarget(env, actorId, targetId);
  if (!guard.ok) return guard;

  await sessionService.revokeAllSessions(env, targetId);

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'admin_user.force_logout',
    entityType: 'admin_user',
    entityId: targetId,
    metadata: auditMetadata(context),
  });

  return { ok: true };
}

export async function unlockAdmin(env: Env, logger: Logger, actorId: number, targetId: number, context: ActionContext): Promise<EditAdminResult> {
  const guard = await guardTarget(env, actorId, targetId);
  if (!guard.ok) return guard;
  const { target } = guard;

  await env.DB.prepare(`UPDATE admin_users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?`).bind(targetId).run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'admin_user.unlocked',
    entityType: 'admin_user',
    entityId: targetId,
    metadata: auditMetadata(context, { before: { lockedUntil: target.lockedUntil } }),
  });

  return { ok: true };
}
