/**
 * Digital Library 2.0 Phase H (Interactive Learning Experience) — admin
 * authoring for library_learning_items. Mirrors productService.ts's own
 * validate -> write -> audit shape (setProductRelations() etc.), the
 * established pattern for admin-owned content attached to a product.
 *
 * A learning item always targets one real, currently-published asset —
 * validated via the SAME fetchCatalogProduct()/findPublishedAsset()
 * lookup answerService.ts and libraryBookmarkService.ts already use for
 * the customer-facing side, so an admin can never author an item
 * against a slug/assetId that doesn't actually exist or isn't
 * published. `format` is never admin-supplied — it is always derived
 * from the asset's own real fileType, so it can never drift from what
 * the reader will actually open.
 *
 * item_type-specific fields (choices/correctChoiceIndex/explanation vs
 * actionLabel) are enforced both here (clear validation errors) and by
 * the migration's own CHECK constraint (defense in depth against any
 * future write path that bypasses this service).
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import * as auditService from './admin/auditService';
import { fetchCatalogProduct, findPublishedAsset } from './productCatalogService';

export type LearningItemType = 'quick_check' | 'action';
export type LearningItemStatus = 'draft' | 'published';

export interface LearningItemRecord {
  id: number;
  productSlug: string;
  assetId: string;
  format: 'PDF' | 'EPUB';
  itemType: LearningItemType;
  anchorPageNumber: number | null;
  anchorCfi: string | null;
  prompt: string;
  choices: string[] | null;
  correctChoiceIndex: number | null;
  explanation: string | null;
  actionLabel: string | null;
  status: LearningItemStatus;
  sortOrder: number;
  /** Null = active. A real timestamp means this item is retired - never shown to customers regardless of `status` - but its row (and every response's real context) stays intact. See migration 0054's own header comment for why this is a separate column rather than a third status value. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LearningItemRow {
  id: number;
  product_slug: string;
  asset_id: string;
  format: 'PDF' | 'EPUB';
  item_type: LearningItemType;
  anchor_page_number: number | null;
  anchor_cfi: string | null;
  prompt: string;
  choices: string | null;
  correct_choice_index: number | null;
  explanation: string | null;
  action_label: string | null;
  status: LearningItemStatus;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: LearningItemRow): LearningItemRecord {
  return {
    id: row.id,
    productSlug: row.product_slug,
    assetId: row.asset_id,
    format: row.format,
    itemType: row.item_type,
    anchorPageNumber: row.anchor_page_number,
    anchorCfi: row.anchor_cfi,
    prompt: row.prompt,
    choices: row.choices ? JSON.parse(row.choices) : null,
    correctChoiceIndex: row.correct_choice_index,
    explanation: row.explanation,
    actionLabel: row.action_label,
    status: row.status,
    sortOrder: row.sort_order,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const MAX_PROMPT_LENGTH = 1000;
const MAX_EXPLANATION_LENGTH = 2000;
const MAX_CHOICE_LENGTH = 300;
const MAX_ACTION_LABEL_LENGTH = 300;
const MIN_CHOICES = 2;
const MAX_CHOICES = 6;

export type LearningItemInput =
  | {
      itemType: 'quick_check';
      productSlug: string;
      assetId: string;
      anchorPageNumber?: number | null;
      anchorCfi?: string | null;
      prompt: string;
      choices: string[];
      correctChoiceIndex: number;
      explanation: string;
      status?: LearningItemStatus;
      sortOrder?: number;
    }
  | {
      itemType: 'action';
      productSlug: string;
      assetId: string;
      anchorPageNumber?: number | null;
      anchorCfi?: string | null;
      prompt: string;
      actionLabel: string;
      status?: LearningItemStatus;
      sortOrder?: number;
    };

export type SaveLearningItemResult =
  | { ok: true; record: LearningItemRecord }
  | { ok: false; reason: 'invalid_input' | 'product_not_found' | 'asset_not_found' | 'not_found' };

/** Real, shared validation + product/asset resolution for both create and update. */
async function resolveAndValidate(env: Env, input: LearningItemInput): Promise<{ ok: true; format: 'PDF' | 'EPUB' } | { ok: false; reason: 'invalid_input' | 'product_not_found' | 'asset_not_found' }> {
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0 || input.prompt.length > MAX_PROMPT_LENGTH) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (input.anchorPageNumber != null && (!Number.isInteger(input.anchorPageNumber) || input.anchorPageNumber < 1)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (input.anchorCfi != null && (typeof input.anchorCfi !== 'string' || input.anchorCfi.length === 0 || input.anchorCfi.length > 2000)) {
    return { ok: false, reason: 'invalid_input' };
  }

  if (input.itemType === 'quick_check') {
    if (!Array.isArray(input.choices) || input.choices.length < MIN_CHOICES || input.choices.length > MAX_CHOICES) {
      return { ok: false, reason: 'invalid_input' };
    }
    if (input.choices.some((c) => typeof c !== 'string' || c.trim().length === 0 || c.length > MAX_CHOICE_LENGTH)) {
      return { ok: false, reason: 'invalid_input' };
    }
    if (!Number.isInteger(input.correctChoiceIndex) || input.correctChoiceIndex < 0 || input.correctChoiceIndex >= input.choices.length) {
      return { ok: false, reason: 'invalid_input' };
    }
    if (typeof input.explanation !== 'string' || input.explanation.trim().length === 0 || input.explanation.length > MAX_EXPLANATION_LENGTH) {
      return { ok: false, reason: 'invalid_input' };
    }
  } else {
    if (typeof input.actionLabel !== 'string' || input.actionLabel.trim().length === 0 || input.actionLabel.length > MAX_ACTION_LABEL_LENGTH) {
      return { ok: false, reason: 'invalid_input' };
    }
  }

  const product = await fetchCatalogProduct(env, input.productSlug);
  if (!product) return { ok: false, reason: 'product_not_found' };
  const asset = findPublishedAsset(product, input.assetId);
  if (!asset) return { ok: false, reason: 'asset_not_found' };
  if (asset.fileType !== 'PDF' && asset.fileType !== 'EPUB') return { ok: false, reason: 'asset_not_found' };

  // The anchor must actually make sense for this asset's real format -
  // a PDF asset with an EPUB-shaped cfi anchor (or vice versa) is
  // exactly the kind of authoring mistake this check exists to catch
  // before it reaches a customer's reader.
  if (asset.fileType === 'PDF' && input.anchorCfi != null) return { ok: false, reason: 'invalid_input' };
  if (asset.fileType === 'EPUB' && input.anchorPageNumber != null) return { ok: false, reason: 'invalid_input' };

  return { ok: true, format: asset.fileType };
}

