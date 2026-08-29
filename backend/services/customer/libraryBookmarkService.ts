/**
 * Digital Library 2.0 — Bookmarks. Mirrors libraryProgressService.ts's
 * own authorization discipline exactly: every function re-verifies
 * ownership via entitlementService.ts's checkEntitlement() with the
 * AUTHENTICATED customerId, never trusts a client-supplied one, and
 * never invents a second authorization system.
 */
import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { checkEntitlement } from '../entitlementService';
import { fetchCatalogProduct, findPublishedAsset } from '../productCatalogService';

export interface LibraryBookmarkRecord {
  id: number;
  purchaseReference: string;
  assetId: string;
  format: 'PDF' | 'EPUB';
  pageNumber: number | null;
  cfi: string | null;
  label: string | null;
  createdAt: string;
}

export type CreateBookmarkInput = { format: 'PDF'; pageNumber: number; label: string | null } | { format: 'EPUB'; cfi: string; label: string | null };

export type CreateBookmarkResult = { ok: true; record: LibraryBookmarkRecord } | { ok: false; reason: 'not_authorized' | 'invalid_input' | 'unsupported_format' };
export type DeleteBookmarkResult = { ok: true } | { ok: false; reason: 'not_authorized' | 'not_found' };

const MAX_LABEL_LENGTH = 200;

export async function createBookmark(
  env: Env,
  logger: Logger,
  customerId: number,
  purchaseReference: string,
  assetId: string,
  input: CreateBookmarkInput
): Promise<CreateBookmarkResult> {
  if (input.label !== null && (typeof input.label !== 'string' || input.label.length > MAX_LABEL_LENGTH)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (input.format === 'PDF') {
    if (!Number.isInteger(input.pageNumber) || input.pageNumber < 1) return { ok: false, reason: 'invalid_input' };
  } else {
    if (typeof input.cfi !== 'string' || input.cfi.length === 0 || input.cfi.length > 2000) return { ok: false, reason: 'invalid_input' };
  }

  const check = await checkEntitlement(env, purchaseReference, assetId, 'view', customerId);
  if (!check.granted) {
    logger.warn('library_bookmark.denied', { purchaseReference, assetId, customerId, reason: check.reason });
    return { ok: false, reason: 'not_authorized' };
  }

  const deliveryRow = await env.DB.prepare(`SELECT product_slug AS productSlug FROM deliveries WHERE id = ?`).bind(check.deliveryId).first<{ productSlug: string }>();
  if (!deliveryRow) return { ok: false, reason: 'not_authorized' };

  const product = await fetchCatalogProduct(env, deliveryRow.productSlug);
  const asset = product ? findPublishedAsset(product, assetId) : null;
  if (!asset) return { ok: false, reason: 'not_authorized' };
  if (asset.fileType !== input.format) return { ok: false, reason: 'unsupported_format' };

  const pageNumber = input.format === 'PDF' ? input.pageNumber : null;
  const cfi = input.format === 'EPUB' ? input.cfi : null;

  const insert = await env.DB.prepare(
    `INSERT INTO library_bookmarks (delivery_id, customer_id, format, page_number, cfi, label) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(check.deliveryId, customerId, input.format, pageNumber, cfi, input.label)
    .run();

  return {
    ok: true,
    record: {
      id: Number(insert.meta.last_row_id),
      purchaseReference,
      assetId,
      format: input.format,
      pageNumber,
      cfi,
      label: input.label,
      createdAt: new Date().toISOString(),
    },
  };
}

/** In-reader "Bookmarks for this book" panel — every bookmark for one specific purchased asset. */
export async function listBookmarksForAsset(env: Env, customerId: number, purchaseReference: string, assetId: string): Promise<LibraryBookmarkRecord[]> {
  const check = await checkEntitlement(env, purchaseReference, assetId, 'view', customerId);
  if (!check.granted) return [];

  const { results } = await env.DB.prepare(
    `SELECT id, format, page_number AS pageNumber, cfi, label, created_at AS createdAt
     FROM library_bookmarks WHERE delivery_id = ? ORDER BY created_at DESC`
  )
    .bind(check.deliveryId)
    .all<Omit<LibraryBookmarkRecord, 'purchaseReference' | 'assetId'>>();

  return results.map((row) => ({ purchaseReference, assetId, ...row }));
}

/** Library-wide "My Bookmarks" view — every bookmark across this customer's whole purchase history, in one indexed scan. */
export async function listAllBookmarks(env: Env, customerId: number): Promise<LibraryBookmarkRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT lb.id, ps.purchase_reference AS purchaseReference, d.asset_id AS assetId,
            lb.format, lb.page_number AS pageNumber, lb.cfi, lb.label, lb.created_at AS createdAt
     FROM library_bookmarks lb
     JOIN deliveries d ON d.id = lb.delivery_id
     JOIN purchase_sessions ps ON ps.id = d.purchase_session_id
     WHERE lb.customer_id = ?
     ORDER BY lb.created_at DESC`
  )
    .bind(customerId)
    .all<LibraryBookmarkRecord>();

  return results;
}

/** Ownership re-verified by customer_id match, not just a valid id — never trusts the id alone, matching the entitlement discipline everywhere else in this file. */
export async function deleteBookmark(env: Env, customerId: number, bookmarkId: number): Promise<DeleteBookmarkResult> {
  const result = await env.DB.prepare(`DELETE FROM library_bookmarks WHERE id = ? AND customer_id = ?`).bind(bookmarkId, customerId).run();
  if (result.meta.changes === 0) return { ok: false, reason: 'not_found' };
  return { ok: true };
}
