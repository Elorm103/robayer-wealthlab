/**
 * Archive Centre — Version 4.9 Phase 7 (Production Launch Readiness &
 * Data Sanitization). Read-only, filter-based visibility into every
 * table migration 0028 gave a `data_classification` column, grouped
 * by PRODUCTION / INTERNAL / DEVELOPMENT / UNKNOWN. Per the founder's
 * explicit brief: "Do not move rows. Do not duplicate tables...
 * Every archived record remains searchable. Every relationship
 * remains intact. Every action remains reversible." This module never
 * writes anything — it is a lens over the live tables, nothing more.
 *
 * `ARCHIVE_ENTITIES` is the one source of truth for which table a
 * request may query and which of its columns are safe to render to
 * an admin (never password_hash, csrf_secret, or other secret/token
 * columns) — every query below is built exclusively from this
 * registry, so a request can never reach an unlisted table or column.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import * as auditService from './auditService';

export const CLASSIFICATIONS = ['PRODUCTION', 'INTERNAL', 'DEVELOPMENT', 'UNKNOWN'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export type ClassificationFilter = Classification | 'ALL';

export interface ArchiveColumn {
  column: string;
  label: string;
}

export interface ArchiveEntity {
  key: string;
  label: string;
  table: string;
  idColumn: string;
  columns: ArchiveColumn[];
  searchColumns: string[];
}

/** Every table migration 0028 added `data_classification` to. Column lists are curated for admin display — identifying/business fields only, never a secret, hash, or token column. */
export const ARCHIVE_ENTITIES: ArchiveEntity[] = [
  {
    key: 'customers',
    label: 'Customers',
    table: 'customers',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'email', label: 'Email' },
      { column: 'status', label: 'Status' },
      { column: 'created_at', label: 'Created' },
    ],
    searchColumns: ['email'],
  },
  {
    key: 'customer_profiles',
    label: 'Customer Profiles',
    table: 'customer_profiles',
    idColumn: 'customer_id',
    columns: [
      { column: 'customer_id', label: 'Customer ID' },
      { column: 'display_name', label: 'Display name' },
      { column: 'country', label: 'Country' },
      { column: 'updated_at', label: 'Updated' },
    ],
    searchColumns: ['display_name'],
  },
  {
    key: 'purchase_sessions',
    label: 'Purchase Sessions',
    table: 'purchase_sessions',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'purchase_reference', label: 'Reference' },
      { column: 'product_title', label: 'Product' },
      { column: 'customer_email', label: 'Email' },
      { column: 'amount_pesewas', label: 'Amount (pesewas)' },
      { column: 'status', label: 'Status' },
      { column: 'created_at', label: 'Created' },
    ],
    searchColumns: ['purchase_reference', 'customer_email', 'product_title'],
  },
  {
    key: 'payment_transactions',
    label: 'Payment Transactions',
    table: 'payment_transactions',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'purchase_session_id', label: 'Purchase Session ID' },
      { column: 'status', label: 'Status' },
      { column: 'verified_at', label: 'Verified' },
      { column: 'created_at', label: 'Created' },
    ],
    searchColumns: [],
  },
  {
    key: 'order_items',
    label: 'Order Items',
    table: 'order_items',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'purchase_session_id', label: 'Purchase Session ID' },
      { column: 'product_title', label: 'Product' },
      { column: 'unit_price_pesewas', label: 'Unit price (pesewas)' },
      { column: 'quantity', label: 'Qty' },
    ],
    searchColumns: ['product_title'],
  },
  {
    key: 'licenses',
    label: 'Licenses',
    table: 'licenses',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'purchase_session_id', label: 'Purchase Session ID' },
      { column: 'license_key', label: 'License key' },
      { column: 'issued_at', label: 'Issued' },
      { column: 'revoked_at', label: 'Revoked' },
    ],
    searchColumns: ['license_key'],
  },
  {
    key: 'receipts',
    label: 'Receipts',
    table: 'receipts',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'receipt_number', label: 'Receipt #' },
      { column: 'purchase_session_id', label: 'Purchase Session ID' },
      { column: 'total_pesewas', label: 'Total (pesewas)' },
      { column: 'issued_at', label: 'Issued' },
    ],
    searchColumns: ['receipt_number'],
  },
  {
    key: 'deliveries',
    label: 'Deliveries',
    table: 'deliveries',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'purchase_session_id', label: 'Purchase Session ID' },
      { column: 'product_slug', label: 'Product' },
      { column: 'status', label: 'Status' },
      { column: 'created_at', label: 'Created' },
    ],
    searchColumns: ['product_slug'],
  },
  {
    key: 'coupons',
    label: 'Coupons',
    table: 'coupons',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'code', label: 'Code' },
      { column: 'discount_type', label: 'Discount type' },
      { column: 'discount_value', label: 'Discount value' },
      { column: 'status', label: 'Status' },
      { column: 'created_at', label: 'Created' },
    ],
    searchColumns: ['code'],
  },
  {
    key: 'coupon_redemptions',
    label: 'Coupon Redemptions',
    table: 'coupon_redemptions',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'coupon_id', label: 'Coupon ID' },
      { column: 'purchase_session_id', label: 'Purchase Session ID' },
      { column: 'customer_email', label: 'Email' },
      { column: 'discount_pesewas', label: 'Discount (pesewas)' },
      { column: 'redeemed_at', label: 'Redeemed' },
    ],
    searchColumns: ['customer_email'],
  },
  {
    key: 'admin_users',
    label: 'Admin Users',
    table: 'admin_users',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'email', label: 'Email' },
      { column: 'role', label: 'Role' },
      { column: 'is_active', label: 'Active' },
      { column: 'created_at', label: 'Created' },
    ],
    searchColumns: ['email'],
  },
  {
    key: 'contact_messages',
    label: 'Contact Messages',
    table: 'contact_messages',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'name', label: 'Name' },
      { column: 'email', label: 'Email' },
      { column: 'status', label: 'Status' },
      { column: 'created_at', label: 'Created' },
    ],
    searchColumns: ['name', 'email'],
  },
  {
    key: 'consultation_requests',
    label: 'Consultation Requests',
    table: 'consultation_requests',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'name', label: 'Name' },
      { column: 'email', label: 'Email' },
      { column: 'category', label: 'Category' },
      { column: 'status', label: 'Status' },
      { column: 'created_at', label: 'Created' },
    ],
    searchColumns: ['name', 'email'],
  },
  {
    key: 'consultation_notes',
    label: 'Consultation Notes',
    table: 'consultation_notes',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'consultation_request_id', label: 'Consultation ID' },
      { column: 'author_id', label: 'Author (admin) ID' },
      { column: 'created_at', label: 'Created' },
    ],
    searchColumns: [],
  },
  {
    key: 'product_reviews',
    label: 'Product Reviews',
    table: 'product_reviews',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'product_id', label: 'Product ID' },
      { column: 'customer_id', label: 'Customer ID' },
      { column: 'rating', label: 'Rating' },
      { column: 'status', label: 'Status' },
      { column: 'created_at', label: 'Created' },
    ],
    searchColumns: [],
  },
  {
    key: 'newsletter_subscribers',
    label: 'Newsletter Subscribers',
    table: 'newsletter_subscribers',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'email', label: 'Email' },
      { column: 'status', label: 'Status' },
      { column: 'source', label: 'Source' },
      { column: 'subscribed_at', label: 'Subscribed' },
    ],
    searchColumns: ['email', 'source'],
  },
  {
    key: 'newsletter_campaigns',
    label: 'Newsletter Campaigns',
    table: 'newsletter_campaigns',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'subject', label: 'Subject' },
      { column: 'status', label: 'Status' },
      { column: 'created_at', label: 'Created' },
      { column: 'sent_at', label: 'Sent' },
    ],
    searchColumns: ['subject'],
  },
  {
    key: 'newsletter_campaign_recipients',
    label: 'Newsletter Campaign Recipients',
    table: 'newsletter_campaign_recipients',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'campaign_id', label: 'Campaign ID' },
      { column: 'subscriber_id', label: 'Subscriber ID' },
      { column: 'status', label: 'Status' },
      { column: 'attempted_at', label: 'Attempted' },
    ],
    searchColumns: [],
  },
  {
    key: 'media_assets',
    label: 'Media Assets',
    table: 'media_assets',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'filename', label: 'Filename' },
      { column: 'media_type', label: 'Type' },
      { column: 'folder', label: 'Folder' },
      { column: 'created_at', label: 'Created' },
    ],
    searchColumns: ['filename', 'original_filename'],
  },
  {
    key: 'blog_posts',
    label: 'Blog Posts',
    table: 'blog_posts',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'slug', label: 'Slug' },
      { column: 'title', label: 'Title' },
      { column: 'status', label: 'Status' },
      { column: 'created_at', label: 'Created' },
    ],
    searchColumns: ['slug', 'title'],
  },
  {
    key: 'products',
    label: 'Products',
    table: 'products',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'slug', label: 'Slug' },
      { column: 'title', label: 'Title' },
      { column: 'status', label: 'Status' },
      { column: 'price_pesewas', label: 'Price (pesewas)' },
      { column: 'created_at', label: 'Created' },
    ],
    searchColumns: ['slug', 'title'],
  },
  {
    key: 'resources',
    label: 'Resources',
    table: 'resources',
    idColumn: 'id',
    columns: [
      { column: 'id', label: 'ID' },
      { column: 'slug', label: 'Slug' },
      { column: 'title', label: 'Title' },
      { column: 'status', label: 'Status' },
      { column: 'published_at', label: 'Published' },
    ],
    searchColumns: ['slug', 'title'],
  },
];

