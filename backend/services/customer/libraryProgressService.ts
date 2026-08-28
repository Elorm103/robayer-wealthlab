/**
 * Digital Library Phase 7B (Personal Reading Experience) — real,
 * server-persisted reading position. The capability the Phase 1-4
 * report explicitly deferred until a real in-browser reader existed
 * to report a genuine signal (Phase 7A shipped that reader); this is
 * the first thing that actually writes to it.
 *
 * Every function here re-verifies ownership via
 * entitlementService.ts's checkEntitlement(), passing the AUTHENTICATED
 * customerId — the one check that function never made before this
 * phase (see its own header comment on why Download/Read never needed
 * it and progress does). No parallel authorization system: this is the
 * exact same function every other entitlement decision in this
 * codebase already goes through, just with one more argument.
 *
 * percent_complete and status are always derived here, server-side,
 * from current_page/total_pages — never accepted as raw input from the
 * client. A customer's browser can report "I am on page 40 of 42," it
 * cannot report "I am 95% done" and have that trusted directly.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { checkEntitlement } from '../entitlementService';
import { fetchCatalogProduct, findPublishedAsset } from '../productCatalogService';

export type ProgressStatus = 'not_started' | 'in_progress' | 'completed';

export interface LibraryProgressRecord {
  purchaseReference: string;
  assetId: string;
  format: 'PDF' | 'EPUB';
  currentPage: number | null;
  totalPages: number | null;
  percentComplete: number;
  status: ProgressStatus;
  lastReadAt: string | null;
}

export type UpsertProgressResult =
  | { ok: true; record: LibraryProgressRecord }
  | { ok: false; reason: 'not_authorized' | 'invalid_input' | 'unsupported_format' };

interface ProgressRow {
  purchaseReference: string;
  assetId: string;
  format: 'PDF' | 'EPUB';
  currentPage: number | null;
  totalPages: number | null;
  percentComplete: number;
  status: ProgressStatus;
  lastReadAt: string | null;
}

function deriveStatus(percentComplete: number): ProgressStatus {
  if (percentComplete >= 100) return 'completed';
  if (percentComplete > 0) return 'in_progress';
  return 'not_started';
}

/**
 * Called on every page change from the reader (client-side debounced —
 * see js/components/library-reader.js — this function itself has no
 * debounce logic of its own, callers are responsible for not calling
 * it too often). PDF-only for Phase 7B: an EPUB asset is rejected with
 * 'unsupported_format' rather than silently accepted with meaningless
 * page numbers — the reader itself never reaches this call for an
 * EPUB asset (it doesn't render one at all yet), so this is a defense-
 * in-depth check, not the primary gate.
 */
export async function upsertLibraryProgress(
  env: Env,
  logger: Logger,
  customerId: number,
  purchaseReference: string,
  assetId: string,
  input: { currentPage: number; totalPages: number }
): Promise<UpsertProgressResult> {
  if (
    !Number.isInteger(input.currentPage) ||
    !Number.isInteger(input.totalPages) ||
    input.totalPages < 1 ||
    input.currentPage < 1 ||
    input.currentPage > input.totalPages
  ) {
    return { ok: false, reason: 'invalid_input' };
  }

  const check = await checkEntitlement(env, purchaseReference, assetId, 'view', customerId);
  if (!check.granted) {
    logger.warn('library_progress.denied', { purchaseReference, assetId, customerId, reason: check.reason });
    return { ok: false, reason: 'not_authorized' };
  }

  return upsertByDeliveryId(env, check.deliveryId, customerId, purchaseReference, assetId, input);
}

async function upsertByDeliveryId(
  env: Env,
  deliveryId: number,
  customerId: number,
  purchaseReference: string,
  assetId: string,
  input: { currentPage: number; totalPages: number }
): Promise<UpsertProgressResult> {
  const deliveryRow = await env.DB.prepare(`SELECT product_slug AS productSlug FROM deliveries WHERE id = ?`).bind(deliveryId).first<{ productSlug: string }>();
  if (!deliveryRow) return { ok: false, reason: 'not_authorized' };

  const product = await fetchCatalogProduct(env, deliveryRow.productSlug);
  const asset = product ? findPublishedAsset(product, assetId) : null;
  if (!asset) return { ok: false, reason: 'not_authorized' };
  if (asset.fileType !== 'PDF') return { ok: false, reason: 'unsupported_format' };

  const percentComplete = Math.round((input.currentPage / input.totalPages) * 100);
  const status = deriveStatus(percentComplete);

  await env.DB.prepare(
    `INSERT INTO library_progress (delivery_id, customer_id, format, current_page, total_pages, percent_complete, status, last_read_at, updated_at)
     VALUES (?, ?, 'PDF', ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(delivery_id) DO UPDATE SET
       current_page = excluded.current_page,
       total_pages = excluded.total_pages,
       percent_complete = excluded.percent_complete,
       status = excluded.status,
       last_read_at = excluded.last_read_at,
       updated_at = excluded.updated_at`
  )
    .bind(deliveryId, customerId, input.currentPage, input.totalPages, percentComplete, status)
    .run();

  return {
    ok: true,
    record: {
      purchaseReference,
      assetId,
      format: 'PDF',
      currentPage: input.currentPage,
      totalPages: input.totalPages,
      percentComplete,
      status,
      lastReadAt: new Date().toISOString(),
    },
  };
}

/** Read path for the reader's own "resume where you left off" check on open. */
export async function getLibraryProgress(env: Env, customerId: number, purchaseReference: string, assetId: string): Promise<LibraryProgressRecord | null> {
  const check = await checkEntitlement(env, purchaseReference, assetId, 'view', customerId);
  if (!check.granted) return null;

  const row = await env.DB.prepare(
    `SELECT format, current_page AS currentPage, total_pages AS totalPages, percent_complete AS percentComplete, status, last_read_at AS lastReadAt
     FROM library_progress WHERE delivery_id = ?`
  )
    .bind(check.deliveryId)
    .first<Omit<ProgressRow, 'purchaseReference' | 'assetId'>>();
  if (!row) return null;

  return { purchaseReference, assetId, ...row };
}

/**
 * Bulk read for the Library page — every in-progress/completed
 * resource across this customer's whole purchase history, in one
 * indexed query (idx_library_progress_customer), never N+1 requests
 * per card.
 */
export async function listLibraryProgress(env: Env, customerId: number): Promise<LibraryProgressRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT ps.purchase_reference AS purchaseReference, d.asset_id AS assetId,
            lp.format, lp.current_page AS currentPage, lp.total_pages AS totalPages,
            lp.percent_complete AS percentComplete, lp.status, lp.last_read_at AS lastReadAt
     FROM library_progress lp
     JOIN deliveries d ON d.id = lp.delivery_id
     JOIN purchase_sessions ps ON ps.id = d.purchase_session_id
     WHERE lp.customer_id = ?
     ORDER BY lp.last_read_at DESC`
  )
    .bind(customerId)
    .all<ProgressRow>();

  return results;
}
