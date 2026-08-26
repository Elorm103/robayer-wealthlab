/**
 * Unit tests: services/admin/analyticsService.ts's Reliable Sales
 * Funnel Measurement additions (migration 0046) — getSourceBreakdown,
 * getCampaignFunnel.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getSourceBreakdown, getCampaignFunnel, getSalesFunnel } from '../../services/admin/analyticsService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

const RANGE_WITHIN_TRACKING = { from: '2026-09-01', to: '2026-09-30' };

async function insertEvent(overrides: Partial<{
  eventType: string;
  pagePath: string;
  productSlug: string | null;
  sessionId: string;
  utmSource: string | null;
  utmCampaign: string | null;
  referrer: string | null;
  createdAt: string;
}> = {}): Promise<void> {
  const e = {
    eventType: 'page_view',
    pagePath: '/',
    productSlug: null,
    sessionId: 'session-1',
    utmSource: null,
    utmCampaign: null,
    referrer: null,
    createdAt: '2026-09-15 12:00:00',
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO analytics_events (event_type, page_path, session_id, product_slug, utm_source, utm_campaign, referrer, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(e.eventType, e.pagePath, e.sessionId, e.productSlug, e.utmSource, e.utmCampaign, e.referrer, e.createdAt)
    .run();
}

async function seedPurchase(overrides: Partial<{
  status: string;
  utmSource: string | null;
  utmCampaign: string | null;
  couponId: number | null;
  amountPesewas: number;
  createdAt: string;
}> = {}): Promise<number> {
  const p = {
    status: 'verified',
    utmSource: null,
    utmCampaign: null,
    couponId: null,
    amountPesewas: 3900,
    createdAt: '2026-09-10 08:00:00',
    ...overrides,
  };
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, utm_source, utm_campaign, coupon_id, verified_at, expires_at, created_at)
     VALUES (?, ?, 'prod-test-guide', 'Test Guide', ?, 'GHS', ?, ?, ?, ?, ?, datetime('now', '+30 minutes'), ?)`
  )
    .bind(
      `RWL-SRC-${Math.random().toString(36).slice(2)}`,
      TEST_PRODUCT_SLUG,
      p.amountPesewas,
      p.status,
      p.utmSource,
      p.utmCampaign,
      p.couponId,
      p.status === 'verified' ? p.createdAt : null,
      p.createdAt
    )
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedAdmin(): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', 'super_admin', 1)`
  )
    .bind(`funnel-test-admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedCampaign(adminId: number, overrides: Partial<{ subject: string; utmCampaign: string | null; recipients: number | null }> = {}): Promise<number> {
  const c = { subject: 'Test campaign', utmCampaign: null, recipients: 100, ...overrides };
  const insert = await env.DB.prepare(
    `INSERT INTO newsletter_campaigns (subject, body, status, utm_campaign, intended_recipient_count, created_by)
     VALUES (?, '<p>Body</p>', 'sent', ?, ?, ?)`
  )
    .bind(c.subject, c.utmCampaign, c.recipients, adminId)
    .run();
  return Number(insert.meta.last_row_id);
}

async function insertEmailLog(campaignId: number, status: string, count = 1): Promise<void> {
  for (let i = 0; i < count; i++) {
    await env.DB.prepare(
      `INSERT INTO email_log (template, recipient, entity_type, entity_id, status)
       VALUES ('newsletter-campaign', ?, 'newsletter_campaign', ?, ?)`
    )
      .bind(`recipient-${i}-${Math.random().toString(36).slice(2)}@example.com`, campaignId, status)
      .run();
  }
}

describe('analyticsService — Reliable Sales Funnel Measurement', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM analytics_events');
    await env.DB.exec('DELETE FROM download_tokens');
    await env.DB.exec('DELETE FROM deliveries');
    await env.DB.exec('DELETE FROM purchase_sessions');
    await env.DB.exec('DELETE FROM email_log');
    await env.DB.exec('DELETE FROM newsletter_campaigns');
    await env.DB.exec('DELETE FROM coupons'); // FK's to admin_users (created_by) — must go before that table is cleared below, or the next test's cleanup throws on a dangling reference.
    await env.DB.exec('DELETE FROM admin_users');
    await cleanupTestProduct(env as any);
    await seedTestProduct(env as any);
  });

  describe('getSourceBreakdown', () => {
    it('buckets sessions/views by utm_source and purchases/revenue by the same rule, unioned into one row per source', async () => {
      await insertEvent({ utmSource: 'fb', sessionId: 's1', createdAt: '2026-09-15 09:00:00' });
      await insertEvent({ utmSource: 'fb', eventType: 'product_view', productSlug: TEST_PRODUCT_SLUG, sessionId: 's1', createdAt: '2026-09-15 09:01:00' });
      await insertEvent({ utmSource: 'homepage_launch_spotlight', sessionId: 's2', createdAt: '2026-09-15 10:00:00' });
      await insertEvent({ sessionId: 's3', referrer: null, createdAt: '2026-09-15 11:00:00' }); // direct

      await seedPurchase({ utmSource: 'fb', status: 'verified', amountPesewas: 4000, createdAt: '2026-09-16 09:00:00' });
      await seedPurchase({ status: 'failed', createdAt: '2026-09-16 10:00:00' }); // no utm -> Direct/unattributed, not verified so no revenue

      const rows = await getSourceBreakdown(env as any, RANGE_WITHIN_TRACKING);
      const fb = rows.find((r) => r.source === 'Facebook');
      expect(fb).toBeDefined();
      expect(fb!.sessions).toBe(1);
      expect(fb!.productViews).toBe(1);
      expect(fb!.checkoutStarts).toBe(1);
      expect(fb!.purchases).toBe(1);
      expect(fb!.revenuePesewas).toBe(4000);

      const spotlight = rows.find((r) => r.source === 'Homepage Spotlight');
      expect(spotlight?.sessions).toBe(1);

      const direct = rows.find((r) => r.source === 'Direct');
      expect(direct?.sessions).toBe(1);

      const unattributed = rows.find((r) => r.source === 'Direct/unattributed');
      expect(unattributed?.checkoutStarts).toBe(1);
      expect(unattributed?.purchases).toBe(0);
    });

    it('clamps sessions/views to the tracking start date but never clamps purchase-session figures', async () => {
      await seedPurchase({ utmSource: 'fb', status: 'verified', amountPesewas: 4000, createdAt: '2020-01-01 09:00:00' });

      const rows = await getSourceBreakdown(env as any, { from: '2020-01-01', to: '2020-01-31' });
      const fb = rows.find((r) => r.source === 'Facebook');
      expect(fb?.sessions).toBe(0); // analytics_events figure clamped away — none seeded anyway
      expect(fb?.purchases).toBe(1); // purchase_sessions figure is real, unclamped history
      expect(fb?.revenuePesewas).toBe(4000);
    });
  });

  describe('getCampaignFunnel', () => {
    it('returns null for a campaign that does not exist', async () => {
      const funnel = await getCampaignFunnel(env as any, 999999);
      expect(funnel).toBeNull();
    });

    it('reports delivered/bounced from email_log but nulls every downstream stage when the campaign has no utm_campaign tag', async () => {
      const adminId = await seedAdmin();
      const campaignId = await seedCampaign(adminId, { utmCampaign: null });
      await insertEmailLog(campaignId, 'sent', 3);
      await insertEmailLog(campaignId, 'failed', 1);

      const funnel = await getCampaignFunnel(env as any, campaignId);
      expect(funnel).not.toBeNull();
      expect(funnel!.delivered).toBe(3);
      expect(funnel!.bounced).toBe(1);
      expect(funnel!.trackedOpens.value).toBeNull();
      expect(funnel!.ctaClicks.value).toBeNull();
      expect(funnel!.landingPageVisits).toBe(0);
      expect(funnel!.purchases).toBe(0);
    });

    it('joins the full chain through utm_campaign when the campaign has a tag, with trackedOpens always null and ctaClicks a labeled proxy', async () => {
      const adminId = await seedAdmin();
      const campaignId = await seedCampaign(adminId, { utmCampaign: 'checked_not_copied_launch', recipients: 250 });
      await insertEmailLog(campaignId, 'sent', 250);

      await insertEvent({ eventType: 'page_view', utmCampaign: 'checked_not_copied_launch', sessionId: 'e1', createdAt: '2026-09-15 09:00:00' });
      await insertEvent({ eventType: 'page_view', utmCampaign: 'checked_not_copied_launch', sessionId: 'e2', createdAt: '2026-09-15 09:05:00' });
      await insertEvent({ eventType: 'product_view', utmCampaign: 'checked_not_copied_launch', productSlug: TEST_PRODUCT_SLUG, sessionId: 'e1', createdAt: '2026-09-15 09:01:00' });

      const purchaseId = await seedPurchase({ utmCampaign: 'checked_not_copied_launch', status: 'verified', amountPesewas: 4000, couponId: null, createdAt: '2026-09-15 09:10:00' });
      const deliveryInsert = await env.DB.prepare(
        `INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, status) VALUES (?, 'asset-test-guide-pdf-v1', ?, 'ready')`
      )
        .bind(purchaseId, TEST_PRODUCT_SLUG)
        .run();
      const deliveryId = Number(deliveryInsert.meta.last_row_id);
      await env.DB.prepare(
        `INSERT INTO download_tokens (token, delivery_id, expires_at, used_at) VALUES ('tok-campaign-1', ?, datetime('now', '+10 minutes'), '2026-09-15 09:20:00')`
      )
        .bind(deliveryId)
        .run();

      const funnel = await getCampaignFunnel(env as any, campaignId);
      expect(funnel).not.toBeNull();
      expect(funnel!.utmCampaign).toBe('checked_not_copied_launch');
      expect(funnel!.recipients).toBe(250);
      expect(funnel!.delivered).toBe(250);
      expect(funnel!.trackedOpens.value).toBeNull();
      expect(funnel!.trackedOpens.label).toMatch(/cannot currently be determined/);
      expect(funnel!.ctaClicks.value).toBe(2); // proxy: distinct sessions on first-touch page_view
      expect(funnel!.landingPageVisits).toBe(2);
      expect(funnel!.productViews).toBe(1);
      expect(funnel!.checkoutStarts).toBe(1);
      expect(funnel!.purchases).toBe(1);
      expect(funnel!.revenuePesewas).toBe(4000);
      expect(funnel!.downloads).toBe(1);
    });
  });

  describe('getSalesFunnel — Admin Analytics Dashboard v2', () => {
    /** purchase_sessions.coupon_id has a real FK to coupons(id) — unlike utm_campaign/utm_source, this one IS enforced, so a real coupons row (and the admin_users row its own created_by references) must exist first. */
    async function seedCoupon(): Promise<number> {
      const adminInsert = await env.DB.prepare(
        `INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', 'super_admin', 1)`
      )
        .bind(`funnel-coupon-admin-${Math.random().toString(36).slice(2)}@example.com`)
        .run();
      const adminId = Number(adminInsert.meta.last_row_id);
      const couponInsert = await env.DB.prepare(
        `INSERT INTO coupons (code, discount_type, discount_value, created_by) VALUES (?, 'percentage', 10, ?)`
      )
        .bind(`FUNNELTEST${Math.random().toString(36).slice(2, 8).toUpperCase()}`, adminId)
        .run();
      return Number(couponInsert.meta.last_row_id);
    }

    it('returns the four-stage Visitors → Book Views → Checkout Starts → Purchases chain, plus Coupon Applications as a related (non-forced) stat', async () => {
      await insertEvent({ eventType: 'page_view', sessionId: 's1', createdAt: '2026-09-15 09:00:00' });
      await insertEvent({ eventType: 'page_view', sessionId: 's2', createdAt: '2026-09-15 09:05:00' });
      await insertEvent({ eventType: 'product_view', productSlug: TEST_PRODUCT_SLUG, sessionId: 's1', createdAt: '2026-09-15 09:01:00' });

      await seedPurchase({ status: 'verified', couponId: null, amountPesewas: 4000, createdAt: '2026-09-15 09:10:00' });
      const couponId = await seedCoupon();
      await seedPurchase({ status: 'failed', couponId, createdAt: '2026-09-15 09:11:00' });

      const funnel = await getSalesFunnel(env as any, RANGE_WITHIN_TRACKING);
      expect(funnel.visitors).toBe(2);
      expect(funnel.bookViews).toBe(1);
      expect(funnel.checkoutStarts).toBe(2);
      expect(funnel.couponApplications).toBe(1);
      expect(funnel.purchases).toBe(1);
      expect(funnel.visitorsClamped).toBe(false);
    });

    it('clamps visitors/bookViews to the tracking start date but never clamps checkoutStarts/couponApplications/purchases (real, unclamped purchase_sessions history)', async () => {
      const couponId = await seedCoupon();
      await seedPurchase({ status: 'verified', couponId, amountPesewas: 4000, createdAt: '2020-01-01 09:00:00' });

      const funnel = await getSalesFunnel(env as any, { from: '2020-01-01', to: '2020-01-31' });
      expect(funnel.visitors).toBe(0);
      expect(funnel.bookViews).toBe(0);
      expect(funnel.checkoutStarts).toBe(1);
      expect(funnel.couponApplications).toBe(1);
      expect(funnel.purchases).toBe(1);
      expect(funnel.visitorsClamped).toBe(true);
    });

    it('returns all zeros for a range with no activity at all, never an error or a fabricated number', async () => {
      const funnel = await getSalesFunnel(env as any, RANGE_WITHIN_TRACKING);
      expect(funnel).toEqual({ visitors: 0, bookViews: 0, checkoutStarts: 0, couponApplications: 0, purchases: 0, visitorsClamped: false });
    });
  });
});
