/**
 * Digital Library 2.0 Phase H (Interactive Learning Experience) —
 * customer-facing reads/writes for library_learning_items /
 * library_learning_responses. Mirrors libraryBookmarkService.ts's own
 * authorization discipline exactly: every function re-verifies
 * ownership via entitlementService.ts's checkEntitlement() with the
 * AUTHENTICATED customerId, never trusts a client-supplied one.
 *
 * The correct answer (correct_choice_index) and explanation are never
 * included in the list response - only in the result of actually
 * submitting an answer. This isn't a security boundary against a
 * determined customer (a low-stakes educational quiz isn't an
 * adversarial context) but it is still the honest shape: a reader
 * hasn't "answered" anything if the correct answer already sat in the
 * page's own JSON before they clicked anything, and grading must be
 * genuinely server-computed either way (never trusted from the
 * client), matching every other server-derived value in this codebase
 * (library_progress.percent_complete, library_progress.status, etc).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { checkEntitlement } from '../entitlementService';

export type LearningItemType = 'quick_check' | 'action';

export interface LearningItemForCustomer {
  id: number;
  itemType: LearningItemType;
  anchorPageNumber: number | null;
  anchorCfi: string | null;
  prompt: string;
  /** quick_check only - the options, never the correct index. */
  choices: string[] | null;
  /** action only. */
  actionLabel: string | null;
  sortOrder: number;
  /** This customer's own prior response, if any - lets the reader show "already answered" without a second round trip. */
  response: { selectedChoiceIndex: number | null; isCorrect: boolean | null; actionDone: boolean | null } | null;
}

interface LearningItemRow {
  id: number;
  item_type: LearningItemType;
  anchor_page_number: number | null;
  anchor_cfi: string | null;
  prompt: string;
  choices: string | null;
  action_label: string | null;
  sort_order: number;
  selected_choice_index: number | null;
  is_correct: number | null;
  action_done: number | null;
}

export async function listLearningItemsForAsset(env: Env, customerId: number, purchaseReference: string, assetId: string): Promise<LearningItemForCustomer[]> {
  const check = await checkEntitlement(env, purchaseReference, assetId, 'view', customerId);
  if (!check.granted) return [];

  const deliveryRow = await env.DB.prepare(`SELECT product_slug AS productSlug FROM deliveries WHERE id = ?`).bind(check.deliveryId).first<{ productSlug: string }>();
  if (!deliveryRow) return [];

  const { results } = await env.DB.prepare(
    `SELECT li.id, li.item_type, li.anchor_page_number, li.anchor_cfi, li.prompt, li.choices, li.action_label, li.sort_order,
            lr.selected_choice_index, lr.is_correct, lr.action_done
     FROM library_learning_items li
     LEFT JOIN library_learning_responses lr ON lr.learning_item_id = li.id AND lr.customer_id = ?
     WHERE li.product_slug = ? AND li.asset_id = ? AND li.status = 'published' AND li.archived_at IS NULL
     ORDER BY li.sort_order ASC, li.id ASC`
  )
    .bind(customerId, deliveryRow.productSlug, assetId)
    .all<LearningItemRow>();

  return results.map((row) => ({
    id: row.id,
    itemType: row.item_type,
    anchorPageNumber: row.anchor_page_number,
    anchorCfi: row.anchor_cfi,
    prompt: row.prompt,
    choices: row.choices ? JSON.parse(row.choices) : null,
    actionLabel: row.action_label,
    sortOrder: row.sort_order,
    response:
      row.selected_choice_index != null || row.is_correct != null || row.action_done != null
        ? { selectedChoiceIndex: row.selected_choice_index, isCorrect: row.is_correct == null ? null : Boolean(row.is_correct), actionDone: row.action_done == null ? null : Boolean(row.action_done) }
        : null,
  }));
}

export type SubmitLearningResponseInput = { itemType: 'quick_check'; selectedChoiceIndex: number } | { itemType: 'action'; actionDone: boolean };

