/**
 * Unit tests: services/admin/analyticsService.ts's Phase 8 (Digital
 * Library Observability) additions — getLibraryEngagement(),
 * getLibraryAiModeBreakdown(). Central concern: per-book isolation (an
 * event/message for Book A must never surface under Book B), the
 * resumeAccepted = shown - restarted computation, and the tracking-
 * start clamp applying to analytics_events-derived signals but not to
 * library_ai_messages (real server data since Phase 7C launch, not
 * part of the analytics_events system — see the service function's own
 * header comment).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getLibraryEngagement, getLibraryAiModeBreakdown } from '../../services/admin/analyticsService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG } from '../helpers';

const RANGE_WITHIN_TRACKING = { from: '2026-09-01', to: '2026-09-30' };
const RANGE_BEFORE_TRACKING = { from: '2020-01-01', to: '2020-01-31' };
const BOOK_B_SLUG = 'test-guide-book-b';

async function insertLibraryCtaEvent(ctaId: string, productSlug: string, createdAt = '2026-09-15 12:00:00'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO analytics_events (event_type, page_path, cta_id, session_id, product_slug, created_at)
     VALUES ('cta_click', '/dashboard/read/', ?, 'session-1', ?, ?)`
  )
    .bind(ctaId, productSlug, createdAt)
    .run();
}

async function seedBookB(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES ('prod-test-guide-b', ?, 'Test Guide B', 'investing', 'ebook', 'active', 3900, 'GHS', 'one-time', 'inclusive', 'en')`
  )
    .bind(BOOK_B_SLUG)
    .run();
}

async function seedAiMessage(customerId: number, purchaseReference: string, productSlug: string, mode: string, createdAt = '2026-09-15 12:00:00'): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO customers (id, email, status) VALUES (?, ?, 'active')`).bind(customerId, `lib-eng-${customerId}@example.com`).run();
  await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, expires_at, created_at)
     VALUES (?, ?, 'prod-x', 'X', 3900, 'GHS', 'verified', ?, datetime('now', '+30 minutes'), ?)`
  )
    .bind(purchaseReference, productSlug, customerId, createdAt)
    .run();
  await env.DB.prepare(
    `INSERT INTO library_ai_messages (customer_id, purchase_reference, asset_id, mode, question_text, status, confidence_tier, total_latency_ms, created_at)
     VALUES (?, ?, 'asset-x', ?, 'What is this?', 'answered', 'high', 100, ?)`
  )
    .bind(customerId, purchaseReference, mode, createdAt)
    .run();
}

describe('analyticsService — Phase 8 Digital Library Observability', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM analytics_events');
    await env.DB.exec('DELETE FROM library_ai_messages');
    await env.DB.exec('DELETE FROM purchase_sessions');
    await cleanupTestProduct(env as any);
    await env.DB.exec(`DELETE FROM products WHERE slug = '${BOOK_B_SLUG}'`);
    await env.DB.exec('DELETE FROM customers');
    await seedTestProduct(env as any);
    await seedBookB();
  });

  describe('getLibraryEngagement', () => {
    it('counts opens, citation clicks, and resume shown/restarted per book, computing resumeAccepted as shown-minus-restarted', async () => {
      await insertLibraryCtaEvent('library-reader-opened', TEST_PRODUCT_SLUG);
      await insertLibraryCtaEvent('library-reader-opened', TEST_PRODUCT_SLUG);
      await insertLibraryCtaEvent('library-ai-citation-click', TEST_PRODUCT_SLUG);
      await insertLibraryCtaEvent('library-resume-shown', TEST_PRODUCT_SLUG);
      await insertLibraryCtaEvent('library-resume-shown', TEST_PRODUCT_SLUG);
      await insertLibraryCtaEvent('library-resume-shown', TEST_PRODUCT_SLUG);
      await insertLibraryCtaEvent('library-resume-restarted', TEST_PRODUCT_SLUG);

      const rows = await getLibraryEngagement(env as any, RANGE_WITHIN_TRACKING);
      const row = rows.find((r) => r.slug === TEST_PRODUCT_SLUG)!;
      expect(row.opens).toBe(2);
      expect(row.citationClicks).toBe(1);
      expect(row.resumeShown).toBe(3);
      expect(row.resumeRestarted).toBe(1);
      expect(row.resumeAccepted).toBe(2);
    });

    it('never lets Book A events surface under Book B, or vice versa', async () => {
      await insertLibraryCtaEvent('library-reader-opened', TEST_PRODUCT_SLUG);
      await insertLibraryCtaEvent('library-reader-opened', BOOK_B_SLUG);
      await insertLibraryCtaEvent('library-reader-opened', BOOK_B_SLUG);

      const rows = await getLibraryEngagement(env as any, RANGE_WITHIN_TRACKING);
      expect(rows.find((r) => r.slug === TEST_PRODUCT_SLUG)!.opens).toBe(1);
      expect(rows.find((r) => r.slug === BOOK_B_SLUG)!.opens).toBe(2);
    });

    it('clamps opens/citations/resume signals to the tracking start date, but never clamps aiQuestions (real library_ai_messages data since Phase 7C launch)', async () => {
      await insertLibraryCtaEvent('library-reader-opened', TEST_PRODUCT_SLUG, '2020-01-15 12:00:00');
      await seedAiMessage(9001, 'RWL-LIBENG-001', TEST_PRODUCT_SLUG, 'ask', '2020-01-15 12:00:00');

      const rows = await getLibraryEngagement(env as any, RANGE_BEFORE_TRACKING);
      const row = rows.find((r) => r.slug === TEST_PRODUCT_SLUG)!;
      expect(row.opens).toBe(0); // clamped away — this range predates tracking
      expect(row.aiQuestions).toBe(1); // not clamped — real Phase 7C data
    });

    it('resolves aiQuestions per book via the purchase_reference -> product_slug join, isolated across books', async () => {
      await seedAiMessage(9002, 'RWL-LIBENG-002', TEST_PRODUCT_SLUG, 'explain');
      await seedAiMessage(9003, 'RWL-LIBENG-003', BOOK_B_SLUG, 'quiz');
      await seedAiMessage(9004, 'RWL-LIBENG-004', BOOK_B_SLUG, 'summarize');

      const rows = await getLibraryEngagement(env as any, RANGE_WITHIN_TRACKING);
      expect(rows.find((r) => r.slug === TEST_PRODUCT_SLUG)!.aiQuestions).toBe(1);
      expect(rows.find((r) => r.slug === BOOK_B_SLUG)!.aiQuestions).toBe(2);
    });
  });

  describe('getLibraryAiModeBreakdown', () => {
    it('groups by mode across all books, unclamped', async () => {
      await seedAiMessage(9005, 'RWL-LIBENG-005', TEST_PRODUCT_SLUG, 'explain');
      await seedAiMessage(9006, 'RWL-LIBENG-006', TEST_PRODUCT_SLUG, 'explain');
      await seedAiMessage(9007, 'RWL-LIBENG-007', BOOK_B_SLUG, 'quiz');

      const breakdown = await getLibraryAiModeBreakdown(env as any, RANGE_WITHIN_TRACKING);
      expect(breakdown.find((b) => b.label === 'explain')!.count).toBe(2);
      expect(breakdown.find((b) => b.label === 'quiz')!.count).toBe(1);
    });
  });
});