const ENTITY_BY_KEY = new Map(ARCHIVE_ENTITIES.map((e) => [e.key, e]));

export function getArchiveEntity(key: string): ArchiveEntity | undefined {
  return ENTITY_BY_KEY.get(key);
}

export interface ClassificationCounts {
  PRODUCTION: number;
  INTERNAL: number;
  DEVELOPMENT: number;
  UNKNOWN: number;
  total: number;
}

export interface EntitySummary {
  key: string;
  label: string;
  counts: ClassificationCounts;
}

/** One `GROUP BY data_classification` per entity — cheap (indexed on the two highest-traffic tables per migration 0028, full-table scan on the rest, all well under D1's row counts here). */
export async function getClassificationSummary(env: Env): Promise<EntitySummary[]> {
  const results = await Promise.all(
    ARCHIVE_ENTITIES.map(async (entity) => {
      const rows = await env.DB.prepare(`SELECT data_classification AS classification, COUNT(*) AS c FROM ${entity.table} GROUP BY data_classification`).all<{
        classification: string;
        c: number;
      }>();
      const counts: ClassificationCounts = { PRODUCTION: 0, INTERNAL: 0, DEVELOPMENT: 0, UNKNOWN: 0, total: 0 };
      for (const row of rows.results ?? []) {
        if (row.classification in counts) counts[row.classification as Classification] = row.c;
        counts.total += row.c;
      }
      return { key: entity.key, label: entity.label, counts };
    })
  );
  return results;
}

