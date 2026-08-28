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

async function seedProduct(slug: string, title: string, status = 'active'): Promise<number> {
  const insert = await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES (?, ?, ?, 'investing', 'ebook', ?, 3900, 'GHS', 'one-time', 'inclusive', 'en')`
  )
    .bind(`prod-${slug}`, slug, title, status)
    .run();
  return Number(insert.meta.last_row_id);
}

async function seedCustomerOwning(email: string, productSlugs: string[]): Promise<{ cookieHeader: string }> {
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
  return { cookieHeader: `customer_session=${session.sessionToken}` };
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
});
