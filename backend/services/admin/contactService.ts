/**
 * Contact Manager — Version 2.0 Phase 3 (Operational Visibility). See
 * docs/v2.0-phase3-architecture-plan.md's "Contact Manager" section
 * and services/admin/consultationService.ts (near-identical shape,
 * reused deliberately — the two request types are genuinely distinct
 * tables per this codebase's existing convention, but the admin
 * management logic over them is the same shape).
 *
 * `contact_messages` itself is read here but never inserted —
 * services/contactService.ts (the public-facing form handler,
 * unchanged by this phase) remains the only writer of a *new* message.
 * This file only ever updates `status`/`assigned_to` on an existing row.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import * as auditService from './auditService';

export const CONTACT_STATUSES = ['new', 'reviewed', 'responded', 'closed'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export function isValidContactStatus(value: unknown): value is ContactStatus {
  return typeof value === 'string' && (CONTACT_STATUSES as readonly string[]).includes(value);
}

export interface ContactListItem {
  id: number;
  name: string;
  email: string;
  status: ContactStatus;
  assignedTo: number | null;
  assignedToName: string | null;
  createdAt: string;
}

export interface ContactNote {
  id: number;
  authorId: number | null;
  authorName: string | null;
  note: string;
  createdAt: string;
}

export interface ContactDetail extends ContactListItem {
  phone: string | null;
  message: string;
  updatedAt: string;
  notes: ContactNote[];
}

export interface ListContactsQuery {
  search: string | null;
  status: string | null;
  assignedTo: number | null;
  page: number;
  pageSize: number;
}

export interface ListContactsResult {
  items: ContactListItem[];
  total: number;
  page: number;
  pageSize: number;
}

const LIST_SELECT = `
  SELECT cm.id, cm.name, cm.email, cm.status, cm.assigned_to, au.name AS assigned_to_name, cm.created_at
  FROM contact_messages cm
  LEFT JOIN admin_users au ON au.id = cm.assigned_to
`;

/** Escapes SQLite LIKE metacharacters — same convention as consultationService.ts/productService.ts. */
function likePattern(search: string): string {
  return `%${search.replace(/[%_\\]/g, '\\$&')}%`;
}

export async function listContacts(env: Env, query: ListContactsQuery): Promise<ListContactsResult> {
  const conditions: string[] = ['cm.deleted_at IS NULL'];
  const bindings: unknown[] = [];

  if (query.status) {
    conditions.push('cm.status = ?');
    bindings.push(query.status);
  }
  if (query.assignedTo !== null) {
    conditions.push('cm.assigned_to = ?');
    bindings.push(query.assignedTo);
  }
  if (query.search) {
    conditions.push("(cm.name LIKE ? ESCAPE '\\' OR cm.email LIKE ? ESCAPE '\\' OR cm.message LIKE ? ESCAPE '\\')");
    const pattern = likePattern(query.search);
    bindings.push(pattern, pattern, pattern);
  }

  const whereClause = conditions.join(' AND ');
  const offset = (query.page - 1) * query.pageSize;

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(`${LIST_SELECT} WHERE ${whereClause} ORDER BY cm.created_at DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, query.pageSize, offset)
      .all<{
        id: number;
        name: string;
        email: string;
        status: string;
        assigned_to: number | null;
        assigned_to_name: string | null;
        created_at: string;
      }>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM contact_messages cm WHERE ${whereClause}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);

  return {
    items: rows.results.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      status: r.status as ContactStatus,
      assignedTo: r.assigned_to,
      assignedToName: r.assigned_to_name,
      createdAt: r.created_at,
    })),
    total: countRow?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function getContactById(env: Env, id: number): Promise<ContactDetail | null> {
  const row = await env.DB.prepare(
    `SELECT cm.id, cm.name, cm.email, cm.phone, cm.message, cm.status, cm.assigned_to,
            au.name AS assigned_to_name, cm.created_at, cm.updated_at
     FROM contact_messages cm
     LEFT JOIN admin_users au ON au.id = cm.assigned_to
     WHERE cm.id = ? AND cm.deleted_at IS NULL`
  )
    .bind(id)
    .first<{
      id: number;
      name: string;
      email: string;
      phone: string | null;
      message: string;
      status: string;
      assigned_to: number | null;
      assigned_to_name: string | null;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) return null;

  const { results: noteRows } = await env.DB.prepare(
    `SELECT cn.id, cn.author_id, au.name AS author_name, cn.note, cn.created_at
     FROM contact_notes cn
     LEFT JOIN admin_users au ON au.id = cn.author_id
     WHERE cn.contact_message_id = ?
     ORDER BY cn.created_at ASC`
  )
    .bind(id)
    .all<{ id: number; author_id: number | null; author_name: string | null; note: string; created_at: string }>();

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    message: row.message,
    status: row.status as ContactStatus,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notes: noteRows.map((n) => ({ id: n.id, authorId: n.author_id, authorName: n.author_name, note: n.note, createdAt: n.created_at })),
  };
}

export type UpdateContactResult = { ok: true } | { ok: false; reason: 'not_found' | 'invalid_assignee' };

export async function updateContact(
  env: Env,
  logger: Logger,
  actorId: number,
  id: number,
  input: { status?: ContactStatus; assignedTo?: number | null }
): Promise<UpdateContactResult> {
  const existing = await env.DB.prepare(`SELECT id FROM contact_messages WHERE id = ? AND deleted_at IS NULL`).bind(id).first<{ id: number }>();
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
  if (sets.length === 0) return { ok: true };

  sets.push("updated_at = datetime('now')");
  await env.DB.prepare(`UPDATE contact_messages SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...bindings, id)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: input.status !== undefined ? 'contact.status_changed' : 'contact.assigned',
    entityType: 'contact_message',
    entityId: id,
    metadata: { status: input.status, assignedTo: input.assignedTo },
  });

  return { ok: true };
}

export type AddNoteResult = { ok: true; note: ContactNote } | { ok: false; reason: 'not_found' };

export async function addContactNote(env: Env, logger: Logger, actorId: number, actorName: string | null, id: number, note: string): Promise<AddNoteResult> {
  const existing = await env.DB.prepare(`SELECT id FROM contact_messages WHERE id = ? AND deleted_at IS NULL`).bind(id).first<{ id: number }>();
  if (!existing) return { ok: false, reason: 'not_found' };

  const insert = await env.DB.prepare(`INSERT INTO contact_notes (contact_message_id, author_id, note) VALUES (?, ?, ?)`)
    .bind(id, actorId, note)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'contact.note_added',
    entityType: 'contact_message',
    entityId: id,
  });

  const noteId = Number(insert.meta.last_row_id);
  const row = await env.DB.prepare(`SELECT created_at FROM contact_notes WHERE id = ?`).bind(noteId).first<{ created_at: string }>();

  return {
    ok: true,
    note: { id: noteId, authorId: actorId, authorName: actorName, note, createdAt: row?.created_at ?? new Date().toISOString() },
  };
}