export type SubmitLearningResponseResult =
  | { ok: true; itemType: 'quick_check'; isCorrect: boolean; correctChoiceIndex: number; explanation: string }
  | { ok: true; itemType: 'action'; actionDone: boolean }
  | { ok: false; reason: 'not_authorized' | 'not_found' | 'invalid_input' | 'item_type_mismatch' };

interface FullItemRow {
  id: number;
  product_slug: string;
  asset_id: string;
  item_type: LearningItemType;
  choices: string | null;
  correct_choice_index: number | null;
  explanation: string | null;
  status: string;
  archived_at: string | null;
}

export async function submitLearningResponse(
  env: Env,
  logger: Logger,
  customerId: number,
  purchaseReference: string,
  assetId: string,
  itemId: number,
  input: SubmitLearningResponseInput
): Promise<SubmitLearningResponseResult> {
  const check = await checkEntitlement(env, purchaseReference, assetId, 'view', customerId);
  if (!check.granted) {
    logger.warn('library_learning.denied', { purchaseReference, assetId, customerId, reason: check.reason });
    return { ok: false, reason: 'not_authorized' };
  }

  const deliveryRow = await env.DB.prepare(`SELECT product_slug AS productSlug FROM deliveries WHERE id = ?`).bind(check.deliveryId).first<{ productSlug: string }>();
  if (!deliveryRow) return { ok: false, reason: 'not_authorized' };

  const item = await env.DB.prepare(`SELECT id, product_slug, asset_id, item_type, choices, correct_choice_index, explanation, status, archived_at FROM library_learning_items WHERE id = ?`).bind(itemId).first<FullItemRow>();
  if (!item || item.status !== 'published' || item.archived_at !== null) return { ok: false, reason: 'not_found' };

  // The item must genuinely belong to the exact (product, asset) this
  // customer's own entitlement check just verified - this is the real
  // enforcement point against a manipulated itemId being submitted
  // alongside a legitimately-owned purchaseReference/assetId, the same
  // "even if called with a wrong ID, only the real scope is trusted"
  // discipline searchService.ts's own header comment documents for
  // cross-book AI isolation.
  if (item.product_slug !== deliveryRow.productSlug || item.asset_id !== assetId) {
    logger.warn('library_learning.cross_asset_attempt', { customerId, itemId, expectedProductSlug: deliveryRow.productSlug, expectedAssetId: assetId });
    return { ok: false, reason: 'not_found' };
  }

  if (item.item_type !== input.itemType) return { ok: false, reason: 'item_type_mismatch' };

  if (input.itemType === 'quick_check') {
    const choices: string[] = item.choices ? JSON.parse(item.choices) : [];
    if (!Number.isInteger(input.selectedChoiceIndex) || input.selectedChoiceIndex < 0 || input.selectedChoiceIndex >= choices.length) {
      return { ok: false, reason: 'invalid_input' };
    }
    const isCorrect = input.selectedChoiceIndex === item.correct_choice_index;
    await env.DB.prepare(
      `INSERT INTO library_learning_responses (learning_item_id, delivery_id, customer_id, selected_choice_index, is_correct, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(learning_item_id, customer_id) DO UPDATE SET
         delivery_id = excluded.delivery_id, selected_choice_index = excluded.selected_choice_index, is_correct = excluded.is_correct, updated_at = excluded.updated_at`
    )
      .bind(itemId, check.deliveryId, customerId, input.selectedChoiceIndex, isCorrect ? 1 : 0)
      .run();

    return { ok: true, itemType: 'quick_check', isCorrect, correctChoiceIndex: item.correct_choice_index!, explanation: item.explanation! };
  }

  // action
  await env.DB.prepare(
    `INSERT INTO library_learning_responses (learning_item_id, delivery_id, customer_id, action_done, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(learning_item_id, customer_id) DO UPDATE SET
       delivery_id = excluded.delivery_id, action_done = excluded.action_done, updated_at = excluded.updated_at`
  )
    .bind(itemId, check.deliveryId, customerId, input.actionDone ? 1 : 0)
    .run();

  return { ok: true, itemType: 'action', actionDone: input.actionDone };
}

