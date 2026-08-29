/**
 * Integration tests: GET /api/customer/library/recommendations —
 * Digital Library Modernization (Phase 5). See
 * backend/services/customer/libraryRecommendationsService.ts's own
 * header comment for the full reasoning: reuses the existing,
 * admin-curated product_relations table, scoped to what the
 * authenticated customer actually owns.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession } from '../../services/customer/sessionService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM library_progress');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM product_relations');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  // product_files/media_assets carry a real FK to products(id) - a
  // sibling test file's seedTestProduct() call can leave rows behind
  // that would otherwise block DELETE FROM products below.
  await env.DB.exec('DELETE FROM product_files');
  await env.DB.exec('DELETE FROM media_assets');
  await env.DB.exec('DELETE FROM products');
});

async function seedProduct(slug: string, title: string, status = 'active', topic = 'investing'): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES (?, ?, ?, ?, 'ebook', ?, 3900, 'GHS', 'one-time', 'inclusive', 'en')`
  )
    .bind(`prod-${slug}`, slug, title, topic, status)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedCustomerOwning(email: string, productSlugs: string[]): Promise<{ cookieHeader: string; customerId: number }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const session = await createSession(env as any, customerId, { ip: null, userAgent: null });
  for (const [i, slug] of productSlugs.entries()) {
    await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, customer_id)
       VALUES (?, ?, ?, ?, 3900, 'GHS', 'verified', datetime('now', '+30 minutes'), ?)`
    )
      .bind(`RWL-2026-70${String(i).padStart(4, '0')}`, slug, `prod-${slug}`, slug, customerId)
      .run();
  }
  return { cookieHeader: `customer_session=${session.sessionToken}`, customerId };
}

/** Seeds a real library_progress row for an owned product's purchase reference - the same delivery+progress shape libraryProgressService.ts itself writes, used here only to exercise the recommendation reason's reading-status phrasing. */
async function seedProgress(customerId: number, purchaseReference: string, status: 'in_progress' | 'completed', lastReadAt: string): Promise<void> {
  const purchase = await env.DB.prepare(`SELECT id, product_slug AS productSlug FROM purchase_sessions WHERE purchase_reference = ?`).bind(purchaseReference).first<{ id: number; productSlug: string }>();
  const deliveryInsert = await env.DB.prepare(
    `INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) VALUES (?, 'asset-pdf', ?, 10, 0, 'delivered')`
  )
    .bind(purchase!.id, purchase!.productSlug)
    .run();
  const percentComplete = status === 'completed' ? 100 : 40;
  await env.DB.prepare(
    `INSERT INTO library_progress (delivery_id, customer_id, format, current_page, total_pages, cfi, percent_complete, status, last_read_at, updated_at)
     VALUES (?, ?, 'PDF', ?, 100, NULL, ?, ?, ?, ?)`
  )
    .bind(Number(deliveryInsert.meta.last_row_id), customerId, status === 'completed' ? 100 : 40, percentComplete, status, lastReadAt, lastReadAt)
    .run();
}

