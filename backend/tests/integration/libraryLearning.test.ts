/**
 * Integration tests: Digital Library 2.0 Phase H (Interactive Learning
 * Experience) — real HTTP routes for both the admin authoring surface
 * (/api/admin/library-learning-items*) and the customer-facing surface
 * (/api/customer/purchases/:reference/learning-items*). Mirrors
 * adminReviews.test.ts's admin-auth pattern and libraryBookmarks.test.ts's
 * customer-entitlement pattern.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createSession as createAdminSession } from '../../services/admin/sessionService';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession as createCustomerSession } from '../../services/customer/sessionService';
import { seedTestProduct, cleanupTestProduct, TEST_PRODUCT_SLUG, TEST_ASSET_ID } from '../helpers';

const SECOND_PRODUCT_SLUG = 'second-test-guide';
const SECOND_ASSET_ID = 'asset-second-test-guide-pdf-v1';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM library_learning_responses');
  await env.DB.exec('DELETE FROM library_learning_items');
  await env.DB.exec('DELETE FROM deliveries');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM admin_sessions');
  await env.DB.exec('DELETE FROM admin_users');
  await cleanupTestProduct(env as any);
  await seedTestProduct(env as any);
  await seedSecondProduct();
});

async function seedSecondProduct(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO products (product_id, slug, title, topic, product_type, status, price_pesewas, currency, pricing_model, tax_behavior, language)
     VALUES ('prod-second-test-guide', ?, 'Second Test Guide', 'investing', 'ebook', 'active', 2900, 'GHS', 'one-time', 'inclusive', 'en')`
  )
    .bind(SECOND_PRODUCT_SLUG)
    .run();
  const mediaInsert = await env.DB.prepare(
    `INSERT INTO media_assets (filename, original_filename, mime_type, size_bytes, content_hash, storage_key, public_url, media_type, folder, status)
     VALUES ('second-test-guide.pdf', 'second-test-guide.pdf', 'application/pdf', 1024, 'cafebabe', 'ebooks/second-test-guide.pdf', 'https://example.com/second-test-guide.pdf', 'document', 'books', 'ready')`
  ).run();
  const mediaId = Number(mediaInsert.meta.last_row_id);
  const productRow = await env.DB.prepare('SELECT id FROM products WHERE slug = ?').bind(SECOND_PRODUCT_SLUG).first<{ id: number }>();
  await env.DB.prepare(`INSERT INTO product_files (product_id, asset_id, media_id, display_name, file_type, status) VALUES (?, ?, ?, 'Second Test Guide (PDF)', 'PDF', 'published')`)
    .bind(productRow!.id, SECOND_ASSET_ID, mediaId)
    .run();
}

async function seedAdmin(role: 'super_admin' | 'editor' | 'support' = 'super_admin'): Promise<{ cookieHeader: string; csrfSecret: string; adminId: number }> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role, is_active) VALUES (?, 'x:1:x', ?, 1)`)
    .bind(`admin-${role}-${Math.random().toString(36).slice(2)}@example.com`, role)
    .run();
  const adminId = Number(insert.meta.last_row_id);
  const session = await createAdminSession(env as any, adminId, { ip: null, userAgent: null });
  return { cookieHeader: `admin_session=${session.sessionToken}; admin_csrf=${session.csrfSecret}`, csrfSecret: session.csrfSecret, adminId };
}

async function adminPost(path: string, body: unknown, admin: { cookieHeader: string; csrfSecret: string }, method = 'POST'): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { Cookie: admin.cookieHeader, 'X-CSRF-Token': admin.csrfSecret, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validQuickCheckBody = {
  itemType: 'quick_check',
  productSlug: TEST_PRODUCT_SLUG,
  assetId: TEST_ASSET_ID,
  anchorPageNumber: 5,
  prompt: 'Which of these best describes a Treasury Bill?',
  choices: ['A long-term ownership share in a company', 'A short-term government debt instrument', 'A cryptocurrency', 'A bank savings account'],
  correctChoiceIndex: 1,
  explanation: 'Treasury Bills are short-term government securities issued to raise funds.',
  status: 'published',
};

const validActionBody = {
  itemType: 'action',
  productSlug: TEST_PRODUCT_SLUG,
  assetId: TEST_ASSET_ID,
  anchorPageNumber: 5,
  prompt: "You've just learned what a Treasury Bill is.",
  actionLabel: 'Check whether you currently have an emergency fund before investing.',
  status: 'published',
};

async function seedCustomerWithPurchase(email: string, reference: string, productSlug = TEST_PRODUCT_SLUG, assetId = TEST_ASSET_ID, productId = 'prod-test-guide'): Promise<{ cookieHeader: string; customerId: number }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });
  const insert = await env.DB.prepare(
    `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, expires_at)
     VALUES (?, ?, ?, 'Test Guide', 3900, 'GHS', 'verified', ?, datetime('now', '+30 minutes'))`
  )
    .bind(reference, productSlug, productId, customerId)
    .run();
  await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) VALUES (?, ?, ?, 10, 0, 'delivered')`)
    .bind(Number(insert.meta.last_row_id), assetId, productSlug)
    .run();
  return { cookieHeader: `customer_session=${session.sessionToken}`, customerId };
}

// ============================================================
// Admin authoring
// ============================================================

describe('POST /api/admin/library-learning-items', () => {
  it('rejects an unauthenticated create', async () => {
    const res = await SELF.fetch('https://example.com/api/admin/library-learning-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validQuickCheckBody),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a non-editor role (support)', async () => {
    const admin = await seedAdmin('support');
    const res = await adminPost('/api/admin/library-learning-items', validQuickCheckBody, admin);
    expect(res.status).toBe(403);
  });

  it('creates a real, valid quick_check item', async () => {
    const admin = await seedAdmin('editor');
    const res = await adminPost('/api/admin/library-learning-items', validQuickCheckBody, admin);
    expect(res.status).toBe(201);
    const body = await res.json<any>();
    expect(body.data.itemType).toBe('quick_check');
    expect(body.data.format).toBe('PDF'); // derived from the real asset, never admin-supplied
    expect(body.data.choices).toEqual(validQuickCheckBody.choices);
    expect(body.data.status).toBe('published');
  });

  it('creates a real, valid action item', async () => {
    const admin = await seedAdmin('super_admin');
    const res = await adminPost('/api/admin/library-learning-items', validActionBody, admin);
    expect(res.status).toBe(201);
    const body = await res.json<any>();
    expect(body.data.itemType).toBe('action');
    expect(body.data.actionLabel).toBe(validActionBody.actionLabel);
    expect(body.data.choices).toBeNull();
  });

  it('rejects a correctChoiceIndex out of range', async () => {
    const admin = await seedAdmin('editor');
    const res = await adminPost('/api/admin/library-learning-items', { ...validQuickCheckBody, correctChoiceIndex: 99 }, admin);
    expect(res.status).toBe(400);
  });

  it('rejects an unknown productSlug', async () => {
    const admin = await seedAdmin('editor');
    const res = await adminPost('/api/admin/library-learning-items', { ...validQuickCheckBody, productSlug: 'does-not-exist' }, admin);
    expect(res.status).toBe(404);
  });

  it('rejects an unknown/unpublished assetId', async () => {
    const admin = await seedAdmin('editor');
    const res = await adminPost('/api/admin/library-learning-items', { ...validQuickCheckBody, assetId: 'asset-does-not-exist' }, admin);
    expect(res.status).toBe(404);
  });

  it('rejects an EPUB-shaped anchor (anchorCfi) against a real PDF asset - the anchor must match the asset\'s real format', async () => {
    const admin = await seedAdmin('editor');
    const res = await adminPost('/api/admin/library-learning-items', { ...validQuickCheckBody, anchorPageNumber: undefined, anchorCfi: 'ch01.xhtml' }, admin);
    expect(res.status).toBe(400);
  });
});

describe('PUT/DELETE /api/admin/library-learning-items/:id', () => {
  it('updates an existing item', async () => {
    const admin = await seedAdmin('editor');
    const createRes = await adminPost('/api/admin/library-learning-items', validQuickCheckBody, admin);
    const id = (await createRes.json<any>()).data.id;

    const updateRes = await adminPost(`/api/admin/library-learning-items/${id}`, { ...validQuickCheckBody, prompt: 'An updated, still-real prompt.' }, admin, 'PUT');
    expect(updateRes.status).toBe(200);
    expect((await updateRes.json<any>()).data.prompt).toBe('An updated, still-real prompt.');
  });

  it('reports not found for a non-existent item id', async () => {
    const admin = await seedAdmin('editor');
    const res = await adminPost('/api/admin/library-learning-items/999999', validQuickCheckBody, admin, 'PUT');
    expect(res.status).toBe(404);
  });

  it('deletes an item, and it no longer appears in the admin list', async () => {
    const admin = await seedAdmin('editor');
    const createRes = await adminPost('/api/admin/library-learning-items', validQuickCheckBody, admin);
    const id = (await createRes.json<any>()).data.id;

    const deleteRes = await SELF.fetch(`https://example.com/api/admin/library-learning-items/${id}`, { method: 'DELETE', headers: { Cookie: admin.cookieHeader, 'X-CSRF-Token': admin.csrfSecret } });
    expect(deleteRes.status).toBe(200);

    const listRes = await SELF.fetch(`https://example.com/api/admin/library-learning-items?productSlug=${TEST_PRODUCT_SLUG}`, { headers: { Cookie: admin.cookieHeader } });
    expect((await listRes.json<any>()).data.items).toHaveLength(0);
  });

  it('the admin list includes both draft and published items', async () => {
    const admin = await seedAdmin('editor');
    await adminPost('/api/admin/library-learning-items', { ...validQuickCheckBody, status: 'draft' }, admin);
    await adminPost('/api/admin/library-learning-items', validActionBody, admin);

    const listRes = await SELF.fetch(`https://example.com/api/admin/library-learning-items?productSlug=${TEST_PRODUCT_SLUG}`, { headers: { Cookie: admin.cookieHeader } });
    const body = await listRes.json<any>();
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items.map((i: any) => i.status).sort()).toEqual(['draft', 'published']);
  });
});

// ============================================================
// Customer-facing
// ============================================================

describe('GET /api/customer/purchases/:reference/learning-items', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-940001/learning-items?assetId=${TEST_ASSET_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns only published items, never drafts, and never the correct answer up front', async () => {
    const admin = await seedAdmin('editor');
    const publishedRes = await adminPost('/api/admin/library-learning-items', validQuickCheckBody, admin);
    await adminPost('/api/admin/library-learning-items', { ...validActionBody, status: 'draft' }, admin);
    const publishedId = (await publishedRes.json<any>()).data.id;

    const { cookieHeader } = await seedCustomerWithPurchase('learner@example.com', 'RWL-2026-940002');
    const res = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-940002/learning-items?assetId=${TEST_ASSET_ID}`, { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();

    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].id).toBe(publishedId);
    expect(body.data.items[0].choices).toEqual(validQuickCheckBody.choices);
    expect(body.data.items[0]).not.toHaveProperty('correctChoiceIndex');
    expect(body.data.items[0]).not.toHaveProperty('explanation');
    expect(body.data.items[0].response).toBeNull();
  });

  it('never returns a learning item from a different book - cross-book isolation', async () => {
    const admin = await seedAdmin('editor');
    await adminPost('/api/admin/library-learning-items', validQuickCheckBody, admin); // belongs to TEST_PRODUCT_SLUG
    await adminPost('/api/admin/library-learning-items', { ...validQuickCheckBody, productSlug: SECOND_PRODUCT_SLUG, assetId: SECOND_ASSET_ID }, admin); // belongs to a different book

    const { cookieHeader } = await seedCustomerWithPurchase('learner2@example.com', 'RWL-2026-940003');
    const res = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-940003/learning-items?assetId=${TEST_ASSET_ID}`, { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.data.items).toHaveLength(1);
  });

  it('returns an empty list (not an error) for an authenticated customer who does not own this book', async () => {
    const admin = await seedAdmin('editor');
    await adminPost('/api/admin/library-learning-items', validQuickCheckBody, admin);

    // A real, authenticated customer, but with no purchase for TEST_PRODUCT_SLUG at all.
    const { customerId } = await findOrCreateCustomer(env as any, 'owns-nothing-learner@example.com', false);
    const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });

    const res = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-999999/learning-items?assetId=${TEST_ASSET_ID}`, {
      headers: { Cookie: `customer_session=${session.sessionToken}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).data.items).toEqual([]);
  });
});

describe('POST /api/customer/purchases/:reference/learning-items/:itemId/response', () => {
  async function seedPublishedQuickCheck(admin: { cookieHeader: string; csrfSecret: string }): Promise<number> {
    const res = await adminPost('/api/admin/library-learning-items', validQuickCheckBody, admin);
    return (await res.json<any>()).data.id;
  }

  it('grades a correct answer, persists it, and never trusts a client-supplied correctness flag', async () => {
    const admin = await seedAdmin('editor');
    const itemId = await seedPublishedQuickCheck(admin);
    const { cookieHeader } = await seedCustomerWithPurchase('grader@example.com', 'RWL-2026-950001');

    const res = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-950001/learning-items/${itemId}/response?assetId=${TEST_ASSET_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ itemType: 'quick_check', selectedChoiceIndex: 1 }), // the real correct index
    });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.data.isCorrect).toBe(true);
    expect(body.data.correctChoiceIndex).toBe(1);
    expect(body.data.explanation).toBe(validQuickCheckBody.explanation);

    const listRes = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-950001/learning-items?assetId=${TEST_ASSET_ID}`, { headers: { Cookie: cookieHeader } });
    const listBody = await listRes.json<any>();
    expect(listBody.data.items[0].response).toEqual({ selectedChoiceIndex: 1, isCorrect: true, actionDone: null });
  });

  it('grades an incorrect answer honestly', async () => {
    const admin = await seedAdmin('editor');
    const itemId = await seedPublishedQuickCheck(admin);
    const { cookieHeader } = await seedCustomerWithPurchase('wrong-answer@example.com', 'RWL-2026-950002');

    const res = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-950002/learning-items/${itemId}/response?assetId=${TEST_ASSET_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ itemType: 'quick_check', selectedChoiceIndex: 0 }),
    });
    expect((await res.json<any>()).data.isCorrect).toBe(false);
  });

  it('re-answering updates the existing response in place, never creates a duplicate', async () => {
    const admin = await seedAdmin('editor');
    const itemId = await seedPublishedQuickCheck(admin);
    const { cookieHeader, customerId } = await seedCustomerWithPurchase('retry@example.com', 'RWL-2026-950003');

    await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-950003/learning-items/${itemId}/response?assetId=${TEST_ASSET_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ itemType: 'quick_check', selectedChoiceIndex: 0 }),
    });
    await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-950003/learning-items/${itemId}/response?assetId=${TEST_ASSET_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ itemType: 'quick_check', selectedChoiceIndex: 1 }),
    });

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM library_learning_responses WHERE learning_item_id = ? AND customer_id = ?`).bind(itemId, customerId).first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('submits and persists an action completion', async () => {
    const admin = await seedAdmin('editor');
    const createRes = await adminPost('/api/admin/library-learning-items', validActionBody, admin);
    const itemId = (await createRes.json<any>()).data.id;
    const { cookieHeader } = await seedCustomerWithPurchase('action-taker@example.com', 'RWL-2026-950004');

    const res = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-950004/learning-items/${itemId}/response?assetId=${TEST_ASSET_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ itemType: 'action', actionDone: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).data.actionDone).toBe(true);
  });

  it('rejects an unauthenticated submission', async () => {
    const admin = await seedAdmin('editor');
    const itemId = await seedPublishedQuickCheck(admin);
    const res = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-950005/learning-items/${itemId}/response?assetId=${TEST_ASSET_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemType: 'quick_check', selectedChoiceIndex: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("a customer cannot submit against a purchase reference they do not own - cross-customer isolation", async () => {
    const admin = await seedAdmin('editor');
    const itemId = await seedPublishedQuickCheck(admin);
    await seedCustomerWithPurchase('victim@example.com', 'RWL-2026-950006');
    const attacker = await findOrCreateCustomer(env as any, 'attacker@example.com', false);
    const attackerSession = await createCustomerSession(env as any, attacker.customerId, { ip: null, userAgent: null });

    const res = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-950006/learning-items/${itemId}/response?assetId=${TEST_ASSET_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `customer_session=${attackerSession.sessionToken}` },
      body: JSON.stringify({ itemType: 'quick_check', selectedChoiceIndex: 1 }),
    });
    expect(res.status).toBe(404); // NOT_FOUND, same "never reveal which check failed" discipline as every other entitlement denial in this codebase
  });

  it('rejects a revoked purchase', async () => {
    const admin = await seedAdmin('editor');
    const itemId = await seedPublishedQuickCheck(admin);
    const { customerId } = await findOrCreateCustomer(env as any, 'revoked@example.com', false);
    const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });
    const insert = await env.DB.prepare(
      `INSERT INTO purchase_sessions (purchase_reference, product_slug, product_id, product_title, amount_pesewas, currency, status, customer_id, expires_at)
       VALUES ('RWL-2026-950007', ?, 'prod-test-guide', 'Test Guide', 3900, 'GHS', 'verified', ?, datetime('now', '+30 minutes'))`
    )
      .bind(TEST_PRODUCT_SLUG, customerId)
      .run();
    await env.DB.prepare(`INSERT INTO deliveries (purchase_session_id, asset_id, product_slug, max_downloads, downloads_used, status) VALUES (?, ?, ?, 10, 0, 'revoked')`)
      .bind(Number(insert.meta.last_row_id), TEST_ASSET_ID, TEST_PRODUCT_SLUG)
      .run();

    const res = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-950007/learning-items/${itemId}/response?assetId=${TEST_ASSET_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `customer_session=${session.sessionToken}` },
      body: JSON.stringify({ itemType: 'quick_check', selectedChoiceIndex: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it("cannot submit against an item belonging to a DIFFERENT book, even with a legitimately-owned purchase reference - the real cross-book manipulation test", async () => {
    const admin = await seedAdmin('editor');
    const otherBookItemRes = await adminPost('/api/admin/library-learning-items', { ...validQuickCheckBody, productSlug: SECOND_PRODUCT_SLUG, assetId: SECOND_ASSET_ID }, admin);
    const otherBookItemId = (await otherBookItemRes.json<any>()).data.id;

    // This customer owns TEST_PRODUCT_SLUG, NOT SECOND_PRODUCT_SLUG.
    const { cookieHeader } = await seedCustomerWithPurchase('cross-book-attacker@example.com', 'RWL-2026-950008');

    const res = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-950008/learning-items/${otherBookItemId}/response?assetId=${TEST_ASSET_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ itemType: 'quick_check', selectedChoiceIndex: 1 }),
    });
    expect(res.status).toBe(404);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM library_learning_responses WHERE learning_item_id = ?`).bind(otherBookItemId).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it('rejects an itemType mismatch (submitting an action-shaped body against a quick_check item)', async () => {
    const admin = await seedAdmin('editor');
    const itemId = await seedPublishedQuickCheck(admin);
    const { cookieHeader } = await seedCustomerWithPurchase('mismatch@example.com', 'RWL-2026-950009');

    const res = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-950009/learning-items/${itemId}/response?assetId=${TEST_ASSET_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ itemType: 'action', actionDone: true }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range selectedChoiceIndex', async () => {
    const admin = await seedAdmin('editor');
    const itemId = await seedPublishedQuickCheck(admin);
    const { cookieHeader } = await seedCustomerWithPurchase('malformed@example.com', 'RWL-2026-950010');

    const res = await SELF.fetch(`https://example.com/api/customer/purchases/RWL-2026-950010/learning-items/${itemId}/response?assetId=${TEST_ASSET_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ itemType: 'quick_check', selectedChoiceIndex: 99 }),
    });
    expect(res.status).toBe(400);
  });
});
