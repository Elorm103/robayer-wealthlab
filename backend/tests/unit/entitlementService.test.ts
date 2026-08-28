/**
 * Unit tests: entitlementService.ts — Digital Library Phase 7A
 * (Personal Learning Library, Reader Foundation). No test file existed
 * for this service before this phase; these tests cover both the new
 * 'view' purpose (the non-consuming Read grant) and a regression guard
 * for the pre-existing 'download' purpose, to prove Phase 7A did not
 * change real-download behavior at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { checkEntitlement, generateDownloadPermission, redeemDownloadToken } from '../../services/entitlementService';
import { createLogger } from '../../utils/logger';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG, TEST_ASSET_ID } from '../helpers';

const logger = createLogger('test-request-id', 'test');

beforeEach(async () => {
  await env.DB.exec('DELETE FROM download_tokens');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
});

async function seedVerifiedPurchase(reference: string, opts: { maxDownloads?: number | null; downloadsUsed?: number; status?: string } = {}): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'))`
  )
    .bind(reference, TEST_PRODUCT_SLUG)
    .run();
  const purchaseSessionId = Number(insert.meta.last_row_id);

  await env.DB.prepare(
    `INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(purchaseSessionId, TEST_ASSET_ID, TEST_PRODUCT_SLUG, opts.maxDownloads === undefined ? 3 : opts.maxDownloads, opts.downloadsUsed ?? 0, opts.status ?? 'delivered')
    .run();

  return purchaseSessionId;
}

describe('generateDownloadPermission — purpose="view" (Phase 7A)', () => {
  it('grants a view token even when the download limit is already exhausted — reading does not draw from the download count', async () => {
    await seedVerifiedPurchase('RWL-2026-700001', { maxDownloads: 2, downloadsUsed: 2 });

    const download = await generateDownloadPermission(env as any, logger, 'RWL-2026-700001', TEST_ASSET_ID, 'download');
    expect(download.granted).toBe(false);
    if (!download.granted) expect(download.reason).toBe('download_limit_reached');

    const view = await generateDownloadPermission(env as any, logger, 'RWL-2026-700001', TEST_ASSET_ID, 'view');
    expect(view.granted).toBe(true);
  });

  it('still denies a view token for a revoked delivery — ownership integrity checks are not skipped, only the download-count check is', async () => {
    await seedVerifiedPurchase('RWL-2026-700002', { status: 'revoked' });
    const view = await generateDownloadPermission(env as any, logger, 'RWL-2026-700002', TEST_ASSET_ID, 'view');
    expect(view.granted).toBe(false);
    if (!view.granted) expect(view.reason).toBe('delivery_revoked');
  });

  it('still denies a view token for a purchase that never verified', async () => {
    await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at)
       VALUES ('RWL-2026-700003', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'pending', datetime('now', '+30 minutes'))`
    )
      .bind(TEST_PRODUCT_SLUG)
      .run();
    const view = await generateDownloadPermission(env as any, logger, 'RWL-2026-700003', TEST_ASSET_ID, 'view');
    expect(view.granted).toBe(false);
    if (!view.granted) expect(view.reason).toBe('purchase_not_verified');
  });

  it('defaults to purpose="download" when omitted — every pre-Phase-7A caller keeps its exact prior behavior', async () => {
    await seedVerifiedPurchase('RWL-2026-700004', { maxDownloads: 1, downloadsUsed: 1 });
    const result = await generateDownloadPermission(env as any, logger, 'RWL-2026-700004', TEST_ASSET_ID);
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe('download_limit_reached');
  });
});

describe('redeemDownloadToken — purpose branching (Phase 7A)', () => {
  it("redeeming a 'view' token never increments deliveries.downloads_used, and sets last_viewed_at instead of last_download_at", async () => {
    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-700010', { maxDownloads: 3, downloadsUsed: 1 });
    const permission = await generateDownloadPermission(env as any, logger, 'RWL-2026-700010', TEST_ASSET_ID, 'view');
    expect(permission.granted).toBe(true);
    if (!permission.granted) return;

    const redeemed = await redeemDownloadToken(env as any, logger, permission.token);
    expect(redeemed.ok).toBe(true);
    if (redeemed.ok) expect(redeemed.purpose).toBe('view');

    const delivery = await env.DB.prepare('SELECT downloads_used AS downloadsUsed, last_download_at AS lastDownloadAt, last_viewed_at AS lastViewedAt FROM deliveries WHERE purchase_session_id = ?')
      .bind(purchaseSessionId)
      .first<{ downloadsUsed: number; lastDownloadAt: string | null; lastViewedAt: string | null }>();
    expect(delivery!.downloadsUsed).toBe(1); // unchanged from the seeded value — a view never increments this
    expect(delivery!.lastDownloadAt).toBeNull();
    expect(delivery!.lastViewedAt).toBeTruthy();
  });

  it("redeeming a 'download' token still increments deliveries.downloads_used exactly as before Phase 7A — regression guard", async () => {
    const purchaseSessionId = await seedVerifiedPurchase('RWL-2026-700011', { maxDownloads: 3, downloadsUsed: 0 });
    const permission = await generateDownloadPermission(env as any, logger, 'RWL-2026-700011', TEST_ASSET_ID, 'download');
    expect(permission.granted).toBe(true);
    if (!permission.granted) return;

    const redeemed = await redeemDownloadToken(env as any, logger, permission.token);
    expect(redeemed.ok).toBe(true);
    if (redeemed.ok) expect(redeemed.purpose).toBe('download');

    const delivery = await env.DB.prepare('SELECT downloads_used AS downloadsUsed, last_download_at AS lastDownloadAt, last_viewed_at AS lastViewedAt FROM deliveries WHERE purchase_session_id = ?')
      .bind(purchaseSessionId)
      .first<{ downloadsUsed: number; lastDownloadAt: string | null; lastViewedAt: string | null }>();
    expect(delivery!.downloadsUsed).toBe(1);
    expect(delivery!.lastDownloadAt).toBeTruthy();
    expect(delivery!.lastViewedAt).toBeNull();
  });

  it('a view token, like a download token, is single-use — redeeming it twice fails the second time', async () => {
    await seedVerifiedPurchase('RWL-2026-700012');
    const permission = await generateDownloadPermission(env as any, logger, 'RWL-2026-700012', TEST_ASSET_ID, 'view');
    expect(permission.granted).toBe(true);
    if (!permission.granted) return;

    const first = await redeemDownloadToken(env as any, logger, permission.token);
    expect(first.ok).toBe(true);

    const second = await redeemDownloadToken(env as any, logger, permission.token);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('token_already_used');
  });

  it('a view token minted for one purchase cannot be redeemed against a different purchase\'s delivery — cross-purchase isolation', async () => {
    await seedVerifiedPurchase('RWL-2026-700013');
    const otherPurchaseSessionId = await seedVerifiedPurchase('RWL-2026-700014');

    const permission = await generateDownloadPermission(env as any, logger, 'RWL-2026-700013', TEST_ASSET_ID, 'view');
    expect(permission.granted).toBe(true);
    if (!permission.granted) return;

    const redeemed = await redeemDownloadToken(env as any, logger, permission.token);
    expect(redeemed.ok).toBe(true);

    // The token's delivery_id is bound at mint time to purchase 700013's
    // delivery row specifically — redemption can only ever have touched
    // that row, never the other purchase's, confirmed directly.
    const otherDelivery = await env.DB.prepare('SELECT last_viewed_at AS lastViewedAt FROM deliveries WHERE purchase_session_id = ?')
      .bind(otherPurchaseSessionId)
      .first<{ lastViewedAt: string | null }>();
    expect(otherDelivery!.lastViewedAt).toBeNull();
  });
});

describe('checkEntitlement — purpose="download" regression guard', () => {
  it('still denies download_limit_reached for purpose="download" exactly as before Phase 7A introduced the purpose parameter', async () => {
    await seedVerifiedPurchase('RWL-2026-700020', { maxDownloads: 1, downloadsUsed: 1 });
    const result = await checkEntitlement(env as any, 'RWL-2026-700020', TEST_ASSET_ID, 'download');
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe('download_limit_reached');
  });

  it('purpose="view" grants for the exact same exhausted-limit delivery', async () => {
    await seedVerifiedPurchase('RWL-2026-700021', { maxDownloads: 1, downloadsUsed: 1 });
    const result = await checkEntitlement(env as any, 'RWL-2026-700021', TEST_ASSET_ID, 'view');
    expect(result.granted).toBe(true);
  });
});
