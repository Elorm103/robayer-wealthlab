/**
 * Unit tests: services/admin/analyticsService.ts's Analytics &
 * User-Activity Baseline additions (migration 0045) — getGrowthSummary,
 * getOnlineNowCount, getPerBookFunnel, getDeviceBreakdown,
 * getCountryBreakdown.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getGrowthSummary,
  getOnlineNowCount,
  getPerBookFunnel,
  getDeviceBreakdown,
  getCountryBreakdown,
  getTimeseries,
} from '../../services/admin/analyticsService';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

const RANGE_WITHIN_TRACKING = { from: '2026-09-01', to: '2026-09-30' };
const RANGE_BEFORE_TRACKING = { from: '2020-01-01', to: '2020-01-31' };

async function insertEvent(overrides: Partial<{
  eventType: string;
  pagePath: string;
  productSlug: string | null;
  sessionId: string;
  deviceType: string | null;
  country: string | null;
  createdAt: string;
}> = {}): Promise<void> {
  const e = {
    eventType: 'page_view',
    pagePath: '/',
    productSlug: null,
    sessionId: 'session-1',
    deviceType: null,
    country: null,
    createdAt: '2026-09-15 12:00:00',
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO analytics_events (event_type, page_path, session_id, product_slug, device_type, country, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(e.eventType, e.pagePath, e.sessionId, e.productSlug, e.deviceType, e.country, e.createdAt)
    .run();
}

async function seedPurchase(status: string, verifiedAt: string | null, amountPesewas = 3900): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at, created_at)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', ?, 'GHS', ?, ?, datetime('now', '+30 minutes'), '2026-09-10 08:00:00')`
  )
    .bind(`RWL-FUNNEL-${Math.random().toString(36).slice(2)}`, TEST_PRODUCT_SLUG, amountPesewas, status, verifiedAt)
    .run();
  return Number(insert.meta.last_row_id);
}

describe('analyticsService — Analytics & User-Activity Baseline', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM analytics_events');
    await env.DB.exec('DELETE FROM download_tokens');
    await env.DB.exec('DELETE FROM deliveries');
    await env.DB.exec('DELETE FROM purchase_sessions');
    await cleanupTestProduct(env as any);
    await env.DB.exec('DELETE FROM customer_profiles');
    await env.DB.exec('DELETE FROM customers');
    await seedTestProduct(env as any);
  });

  describe('getGrowthSummary', () => {
    it('counts customers created in range as registeredUsers, and distinct session_ids as uniqueVisitors', async () => {
      const { customerId } = await findOrCreateCustomer(env as any, 'growth-1@example.com', false);
      // findOrCreateCustomer stamps the real current time; back-date it into the fixed test range so this assertion doesn't depend on when the suite happens to run.
      await env.DB.prepare(`UPDATE customers SET created_at = '2026-09-05 08:00:00' WHERE id = ?`).bind(customerId).run();
      await insertEvent({ sessionId: 'a', createdAt: '2026-09-05 10:00:00' });
      await insertEvent({ sessionId: 'a', createdAt: '2026-09-05 10:05:00' }); // same session, second page view — should not double-count
      await insertEvent({ sessionId: 'b', createdAt: '2026-09-06 10:00:00' });

      const summary = await getGrowthSummary(env as any, RANGE_WITHIN_TRACKING);
      expect(summary.registeredUsers.current).toBe(1);
      expect(summary.uniqueVisitors.current).toBe(2);
      expect(summary.visitorsClamped).toBe(false);
    });

    it('clamps the visitor figure to the tracking start date and reports clamped=true for a range starting earlier', async () => {
      const summary = await getGrowthSummary(env as any, RANGE_BEFORE_TRACKING);
      expect(summary.uniqueVisitors.current).toBe(0);
      expect(summary.visitorsClamped).toBe(true);
    });
  });

  describe('getOnlineNowCount', () => {
    it('counts KV keys under the online: prefix, never a database row', async () => {
      await env.RATE_LIMIT_KV.put('online:session:test-a', '1', { expirationTtl: 90 });
      await env.RATE_LIMIT_KV.put('online:session:test-b', '1', { expirationTtl: 90 });

      const count = await getOnlineNowCount(env as any);
      expect(count).toBeGreaterThanOrEqual(2);

      const eventsRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM analytics_events').first<{ c: number }>();
      expect(eventsRow?.c ?? 0).toBe(0);
    });
  });

  describe('getPerBookFunnel', () => {
    it('returns one row per real product with views/checkoutStarts/purchases/revenue/downloads/conversionRate', async () => {
      await insertEvent({ eventType: 'product_view', productSlug: TEST_PRODUCT_SLUG, sessionId: 'v1', createdAt: '2026-09-12 09:00:00' });
      await insertEvent({ eventType: 'product_view', productSlug: TEST_PRODUCT_SLUG, sessionId: 'v2', createdAt: '2026-09-13 09:00:00' });

      await seedPurchase('failed', null);
      const verifiedPurchaseId = await seedPurchase('verified', '2026-09-14 09:00:00');

      const deliveryInsert = await env.DB.prepare(
        `INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, status)
         VALUES (?, 'asset-test-guide-pdf-v1', ?, 'ready')`
      )
        .bind(verifiedPurchaseId, TEST_PRODUCT_SLUG)
        .run();
      const deliveryId = Number(deliveryInsert.meta.last_row_id);
      await env.DB.prepare(
        `INSERT INTO download_tokens (token, delivery_id, expires_at, used_at) VALUES ('tok-1', ?, datetime('now', '+10 minutes'), '2026-09-14 10:00:00')`
      )
        .bind(deliveryId)
        .run();

      const rows = await getPerBookFunnel(env as any, RANGE_WITHIN_TRACKING);
      const row = rows.find((r) => r.slug === TEST_PRODUCT_SLUG);
      expect(row).toBeDefined();
      expect(row!.views).toBe(2);
      expect(row!.checkoutStarts).toBe(2);
      expect(row!.purchases).toBe(1);
      expect(row!.revenuePesewas).toBe(3900);
      expect(row!.downloads).toBe(1);
      expect(row!.conversionRate).toBe(50);
    });

    it('reports null conversionRate when there are zero views, rather than dividing by zero', async () => {
      await seedPurchase('verified', '2026-09-14 09:00:00');
      const rows = await getPerBookFunnel(env as any, RANGE_WITHIN_TRACKING);
      const row = rows.find((r) => r.slug === TEST_PRODUCT_SLUG);
      expect(row!.views).toBe(0);
      expect(row!.conversionRate).toBeNull();
    });

    it('suppresses conversionRate (null, not an impossible percentage) when purchases exceed views — the real, expected shape right after this feature launches on a book with years of purchase history but only hours of view-tracking', async () => {
      await insertEvent({ eventType: 'product_view', productSlug: TEST_PRODUCT_SLUG, sessionId: 'v1', createdAt: '2026-09-12 09:00:00' });
      await seedPurchase('verified', '2026-09-13 09:00:00');
      await seedPurchase('verified', '2026-09-14 09:00:00');
      await seedPurchase('verified', '2026-09-15 09:00:00');

      const rows = await getPerBookFunnel(env as any, RANGE_WITHIN_TRACKING);
      const row = rows.find((r) => r.slug === TEST_PRODUCT_SLUG);
      expect(row!.views).toBe(1);
      expect(row!.purchases).toBe(3);
      expect(row!.conversionRate).toBeNull();
    });
  });

  describe('getDeviceBreakdown / getCountryBreakdown', () => {
    it('groups page_view/product_view events by device_type and country, clamped to tracking start', async () => {
      await insertEvent({ deviceType: 'mobile', country: 'GH', sessionId: 'd1', createdAt: '2026-09-15 09:00:00' });
      await insertEvent({ deviceType: 'mobile', country: 'GH', sessionId: 'd2', createdAt: '2026-09-15 10:00:00' });
      await insertEvent({ deviceType: 'desktop', country: 'US', sessionId: 'd3', createdAt: '2026-09-15 11:00:00' });
      await insertEvent({ eventType: 'cta_click', deviceType: 'mobile', country: 'GH', sessionId: 'd1', createdAt: '2026-09-15 09:01:00' }); // not a view — must be excluded

      const devices = await getDeviceBreakdown(env as any, RANGE_WITHIN_TRACKING);
      expect(devices.find((d) => d.label === 'mobile')?.count).toBe(2);
      expect(devices.find((d) => d.label === 'desktop')?.count).toBe(1);

      const geo = await getCountryBreakdown(env as any, RANGE_WITHIN_TRACKING);
      expect(geo.find((g) => g.label === 'GH')?.count).toBe(2);
      expect(geo.find((g) => g.label === 'US')?.count).toBe(1);
    });

    it('returns nothing for a range entirely before the tracking start date', async () => {
      await insertEvent({ deviceType: 'mobile', country: 'GH', createdAt: '2026-09-15 09:00:00' });
      const devices = await getDeviceBreakdown(env as any, RANGE_BEFORE_TRACKING);
      expect(devices).toEqual([]);
    });
  });

  describe('getTimeseries — "All time" regression guard', () => {
    // The "All time" preset's far-future sentinel ('0001-01-01'..
    // '9998-12-31', see routes/admin/analytics.ts's parseRange()) is
    // cheap for a plain SQL SUM/COUNT, but getTimeseries() zero-fills
    // one array entry per calendar day — un-clamped, that range would
    // materialize millions of entries. This also guards the narrower,
    // second bug this exposed: exclusiveEndDate() on a literal
    // '9999-12-31' rolls into year 10000, whose ISO extended-year
    // string ("+010000-...") sorts BEFORE any real date in a plain TEXT
    // comparison — silently matching zero rows instead of everything.
    it('bounds a multi-millennium range to a real, recent window instead of materializing millions of days', async () => {
      const result = await getTimeseries(env as any, { from: '0001-01-01', to: '9998-12-31' });
      expect(result.ordersPerDay.length).toBeLessThanOrEqual(366);
      expect(result.subscribersPerDay.length).toBeLessThanOrEqual(366);
    });

    it('still finds real rows within the clamped window under an "All time" range, rather than the exclusiveEndDate rollover silently excluding everything', async () => {
      const todayStr = new Date().toISOString().slice(0, 10);
      await env.DB.prepare(
        `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, verified_at, expires_at)
         VALUES ('RWL-TS-ALLTIME-0001', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', ?, datetime('now', '+30 minutes'))`
      )
        .bind(TEST_PRODUCT_SLUG, `${todayStr} 12:00:00`)
        .run();

      const result = await getTimeseries(env as any, { from: '0001-01-01', to: '9998-12-31' });
      const todayPoint = result.ordersPerDay.find((p) => p.date === todayStr);
      expect(todayPoint?.count).toBe(1);
    });
  });
});