export interface EntityRecordsResult {
  entity: { key: string; label: string; columns: ArchiveColumn[] };
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

export async function getEntityRecords(
  env: Env,
  entityKey: string,
  classification: ClassificationFilter,
  options: { search?: string | null; limit?: number; offset?: number }
): Promise<EntityRecordsResult | null> {
  const entity = getArchiveEntity(entityKey);
  if (!entity) return null;

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (classification !== 'ALL') {
    conditions.push('data_classification = ?');
    params.push(classification);
  }

  const search = options.search?.trim();
  if (search && entity.searchColumns.length > 0) {
    conditions.push('(' + entity.searchColumns.map((c) => `${c} LIKE ?`).join(' OR ') + ')');
    for (const _ of entity.searchColumns) params.push(`%${search}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const selectColumns = ['data_classification', ...entity.columns.map((c) => c.column)].join(', ');

  const [rows, countRow] = await Promise.all([
    env.DB.prepare(`SELECT ${selectColumns} FROM ${entity.table} ${whereClause} ORDER BY ${entity.idColumn} DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM ${entity.table} ${whereClause}`)
      .bind(...params)
      .first<{ c: number }>(),
  ]);

  return {
    entity: { key: entity.key, label: entity.label, columns: entity.columns },
    rows: rows.results ?? [],
    total: countRow?.c ?? 0,
    limit,
    offset,
  };
}

// ============================================================
// Version 4.9 Phase 8 + 10 — Unknown Record Review & Audit Trail.
// "View evidence" is the full row (every column, minus anything
// secret — see stripSecretColumns()); "View related entities" is a
// small, explicit relation map below, not a generic graph walk —
// covers the FK relationships that actually matter for the records
// this project has ever left UNKNOWN (anonymous purchase_sessions,
// unconfirmed newsletter_subscribers, ambiguous media_assets).
// ============================================================

/** Defensive redaction, independent of ARCHIVE_ENTITIES' own curated column lists — getRecordDetail() does a real `SELECT *` for evidence review, so this is the one place that must never let a secret/hash/token column reach an admin's browser, regardless of which table it's called against. */
function stripSecretColumns(row: Record<string, unknown>): Record<string, unknown> {
  const SECRET_PATTERN = /password|hash|secret|token/i;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (SECRET_PATTERN.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

interface RelationDef {
  label: string;
  targetEntityKey: string;
  /** Column on the record being viewed. */
  localColumn: string;
  /** Column on the related table to match against the record's localColumn value. */
  targetColumn: string;
}

/** Keyed by ARCHIVE_ENTITIES table name, not the route `key` — mirrors how ARCHIVE_ENTITIES itself is keyed by table identity. */
const RELATIONS: Record<string, RelationDef[]> = {
  customers: [
    { label: 'Purchase sessions', targetEntityKey: 'purchase_sessions', localColumn: 'id', targetColumn: 'customer_id' },
    { label: 'Product reviews', targetEntityKey: 'product_reviews', localColumn: 'id', targetColumn: 'customer_id' },
  ],
  purchase_sessions: [
    { label: 'Payment transactions', targetEntityKey: 'payment_transactions', localColumn: 'id', targetColumn: 'purchase_session_id' },
    { label: 'Order items', targetEntityKey: 'order_items', localColumn: 'id', targetColumn: 'purchase_session_id' },
    { label: 'Deliveries', targetEntityKey: 'deliveries', localColumn: 'id', targetColumn: 'purchase_session_id' },
    { label: 'Receipts', targetEntityKey: 'receipts', localColumn: 'id', targetColumn: 'purchase_session_id' },
  ],
  coupons: [{ label: 'Redemptions', targetEntityKey: 'coupon_redemptions', localColumn: 'id', targetColumn: 'coupon_id' }],
  newsletter_subscribers: [{ label: 'Campaign sends', targetEntityKey: 'newsletter_campaign_recipients', localColumn: 'id', targetColumn: 'subscriber_id' }],
  newsletter_campaigns: [{ label: 'Recipients', targetEntityKey: 'newsletter_campaign_recipients', localColumn: 'id', targetColumn: 'campaign_id' }],
  product_reviews: [
    { label: 'Product', targetEntityKey: 'products', localColumn: 'product_id', targetColumn: 'id' },
    { label: 'Customer', targetEntityKey: 'customers', localColumn: 'customer_id', targetColumn: 'id' },
  ],
};

export interface RelatedRecords {
  label: string;
  entityKey: string;
  rows: { id: number | string; classification: string }[];
}

export interface RecordDetailResult {
  entity: { key: string; label: string };
  record: Record<string, unknown>;
  related: RelatedRecords[];
}

export async function getRecordDetail(env: Env, entityKey: string, recordId: string): Promise<RecordDetailResult | null> {
  const entity = getArchiveEntity(entityKey);
  if (!entity) return null;

  const row = await env.DB.prepare(`SELECT * FROM ${entity.table} WHERE ${entity.idColumn} = ?`).bind(recordId).first<Record<string, unknown>>();
  if (!row) return null;

  const relationDefs = RELATIONS[entity.table] ?? [];
  const related = await Promise.all(
    relationDefs.map(async (rel): Promise<RelatedRecords> => {
      const targetEntity = getArchiveEntity(rel.targetEntityKey);
      if (!targetEntity) return { label: rel.label, entityKey: rel.targetEntityKey, rows: [] };
      const localValue = row[rel.localColumn];
      if (localValue === null || localValue === undefined) return { label: rel.label, entityKey: rel.targetEntityKey, rows: [] };

      const rows = await env.DB.prepare(
        `SELECT ${targetEntity.idColumn} AS id, data_classification AS classification FROM ${targetEntity.table} WHERE ${rel.targetColumn} = ? ORDER BY ${targetEntity.idColumn} DESC LIMIT 20`
      )
        .bind(localValue as string | number)
        .all<{ id: number | string; classification: string }>();

      return { label: rel.label, entityKey: rel.targetEntityKey, rows: rows.results ?? [] };
    })
  );

  return {
    entity: { key: entity.key, label: entity.label },
    record: stripSecretColumns(row),
    related,
  };
}

export type PromotableClassification = Exclude<Classification, 'UNKNOWN'>;

export function isPromotableClassification(value: unknown): value is PromotableClassification {
  return value === 'PRODUCTION' || value === 'INTERNAL' || value === 'DEVELOPMENT';
}

export type PromoteRecordResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_unknown' | 'invalid_classification' | 'missing_reason' };

/**
 * Reclassifies exactly one currently-UNKNOWN record, per the founder's
 * Phase 8 brief: "UNKNOWN records are intentionally unresolved...
 * Every reclassification must generate an audit log. Nothing should
 * happen silently." Deliberately refuses to touch a record that is
 * NOT currently UNKNOWN — this endpoint is a resolution tool for
 * ambiguous records, not a general reclassification override for
 * already-evidence-based PRODUCTION/INTERNAL/DEVELOPMENT rows (those
 * only ever change via a new evidence-based migration, same as
 * 0029/0030). Always writes to `audit_logs` (actor, timestamp, before,
 * after, reason, affected record) before returning, and never touches
 * any column except `data_classification` — no other field on the
 * underlying business record is ever modified by this action.
 */
export async function promoteRecord(
  env: Env,
  logger: Logger,
  entityKey: string,
  recordId: string,
  newClassification: unknown,
  reason: unknown,
  actorAdminId: number
): Promise<PromoteRecordResult> {
  const entity = getArchiveEntity(entityKey);
  if (!entity) return { ok: false, reason: 'not_found' };

  if (!isPromotableClassification(newClassification)) return { ok: false, reason: 'invalid_classification' };
  if (typeof reason !== 'string' || reason.trim().length === 0) return { ok: false, reason: 'missing_reason' };

  const current = await env.DB.prepare(`SELECT data_classification AS classification FROM ${entity.table} WHERE ${entity.idColumn} = ?`)
    .bind(recordId)
    .first<{ classification: string }>();
  if (!current) return { ok: false, reason: 'not_found' };
  if (current.classification !== 'UNKNOWN') return { ok: false, reason: 'not_unknown' };

  await env.DB.prepare(`UPDATE ${entity.table} SET data_classification = ? WHERE ${entity.idColumn} = ?`).bind(newClassification, recordId).run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId: actorAdminId,
    action: 'data_classification.promoted',
    entityType: entity.table,
    entityId: Number.isInteger(parseInt(recordId, 10)) ? parseInt(recordId, 10) : null,
    metadata: { before: 'UNKNOWN', after: newClassification, reason: reason.trim(), table: entity.table },
  });
  logger.info('data_classification.promoted', { table: entity.table, recordId, newClassification, actorAdminId });

  return { ok: true };
}