export async function createLearningItem(env: Env, logger: Logger, actorId: number, input: LearningItemInput): Promise<SaveLearningItemResult> {
  const validated = await resolveAndValidate(env, input);
  if (!validated.ok) return validated;

  const status = input.status === 'published' ? 'published' : 'draft';
  const sortOrder = Number.isInteger(input.sortOrder) ? (input.sortOrder as number) : 0;

  const insert = await env.DB.prepare(
    `INSERT INTO library_learning_items
       (product_slug, asset_id, format, item_type, anchor_page_number, anchor_cfi, prompt, choices, correct_choice_index, explanation, action_label, status, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.productSlug,
      input.assetId,
      validated.format,
      input.itemType,
      input.anchorPageNumber ?? null,
      input.anchorCfi ?? null,
      input.prompt,
      input.itemType === 'quick_check' ? JSON.stringify(input.choices) : null,
      input.itemType === 'quick_check' ? input.correctChoiceIndex : null,
      input.itemType === 'quick_check' ? input.explanation : null,
      input.itemType === 'action' ? input.actionLabel : null,
      status,
      sortOrder
    )
    .run();

  const id = Number(insert.meta.last_row_id);
  await auditService.record(env, logger, { actorType: 'admin', actorId, action: 'library_learning_item.created', entityType: 'library_learning_item', entityId: id, metadata: { productSlug: input.productSlug, itemType: input.itemType } });

  const record = await getLearningItem(env, id);
  return { ok: true, record: record! };
}

export async function updateLearningItem(env: Env, logger: Logger, actorId: number, id: number, input: LearningItemInput): Promise<SaveLearningItemResult> {
  const existing = await env.DB.prepare(`SELECT id FROM library_learning_items WHERE id = ?`).bind(id).first<{ id: number }>();
  if (!existing) return { ok: false, reason: 'not_found' };

  const validated = await resolveAndValidate(env, input);
  if (!validated.ok) return validated;

  const status = input.status === 'published' ? 'published' : 'draft';
  const sortOrder = Number.isInteger(input.sortOrder) ? (input.sortOrder as number) : 0;

  await env.DB.prepare(
    `UPDATE library_learning_items
     SET product_slug = ?, asset_id = ?, format = ?, item_type = ?, anchor_page_number = ?, anchor_cfi = ?, prompt = ?, choices = ?, correct_choice_index = ?, explanation = ?, action_label = ?, status = ?, sort_order = ?, updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      input.productSlug,
      input.assetId,
      validated.format,
      input.itemType,
      input.anchorPageNumber ?? null,
      input.anchorCfi ?? null,
      input.prompt,
      input.itemType === 'quick_check' ? JSON.stringify(input.choices) : null,
      input.itemType === 'quick_check' ? input.correctChoiceIndex : null,
      input.itemType === 'quick_check' ? input.explanation : null,
      input.itemType === 'action' ? input.actionLabel : null,
      status,
      sortOrder,
      id
    )
    .run();

  await auditService.record(env, logger, { actorType: 'admin', actorId, action: 'library_learning_item.updated', entityType: 'library_learning_item', entityId: id, metadata: { productSlug: input.productSlug } });

  const record = await getLearningItem(env, id);
  return { ok: true, record: record! };
}

