/**
 * Consultation Manager — Version 2.0 Phase 3 (Operational Visibility).
 * See docs/v2.0-phase3-architecture-plan.md's "Consultation Manager"
 * section. The only code that writes to `consultation_notes` or the new
 * `consultation_requests.assigned_to` column — mirrors this codebase's
 * established "one service owns its tables" discipline
 * (e.g. `services/productService.ts` for `products`).
 *
 * `consultation_requests` itself is read here but never inserted —
 * `services/consultationService.ts` (the public-facing form handler,
 * unchanged by this phase) remains the only writer of a *new* request.
 * This file only ever updates `status`/`assigned_to` on an existing row.
 *
 * Every mutation writes its own audit_logs row via auditService, matching
 * every other admin service in this codebase.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import * as auditService from './auditService';

export const CONSULTATION_STATUSES = ['new', 'reviewed', 'responded', 'closed'] as const;
export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];

export function isValidConsultationStatus(value: unknown): value is ConsultationStatus {
  return typeof value === 'string' && (CONSULTATION_STATUSES as readonly string[]).includes(value);
}

export interface AssignableAdmin {
  id: number;
  name: string | null;
  email: string;
}

/**
 * Active admins, for the Assignee dropdown — no dedicated
 * `adminUserService.ts` exists yet (User Management is still an
 * out-of-scope shell per the architecture plan), so this is a small,
 * self-contained query here rather than a premature new service file
 * for a single SELECT. Every authenticated role can see this list
 * (name/email only, never password_hash) — a deliberate, small,
 * already-reasoned-about disclosure, see the architecture plan's
 * security review finding #2.
 */
export async function listAssignableAdmins(env: Env): Promise<AssignableAdmin[]> {
  const { results } = await env.DB.prepare(`SELECT id, name, email FROM admin_users WHERE is_active = 1 AND deleted_at IS NULL ORDER BY name, email`).all<{
    id: number;
    name: string | null;
    email: string;
  }>();
  return results;
}

export interface ConsultationListItem {
  id: number;
  name: string;
  email: string;
  category: string;
  status: ConsultationStatus;
  assignedTo: number | null;
  assignedToName: string | null;
  createdAt: string;
}

export interface ConsultationNote {
  id: number;
  authorId: number | null;
  authorName: string | null;
  note: string;
  createdAt: string;
}

export interface ConsultationDetail extends Omit<ConsultationListItem, never> {
  phone: string | null;
  country: string;
  description: string;
  preferredContactMethod: string;
  consentGiven: boolean;
  updatedAt: string;
  notes: ConsultationNote[];
}

export interface ListConsultationsQuery {
  search: string | null;
  status: string | null;
  category: string | null;
  assignedTo: number | null;
  page: number;
  pageSize: number;
}

export interface ListConsultationsResult {
  items: ConsultationListItem[];
  total: number;
  page: number;
  pageSize: number;
}

const LIST_SELECT = `
  SELECT cr.id, cr.name, cr.email, cr.category, cr.status, cr.assigned_to, au.name AS assigned_to_name, cr.created_at
  FROM consultation_requests cr
  LEFT JOIN admin_users au ON au.id = cr.assigned_to
`;

/** Escapes SQLite LIKE metacharacters — SQLite's LIKE has no default escape character, so this must be explicit (a real bug found and fixed in Media Library's own search, and again in Products' — see productService.ts's listProducts). */
function likePattern(search: string): string {
  return `%${search.replace(/[%_\\]/g, '\\$&')}%`;
}