/**
 * Digital Library 2.0 Phase I — real, persisted learning evidence for
 * the Library's "Your Learning" section. Every number here is a direct
 * COUNT/SUM over this customer's own library_learning_responses rows -
 * no invented "mastery score." Deliberately per-book and only for
 * books this customer has actually engaged with (an inner join to
 * their responses) - a book with zero learning engagement doesn't get
 * a row at all, so the caller never has to decide whether to hide an
 * all-zero card; there simply isn't one, matching this phase's own
 * "do not display empty metrics" requirement.
 *
 * itemsCompleted / totalPublishedItems is an honest "how much of this
 * book's learning content have you engaged with" ratio - not
 * presented as "chapter completion" or "mastery," since no reliable
 * chapter-boundary data exists (confirmed during the Phase I audit:
 * PDF chapter_title is never populated, EPUB's real TOC lives only
 * client-side in epub.js). totalPublishedItems counts every currently
 * published, non-archived item for the product (both PDF and EPUB
 * assets combined, when a book has both) - a customer working through
 * either format's items is making real progress on the same book.
 */
export interface LibraryLearningStatsForBook {
  productSlug: string;
  productTitle: string;
  quickChecksAttempted: number;
  quickChecksCorrect: number;
  actionsCompleted: number;
  totalPublishedItems: number;
  itemsCompleted: number;
  lastEngagedAt: string;
}

interface StatsRow {
  productSlug: string;
  productTitle: string;
  quickChecksAttempted: number;
  quickChecksCorrect: number;
  actionsCompleted: number;
  lastEngagedAt: string;
}

export async function getLearningStatsForCustomer(env: Env, customerId: number): Promise<LibraryLearningStatsForBook[]> {
  const { results: statsRows } = await env.DB.prepare(
    `SELECT p.slug AS productSlug, p.title AS productTitle,
            SUM(CASE WHEN lr.selected_choice_index IS NOT NULL THEN 1 ELSE 0 END) AS quickChecksAttempted,
            SUM(CASE WHEN lr.is_correct = 1 THEN 1 ELSE 0 END) AS quickChecksCorrect,
            SUM(CASE WHEN lr.action_done = 1 THEN 1 ELSE 0 END) AS actionsCompleted,
            MAX(lr.updated_at) AS lastEngagedAt
     FROM library_learning_responses lr
     JOIN library_learning_items li ON li.id = lr.learning_item_id
     JOIN products p ON p.slug = li.product_slug
     WHERE lr.customer_id = ?
     GROUP BY p.slug
     ORDER BY lastEngagedAt DESC`
  )
    .bind(customerId)
    .all<StatsRow>();

  if (statsRows.length === 0) return [];

  const slugs = statsRows.map((r) => r.productSlug);
  const placeholders = slugs.map(() => '?').join(', ');
  const { results: totalsRows } = await env.DB.prepare(
    `SELECT product_slug AS productSlug, COUNT(*) AS total
     FROM library_learning_items
     WHERE product_slug IN (${placeholders}) AND status = 'published' AND archived_at IS NULL
     GROUP BY product_slug`
  )
    .bind(...slugs)
    .all<{ productSlug: string; total: number }>();
  const totalByProduct = new Map(totalsRows.map((r) => [r.productSlug, r.total]));

  return statsRows.map((row) => ({
    productSlug: row.productSlug,
    productTitle: row.productTitle,
    quickChecksAttempted: row.quickChecksAttempted,
    quickChecksCorrect: row.quickChecksCorrect,
    actionsCompleted: row.actionsCompleted,
    totalPublishedItems: totalByProduct.get(row.productSlug) ?? 0,
    itemsCompleted: Math.min(row.quickChecksAttempted + row.actionsCompleted, totalByProduct.get(row.productSlug) ?? 0),
    lastEngagedAt: row.lastEngagedAt,
  }));
}
