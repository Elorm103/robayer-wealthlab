/**
 * Affiliate Resource Service: the admin-curated marketing-materials
 * library. See migration 0056_affiliate_resources.sql for the schema
 * reasoning. Deliberately simple CRUD, mirroring resourceService.ts's
 * own shape.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import * as auditService from './admin/auditService';

export const AFFILIATE_RESOURCE_CATEGORIES = ['social_caption', 'script', 'message_template', 'product_copy', 'image', 'guidance'] as const;
export type AffiliateResourceCategory = (typeof AFFILIATE_RESOURCE_CATEGORIES)[number];

export function isValidResourceCategory(value: unknown): value is AffiliateResourceCategory {
  return typeof value === 'string' && (AFFILIATE_RESOURCE_CATEGORIES as readonly string[]).includes(value);
}

export interface AffiliateResource {
  id: number;
  title: string;
  category: AffiliateResourceCategory;
  body: string | null;
  mediaUrl: string | null;
  productSlug: string | null;
}

interface ResourceRow extends Omit<AffiliateResource, 'category'> {
  category: string;
}

/** Approved-affiliate-facing: only 'published' resources, never draft/archived. */
export async function listPublishedResources(env: Env): Promise<AffiliateResource[]> {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.title, r.category, r.body, m.public_url AS mediaUrl, r.product_slug AS productSlug
     FROM affiliate_resources r LEFT JOIN media_assets m ON m.id = r.media_id
     WHERE r.status = 'published' ORDER BY r.sort_order ASC, r.id DESC`
  ).all<ResourceRow>();
  return rows.results.map((r) => ({ ...r, category: r.category as AffiliateResourceCategory }));
}

export interface AdminAffiliateResourceItem extends AffiliateResource {
  status: 'draft' | 'published' | 'archived';
  sortOrder: number;
}
interface AdminResourceRow extends Omit<AdminAffiliateResourceItem, 'category'> {
  category: string;
}

export async function listAllResourcesForAdmin(env: Env): Promise<AdminAffiliateResourceItem[]> {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.title, r.category, r.body, m.public_url AS mediaUrl, r.product_slug AS productSlug, r.status, r.sort_order AS sortOrder
     FROM affiliate_resources r LEFT JOIN media_assets m ON m.id = r.media_id
     ORDER BY r.sort_order ASC, r.id DESC`
  ).all<AdminResourceRow>();
  return rows.results.map((r) => ({ ...r, category: r.category as AffiliateResourceCategory }));
}

export interface CreateResourceInput {
  title: string;
  category: AffiliateResourceCategory;
  body: string | null;
  mediaId: number | null;
  productSlug: string | null;
  sortOrder: number;
}

export type SaveResourceResult = { ok: true; id: number } | { ok: false; reason: 'invalid_input' };

export async function createResource(env: Env, logger: Logger, adminId: number, input: CreateResourceInput): Promise<SaveResourceResult> {
  if (!input.title.trim() || !isValidResourceCategory(input.category)) return { ok: false, reason: 'invalid_input' };

  const insert = await env.DB.prepare(
    `INSERT INTO affiliate_resources (title, category, body, media_id, product_slug, sort_order, status, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?)`
  )
    .bind(input.title.trim(), input.category, input.body, input.mediaId, input.productSlug, input.sortOrder, adminId, adminId)
    .run();

  const id = Number(insert.meta.last_row_id);
  await auditService.record(env, logger, { actorType: 'admin', actorId: adminId, action: 'affiliate_resource.created', entityType: 'affiliate_resource', entityId: id, metadata: { title: input.title } });
  return { ok: true, id };
}

export async function updateResourceStatus(env: Env, logger: Logger, adminId: number, id: number, status: 'draft' | 'published' | 'archived'): Promise<{ ok: boolean }> {
  const result = await env.DB.prepare(`UPDATE affiliate_resources SET status = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`).bind(status, adminId, id).run();
  if (result.meta.changes !== 1) return { ok: false };
  await auditService.record(env, logger, { actorType: 'admin', actorId: adminId, action: 'affiliate_resource.status_changed', entityType: 'affiliate_resource', entityId: id, metadata: { status } });
  return { ok: true };
}