export type DeleteLearningItemResult = { ok: true } | { ok: false; reason: 'not_found' | 'has_responses' };

/**
 * A genuine, permanent DELETE - only ever safe for an item nobody has
 * ever answered/completed (checked explicitly here, not left to D1's
 * own FK enforcement to reject at the last second - see migration
 * 0054's own header comment on why that enforcement is real and why
 * this check now exists on purpose). Once a real response exists,
 * archiveLearningItem() below is the only retirement path - it keeps
 * the item's row, and therefore every response's real context, intact.
 */
export async function deleteLearningItem(env: Env, logger: Logger, actorId: number, id: number): Promise<DeleteLearningItemResult> {
  const existing = await env.DB.prepare(`SELECT id FROM library_learning_items WHERE id = ?`).bind(id).first<{ id: number }>();
  if (!existing) return { ok: false, reason: 'not_found' };

  const responseCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM library_learning_responses WHERE learning_item_id = ?`).bind(id).first<{ n: number }>();
  if ((responseCount?.n ?? 0) > 0) return { ok: false, reason: 'has_responses' };

  await env.DB.prepare(`DELETE FROM library_learning_items WHERE id = ?`).bind(id).run();
  await auditService.record(env, logger, { actorType: 'admin', actorId, action: 'library_learning_item.deleted', entityType: 'library_learning_item', entityId: id });
  return { ok: true };
}

export type ArchiveLearningItemResult = { ok: true; record: LearningItemRecord } | { ok: false; reason: 'not_found' };

/** Retires an item without touching its row - customer reads (listLearningItemsForAsset) exclude anything with archived_at set, regardless of status, so this is the real "remove from circulation" action once an item has ever been answered. */
export async function archiveLearningItem(env: Env, logger: Logger, actorId: number, id: number): Promise<ArchiveLearningItemResult> {
  const result = await env.DB.prepare(`UPDATE library_learning_items SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`).bind(id).run();
  if (result.meta.changes === 0) {
    const stillThere = await getLearningItem(env, id);
    if (!stillThere) return { ok: false, reason: 'not_found' };
    // Already archived - idempotent, return the current record rather than erroring on a double-click.
    return { ok: true, record: stillThere };
  }
  await auditService.record(env, logger, { actorType: 'admin', actorId, action: 'library_learning_item.archived', entityType: 'library_learning_item', entityId: id });
  const record = await getLearningItem(env, id);
  return { ok: true, record: record! };
}

export type RestoreLearningItemResult = { ok: true; record: LearningItemRecord } | { ok: false; reason: 'not_found' };

/** Reverses archiveLearningItem() - the item's own status (draft/published) is exactly what it was before archiving, since archiving never touched it. */
export async function restoreLearningItem(env: Env, logger: Logger, actorId: number, id: number): Promise<RestoreLearningItemResult> {
  const result = await env.DB.prepare(`UPDATE library_learning_items SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?`).bind(id).run();
  if (result.meta.changes === 0) return { ok: false, reason: 'not_found' };
  await auditService.record(env, logger, { actorType: 'admin', actorId, action: 'library_learning_item.restored', entityType: 'library_learning_item', entityId: id });
  const record = await getLearningItem(env, id);
  return { ok: true, record: record! };
}

export async function getLearningItem(env: Env, id: number): Promise<LearningItemRecord | null> {
  const row = await env.DB.prepare(`SELECT * FROM library_learning_items WHERE id = ?`).bind(id).first<LearningItemRow>();
  return row ? rowToRecord(row) : null;
}

/** Admin authoring list - every item for this product, draft and published both. */
export async function listLearningItemsForProduct(env: Env, productSlug: string): Promise<LearningItemRecord[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM library_learning_items WHERE product_slug = ? ORDER BY asset_id ASC, sort_order ASC, id ASC`).bind(productSlug).all<LearningItemRow>();
  return results.map(rowToRecord);
}