describe('GET /api/customer/library/recommendations', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations');
    expect(res.status).toBe(401);
  });

  it('returns an empty list for a customer who owns nothing, never an error', async () => {
    const { customerId } = await findOrCreateCustomer(env as any, 'owns-nothing@example.com', false);
    const session = await createSession(env as any, customerId, { ip: null, userAgent: null });

    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', {
      headers: { Cookie: `customer_session=${session.sessionToken}` },
    });
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect(body.data.recommendations).toEqual([]);
  });

  it('recommends a related product with the correct "because of" title, and excludes it once purchased', async () => {
    const ownedId = await seedProduct('ghana-stock-exchange', 'Understanding the Ghana Stock Exchange');
    const relatedId = await seedProduct('treasury-bills', 'Treasury Bills Made Simple');
    await env.DB.prepare(`INSERT INTO product_relations (product_id, related_product_id, relation_type, sort_order) VALUES (?, ?, 'recommended', 0)`)
      .bind(ownedId, relatedId)
      .run();

    const { cookieHeader } = await seedCustomerOwning('owns-one@example.com', ['ghana-stock-exchange']);
    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.recommendations).toHaveLength(1);
    expect(body.data.recommendations[0].slug).toBe('treasury-bills');
    expect(body.data.recommendations[0].becauseOfProductTitle).toBe('Understanding the Ghana Stock Exchange');
    expect(body.data.recommendations[0].relationType).toBe('recommended');

    // Once the customer also owns the recommended product, it must
    // disappear from their recommendations - never suggest what they
    // already have.
    await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, expires_at, customer_id)
       VALUES ('RWL-2026-709999', 'treasury-bills', 'prod-treasury-bills', 'Treasury Bills Made Simple', 3900, 'GHS', 'verified', datetime('now', '+30 minutes'),
               (SELECT id FROM customers WHERE email = 'owns-one@example.com'))`
    ).run();
    const res2 = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body2 = await res2.json<any>();
    expect(body2.data.recommendations).toEqual([]);
  });

  it('never recommends a draft/hidden/archived product, even if a relation exists', async () => {
    const ownedId = await seedProduct('owned-book', 'Owned Book');
    const draftId = await seedProduct('draft-book', 'Not Yet Live Book', 'draft');
    await env.DB.prepare(`INSERT INTO product_relations (product_id, related_product_id, relation_type, sort_order) VALUES (?, ?, 'related', 0)`)
      .bind(ownedId, draftId)
      .run();

    const { cookieHeader } = await seedCustomerOwning('draft-check@example.com', ['owned-book']);
    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.recommendations).toEqual([]);
  });

  it('never recommends a coming-soon product - only genuinely purchasable ("active") products are recommended', async () => {
    const ownedId = await seedProduct('owned-book-2', 'Owned Book Two');
    const comingSoonId = await seedProduct('coming-soon-book', 'Not Yet Purchasable Book', 'coming-soon');
    await env.DB.prepare(`INSERT INTO product_relations (product_id, related_product_id, relation_type, sort_order) VALUES (?, ?, 'related', 0)`)
      .bind(ownedId, comingSoonId)
      .run();

    const { cookieHeader } = await seedCustomerOwning('coming-soon-check@example.com', ['owned-book-2']);
    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.recommendations).toEqual([]);
  });

  it('caps recommendations at 3 and never duplicates a product recommended by more than one owned book', async () => {
    const owned1 = await seedProduct('owned-a', 'Owned A');
    const owned2 = await seedProduct('owned-b', 'Owned B');
    const rec1 = await seedProduct('rec-1', 'Recommendation One');
    const rec2 = await seedProduct('rec-2', 'Recommendation Two');
    const rec3 = await seedProduct('rec-3', 'Recommendation Three');
    const rec4 = await seedProduct('rec-4', 'Recommendation Four');

    // rec-1 is related to BOTH owned books - must appear only once.
    await env.DB.prepare(`INSERT INTO product_relations (product_id, related_product_id, relation_type, sort_order) VALUES (?, ?, 'related', 0)`).bind(owned1, rec1).run();
    await env.DB.prepare(`INSERT INTO product_relations (product_id, related_product_id, relation_type, sort_order) VALUES (?, ?, 'related', 1)`).bind(owned1, rec2).run();
    await env.DB.prepare(`INSERT INTO product_relations (product_id, related_product_id, relation_type, sort_order) VALUES (?, ?, 'related', 0)`).bind(owned2, rec1).run();
    await env.DB.prepare(`INSERT INTO product_relations (product_id, related_product_id, relation_type, sort_order) VALUES (?, ?, 'related', 1)`).bind(owned2, rec3).run();
    await env.DB.prepare(`INSERT INTO product_relations (product_id, related_product_id, relation_type, sort_order) VALUES (?, ?, 'related', 2)`).bind(owned2, rec4).run();

    const { cookieHeader } = await seedCustomerOwning('cap-check@example.com', ['owned-a', 'owned-b']);
    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.recommendations).toHaveLength(3);
    const slugs = body.data.recommendations.map((r: any) => r.slug);
    expect(new Set(slugs).size).toBe(3); // no duplicates
  });

  // ============================================================
  // Digital Library 2.0 Phase G — topic-match fallback signal.
  // ============================================================

  it('falls back to a topic match when no explicit relation exists, with an honest reason and relationType', async () => {
    await seedProduct('owned-investing-book', 'Owned Investing Book', 'active', 'investing');
    await seedProduct('other-investing-book', 'Other Investing Book', 'active', 'investing');

    const { cookieHeader } = await seedCustomerOwning('topic-match@example.com', ['owned-investing-book']);
    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();

    expect(body.data.recommendations).toHaveLength(1);
    expect(body.data.recommendations[0].slug).toBe('other-investing-book');
    expect(body.data.recommendations[0].relationType).toBe('topic_match');
    expect(body.data.recommendations[0].reason).toBe('Another guide in Investing.');
  });

  it('never topic-matches across different topics', async () => {
    await seedProduct('owned-mindset-book', 'Owned Mindset Book', 'active', 'mindset');
    await seedProduct('unrelated-investing-book', 'Unrelated Investing Book', 'active', 'investing');

    const { cookieHeader } = await seedCustomerOwning('no-cross-topic@example.com', ['owned-mindset-book']);
    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.recommendations).toEqual([]);
  });

  it('never topic-matches a draft or coming-soon product, same discipline as explicit relations', async () => {
    await seedProduct('owned-topic-book', 'Owned Topic Book', 'active', 'investing');
    await seedProduct('draft-topic-book', 'Draft Topic Book', 'draft', 'investing');
    await seedProduct('coming-soon-topic-book', 'Coming Soon Topic Book', 'coming-soon', 'investing');

    const { cookieHeader } = await seedCustomerOwning('topic-status-check@example.com', ['owned-topic-book']);
    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.recommendations).toEqual([]);
  });

  it('explicit relations are exhausted first, topic match only tops up the remaining slots', async () => {
    const ownedId = await seedProduct('anchor-book', 'Anchor Book', 'active', 'investing');
    await seedProduct('explicit-related-book', 'Explicit Related Book', 'active', 'investing');
    await seedProduct('topic-fallback-book', 'Topic Fallback Book', 'active', 'investing');
    const relatedId = (await env.DB.prepare(`SELECT id FROM products WHERE slug = 'explicit-related-book'`).first<{ id: number }>())!.id;
    await env.DB.prepare(`INSERT INTO product_relations (product_id, related_product_id, relation_type, sort_order) VALUES (?, ?, 'related', 0)`).bind(ownedId, relatedId).run();

    const { cookieHeader } = await seedCustomerOwning('mixed-signals@example.com', ['anchor-book']);
    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();

    expect(body.data.recommendations).toHaveLength(2);
    expect(body.data.recommendations[0].slug).toBe('explicit-related-book');
    expect(body.data.recommendations[0].relationType).toBe('related');
    expect(body.data.recommendations[1].slug).toBe('topic-fallback-book');
    expect(body.data.recommendations[1].relationType).toBe('topic_match');
  });

  it('phrases the reason around the currently-reading book when the anchor is in progress', async () => {
    await seedProduct('reading-anchor', 'Reading Anchor Book', 'active', 'investing');
    await seedProduct('reading-topic-match', 'Reading Topic Match', 'active', 'investing');
    const { cookieHeader, customerId } = await seedCustomerOwning('reading-anchor@example.com', ['reading-anchor']);
    await seedProgress(customerId, 'RWL-2026-700000', 'in_progress', '2026-08-20T10:00:00Z');

    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.recommendations).toHaveLength(1);
    expect(body.data.recommendations[0].reason).toBe("Builds on what you're already reading in Reading Anchor Book.");
  });

  it('phrases the reason around a completed book when the anchor is completed', async () => {
    await seedProduct('completed-anchor', 'Completed Anchor Book', 'active', 'investing');
    await seedProduct('completed-topic-match', 'Completed Topic Match', 'active', 'investing');
    const { cookieHeader, customerId } = await seedCustomerOwning('completed-anchor@example.com', ['completed-anchor']);
    await seedProgress(customerId, 'RWL-2026-700000', 'completed', '2026-08-15T10:00:00Z');

    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.recommendations).toHaveLength(1);
    expect(body.data.recommendations[0].reason).toBe('You finished Completed Anchor Book — continue your Investing journey.');
  });

  it('prioritizes the currently-reading book as topic anchor over a merely-owned book in the same topic', async () => {
    await seedProduct('owned-quiet-book', 'Owned Quiet Book', 'active', 'investing');
    await seedProduct('owned-reading-book', 'Owned Reading Book', 'active', 'investing');
    await seedProduct('the-topic-match', 'The Topic Match', 'active', 'investing');
    const { cookieHeader, customerId } = await seedCustomerOwning('priority-check@example.com', ['owned-quiet-book', 'owned-reading-book']);
    // Only the second purchase (owned-reading-book, RWL-2026-700001) has progress - it must win as the anchor.
    await seedProgress(customerId, 'RWL-2026-700001', 'in_progress', '2026-08-20T10:00:00Z');

    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.recommendations).toHaveLength(1);
    expect(body.data.recommendations[0].becauseOfProductTitle).toBe('Owned Reading Book');
  });

  it('one topic claimed once even with several owned books sharing it - no duplicate reasons for the same topic', async () => {
    await seedProduct('multi-owned-1', 'Multi Owned One', 'active', 'investing');
    await seedProduct('multi-owned-2', 'Multi Owned Two', 'active', 'investing');
    await seedProduct('multi-topic-match', 'Multi Topic Match', 'active', 'investing');

    const { cookieHeader } = await seedCustomerOwning('multi-owned@example.com', ['multi-owned-1', 'multi-owned-2']);
    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.recommendations).toHaveLength(1); // only one other active product in this topic exists
  });

  it('multi-topic customer gets a topic match per distinct owned topic, up to the cap', async () => {
    await seedProduct('owned-investing', 'Owned Investing', 'active', 'investing');
    await seedProduct('owned-mindset', 'Owned Mindset', 'active', 'mindset');
    await seedProduct('match-investing', 'Match Investing', 'active', 'investing');
    await seedProduct('match-mindset', 'Match Mindset', 'active', 'mindset');

    const { cookieHeader } = await seedCustomerOwning('multi-topic@example.com', ['owned-investing', 'owned-mindset']);
    const res = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.recommendations).toHaveLength(2);
    const slugs = body.data.recommendations.map((r: any) => r.slug).sort();
    expect(slugs).toEqual(['match-investing', 'match-mindset']);
  });

  it('is deterministic - identical input produces an identical result across repeated calls', async () => {
    await seedProduct('det-owned', 'Deterministic Owned Book', 'active', 'investing');
    await seedProduct('det-match-1', 'Deterministic Match One', 'active', 'investing');
    await seedProduct('det-match-2', 'Deterministic Match Two', 'active', 'investing');

    const { cookieHeader } = await seedCustomerOwning('deterministic@example.com', ['det-owned']);
    const res1 = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const res2 = await SELF.fetch('https://example.com/api/customer/library/recommendations', { headers: { Cookie: cookieHeader } });
    const body1 = await res1.json<any>();
    const body2 = await res2.json<any>();
    expect(body1.data.recommendations).toEqual(body2.data.recommendations);
  });
});
