/**
 * Ad Spend Service — P0-B (Business Intelligence backbone, first
 * component). See migration 0043_ad_spend_entries.sql for the schema
 * this implements and the full reasoning behind its shape.
 *
 * This is a ledger, not an attribution or profitability engine —
 * deliberately. It records what was spent, on what campaign label, in
 * what currency, and by whom. It does NOT compute CPA, ROAS, contribution
 * margin, or connect a spend entry to any actual purchase — none of
 * that is possible yet (see the P0-B investigation's "Attribution
 * chain" finding), and this service must not imply otherwise.
 *
 * Same two-file split as every other admin resource in this codebase
 * (routes/admin/adSpend.ts is the thin HTTP layer; this file holds the
 * real logic) — see routes/admin/coupons.ts's own header comment for
 * the convention this mirrors.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import * as auditService from './auditService';

export const AD_SPEND_SOURCES = ['meta', 'google', 'linkedin', 'other'] as const;
export type AdSpendSource = (typeof AD_SPEND_SOURCES)[number];

export function isValidAdSpendSource(value: unknown): value is AdSpendSource {
  return typeof value === 'string' && (AD_SPEND_SOURCES as readonly string[]).includes(value);
}

/** YYYY-MM-DD only — matches <input type="date">'s own format, the only source this field is ever entered from today. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidEntryDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_PATTERN.test(value);
}

/** ISO 4217, matches products.currency's own convention (schema.sql) — not restricted to GHS, since ad spend is often in the ad platform's own billing currency. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function isValidCurrency(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_PATTERN.test(value);
}

export interface AdSpendEntryRecord {
  id: number;
  entryDate: string;
  source: AdSpendSource;
  campaignLabel: string;
  amountMinorUnits: number;
  currency: string;
  notes: string | null;
  createdBy: number;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AdSpendEntryRow {
  id: number;
  entry_date: string;
  source: AdSpendSource;
  campaign_label: string;
  amount_minor_units: number;
  currency: string;
  notes: string | null;
  created_by: number;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

function toApiShape(row: AdSpendEntryRow): AdSpendEntryRecord {
  return {
    id: row.id,
    entryDate: row.entry_date,
    source: row.source,
    campaignLabel: row.campaign_label,
    amountMinorUnits: row.amount_minor_units,
    currency: row.currency,
    notes: row.notes,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const LIST_SELECT = `
  SELECT e.*, creator.name AS created_by_name
  FROM ad_spend_entries e
  LEFT JOIN admin_users creator ON creator.id = e.created_by
`;

export interface ListAdSpendResult {
  items: AdSpendEntryRecord[];
  total: number;
  page: number;
  pageSize: number;
}

/** Excludes soft-deleted entries by default — deleted_at IS NOT NULL is never shown here; the row itself is never removed (see the migration's own "financial records are never hard-deleted" note). */
export async function listAdSpendEntries(env: Env, page: number, pageSize: number): Promise<ListAdSpendResult> {
  const offset = (page - 1) * pageSize;

  const [{ results }, countRow] = await Promise.all([
    env.DB.prepare(`${LIST_SELECT} WHERE e.deleted_at IS NULL ORDER BY e.entry_date DESC, e.id DESC LIMIT ? OFFSET ?`)
      .bind(pageSize, offset)
      .all<AdSpendEntryRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM ad_spend_entries WHERE deleted_at IS NULL`).first<{ n: number }>(),
  ]);

  return {
    items: results.map(toApiShape),
    total: countRow?.n ?? 0,
    page,
    pageSize,
  };
}

export interface CreateAdSpendInput {
  entryDate: string;
  source: AdSpendSource;
  campaignLabel: string;
  amountMinorUnits: number;
  currency: string;
  notes: string | null;
}

export type CreateAdSpendResult = { ok: true; id: number } | { ok: false; reason: 'invalid_input' };

export async function createAdSpendEntry(env: Env, logger: Logger, actorId: number, input: CreateAdSpendInput): Promise<CreateAdSpendResult> {
  if (!isValidEntryDate(input.entryDate)) return { ok: false, reason: 'invalid_input' };
  if (!isValidAdSpendSource(input.source)) return { ok: false, reason: 'invalid_input' };
  if (typeof input.campaignLabel !== 'string' || input.campaignLabel.trim().length === 0 || input.campaignLabel.length > 200) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!Number.isInteger(input.amountMinorUnits) || input.amountMinorUnits < 0) return { ok: false, reason: 'invalid_input' };
  if (!isValidCurrency(input.currency)) return { ok: false, reason: 'invalid_input' };

  const campaignLabel = input.campaignLabel.trim();

  const insert = await env.DB.prepare(
    `INSERT INTO ad_spend_entries (entry_date, source, campaign_label, amount_minor_units, currency, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(input.entryDate, input.source, campaignLabel, input.amountMinorUnits, input.currency, input.notes, actorId)
    .run();

  const id = Number(insert.meta.last_row_id);
  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'ad_spend.created',
    entityType: 'ad_spend_entry',
    entityId: id,
    metadata: { entryDate: input.entryDate, source: input.source, campaignLabel, amountMinorUnits: input.amountMinorUnits, currency: input.currency },
  });

  return { ok: true, id };
}

export interface UpdateAdSpendInput {
  entryDate?: string;
  source?: AdSpendSource;
  campaignLabel?: string;
  amountMinorUnits?: number;
  currency?: string;
  notes?: string | null;
}

export type UpdateAdSpendResult = { ok: true } | { ok: false; reason: 'not_found' | 'invalid_input' };

async function getRawEntry(env: Env, id: number): Promise<{ id: number; deleted_at: string | null } | null> {
  return env.DB.prepare(`SELECT id, deleted_at FROM ad_spend_entries WHERE id = ?`).bind(id).first<{ id: number; deleted_at: string | null }>();
}

/** Every field optional — only what's supplied is changed, matching updateCoupon()'s own partial-update convention. */
export async function updateAdSpendEntry(env: Env, logger: Logger, actorId: number, id: number, input: UpdateAdSpendInput): Promise<UpdateAdSpendResult> {
  const existing = await getRawEntry(env, id);
  if (!existing || existing.deleted_at) return { ok: false, reason: 'not_found' };

  if (input.entryDate !== undefined && !isValidEntryDate(input.entryDate)) return { ok: false, reason: 'invalid_input' };
  if (input.source !== undefined && !isValidAdSpendSource(input.source)) return { ok: false, reason: 'invalid_input' };
  if (input.campaignLabel !== undefined && (input.campaignLabel.trim().length === 0 || input.campaignLabel.length > 200)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (input.amountMinorUnits !== undefined && (!Number.isInteger(input.amountMinorUnits) || input.amountMinorUnits < 0)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (input.currency !== undefined && !isValidCurrency(input.currency)) return { ok: false, reason: 'invalid_input' };

  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.entryDate !== undefined) { sets.push('entry_date = ?'); params.push(input.entryDate); }
  if (input.source !== undefined) { sets.push('source = ?'); params.push(input.source); }
  if (input.campaignLabel !== undefined) { sets.push('campaign_label = ?'); params.push(input.campaignLabel.trim()); }
  if (input.amountMinorUnits !== undefined) { sets.push('amount_minor_units = ?'); params.push(input.amountMinorUnits); }
  if (input.currency !== undefined) { sets.push('currency = ?'); params.push(input.currency); }
  if (input.notes !== undefined) { sets.push('notes = ?'); params.push(input.notes); }

  if (sets.length === 0) return { ok: true }; // nothing to change — not an error, matches updateCoupon()'s own no-op tolerance

  sets.push(`updated_at = datetime('now')`);
  params.push(id);

  await env.DB.prepare(`UPDATE ad_spend_entries SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'ad_spend.updated',
    entityType: 'ad_spend_entry',
    entityId: id,
    metadata: { fields: Object.keys(input) },
  });

  return { ok: true };
}

export type DeleteAdSpendResult = { ok: true } | { ok: false; reason: 'not_found' };

/** Soft delete only — deleted_at, never a real DELETE. See the migration's own "financial records are never hard-deleted" convention (matching payment_transactions). */
export async function softDeleteAdSpendEntry(env: Env, logger: Logger, actorId: number, id: number): Promise<DeleteAdSpendResult> {
  const existing = await getRawEntry(env, id);
  if (!existing || existing.deleted_at) return { ok: false, reason: 'not_found' };

  await env.DB.prepare(`UPDATE ad_spend_entries SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(id).run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'ad_spend.deleted',
    entityType: 'ad_spend_entry',
    entityId: id,
    metadata: {},
  });

  return { ok: true };
}