export async function listConsultations(env: Env, query: ListConsultationsQuery): Promise<ListConsultationsResult> {
  const conditions: string[] = ['cr.deleted_at IS NULL'];
  const bindings: unknown[] = [];

  if (query.status) {
    conditions.push('cr.status = ?');
    bindings.push(query.status);
  }
  if (query.category) {
    conditions.push('cr.category = ?');
    bindings.push(query.category);
  }
  if (query.assignedTo !== null) {
    conditions.push('cr.assigned_to = ?');
    bindings.push(query.assignedTo);
  }
  if (query.search) {
    conditions.push("(cr.name LIKE ? ESCAPE '\\' OR cr.email LIKE ? ESCAPE '\\' OR cr.description LIKE ? ESCAPE '\\')");
    const pattern = likePattern(query.search);
    bindings.push(pattern, pattern, pattern);
  }

  const whereClause = conditions.join(' AND ');
  const offset = (query.page - 1) * query.pageSize;

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(`${LIST_SELECT} WHERE ${whereClause} ORDER BY cr.created_at DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, query.pageSize, offset)
      .all<{
        id: number;
        name: string;
        email: string;
        category: string;
        status: string;
        assigned_to: number | null;
        assigned_to_name: string | null;
        created_at: string;
      }>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM consultation_requests cr WHERE ${whereClause}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);

  return {
    items: rows.results.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      category: r.category,
      status: r.status as ConsultationStatus,
      assignedTo: r.assigned_to,
      assignedToName: r.assigned_to_name,
      createdAt: r.created_at,
    })),
    total: countRow?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function getConsultationById(env: Env, id: number): Promise<ConsultationDetail | null> {
  const row = await env.DB.prepare(
    `SELECT cr.id, cr.name, cr.email, cr.phone, cr.country, cr.category, cr.description,
            cr.preferred_contact_method, cr.consent_given, cr.status, cr.assigned_to,
            au.name AS assigned_to_name, cr.created_at, cr.updated_at
     FROM consultation_requests cr
     LEFT JOIN admin_users au ON au.id = cr.assigned_to
     WHERE cr.id = ? AND cr.deleted_at IS NULL`
  )
    .bind(id)
    .first<{
      id: number;
      name: string;
      email: string;
      phone: string | null;
      country: string;
      category: string;
      description: string;
      preferred_contact_method: string;
      consent_given: number;
      status: string;
      assigned_to: number | null;
      assigned_to_name: string | null;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) return null;

  const { results: noteRows } = await env.DB.prepare(
    `SELECT cn.id, cn.author_id, au.name AS author_name, cn.note, cn.created_at
     FROM consultation_notes cn
     LEFT JOIN admin_users au ON au.id = cn.author_id
     WHERE cn.consultation_request_id = ?
     ORDER BY cn.created_at ASC`
  )
    .bind(id)
    .all<{ id: number; author_id: number | null; author_name: string | null; note: string; created_at: string }>();

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    country: row.country,
    category: row.category,
    description: row.description,
    preferredContactMethod: row.preferred_contact_method,
    consentGiven: row.consent_given === 1,
    status: row.status as ConsultationStatus,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notes: noteRows.map((n) => ({ id: n.id, authorId: n.author_id, authorName: n.author_name, note: n.note, createdAt: n.created_at })),
  };
}

export type UpdateConsultationResult = { ok: true } | { ok: false; reason: 'not_found' | 'invalid_assignee' };

/**
 * Updates status and/or assignee. Both fields optional — a caller sends
 * only what changed. `assignedTo: null` explicitly unassigns; `undefined`
 * (the key omitted) leaves the current assignee untouched, matching
 * productService.updateProduct's own "undefined means no change,
 * explicit null means clear it" convention.
 */
export async function updateConsultation(
  env: Env,
  logger: Logger,
  actorId: number,
  id: number,
  input: { status?: ConsultationStatus; assignedTo?: number | null }
): Promise<UpdateConsultationResult> {
  const existing = await env.DB.prepare(`SELECT id FROM consultation_requests WHERE id = ? AND deleted_at IS NULL`).bind(id).first<{ id: number }>();
  if (!existing) return { ok: false, reason: 'not_found' };

  if (input.assignedTo !== undefined && input.assignedTo !== null) {
    const assignee = await env.DB.prepare(`SELECT id FROM admin_users WHERE id = ? AND is_active = 1 AND deleted_at IS NULL`)
      .bind(input.assignedTo)
      .first<{ id: number }>();
    if (!assignee) return { ok: false, reason: 'invalid_assignee' };
  }

  const sets: string[] = [];
  const bindings: unknown[] = [];
  if (input.status !== undefined) {
    sets.push('status = ?');
    bindings.push(input.status);
  }
  if (input.assignedTo !== undefined) {
    sets.push('assigned_to = ?');
    bindings.push(input.assignedTo);
  }
  if (sets.length === 0) return { ok: true }; // nothing to change — a no-op, not an error

  sets.push("updated_at = datetime('now')");
  await env.DB.prepare(`UPDATE consultation_requests SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...bindings, id)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: input.status !== undefined ? 'consultation.status_changed' : 'consultation.assigned',
    entityType: 'consultation_request',
    entityId: id,
    metadata: { status: input.status, assignedTo: input.assignedTo },
  });

  return { ok: true };
}

export type AddNoteResult = { ok: true; note: ConsultationNote } | { ok: false; reason: 'not_found' };

export async function addConsultationNote(env: Env, logger: Logger, actorId: number, actorName: string | null, id: number, note: string): Promise<AddNoteResult> {
  const existing = await env.DB.prepare(`SELECT id FROM consultation_requests WHERE id = ? AND deleted_at IS NULL`).bind(id).first<{ id: number }>();
  if (!existing) return { ok: false, reason: 'not_found' };

  const insert = await env.DB.prepare(`INSERT INTO consultation_notes (consultation_request_id, author_id, note) VALUES (?, ?, ?)`)
    .bind(id, actorId, note)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'consultation.note_added',
    entityType: 'consultation_request',
    entityId: id,
  });

  const noteId = Number(insert.meta.last_row_id);
  const row = await env.DB.prepare(`SELECT created_at FROM consultation_notes WHERE id = ?`).bind(noteId).first<{ created_at: string }>();

  return {
    ok: true,
    note: { id: noteId, authorId: actorId, authorName: actorName, note, createdAt: row?.created_at ?? new Date().toISOString() },
  };
}
