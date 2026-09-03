/**
 * Integration tests: GET /api/customer/affiliates/resources (Phase 2E
 * Marketing Resources). Real Worker fetch handler, real D1; same
 * conventions as affiliateApplication.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession as createCustomerSession } from '../../services/customer/sessionService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM affiliate_resources');
  await env.DB.exec('DELETE FROM affiliate_commissions');
  await env.DB.exec('DELETE FROM affiliate_clicks');
  await env.DB.exec('DELETE FROM affiliate_product_rates');
  await env.DB.exec('DELETE FROM affiliate_payouts');
  await env.DB.exec('DELETE FROM affiliates');
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM email_log');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
});

async function seedCustomer(email: string): Promise<{ customerId: number; cookieHeader: string }> {
  const { customerId } = await findOrCreateCustomer(env as any, email, false);
  const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });
  return { customerId, cookieHeader: `customer_session=${session.sessionToken}` };
}

async function seedAffiliate(email: string, status: 'pending' | 'approved' | 'suspended'): Promise<{ cookieHeader: string; affiliateId: number }> {
  const { customerId, cookieHeader } = await seedCustomer(email);
  const insert = await env.DB.prepare(
    `INSERT INTO affiliates (customer_id, affiliate_code, status, default_commission_percent, terms_accepted_at, terms_version, applied_at, data_classification)
     VALUES (?, ?, ?, 20, datetime('now'), '2026-09-01', datetime('now'), 'PRODUCTION')`
  )
    .bind(customerId, `RWLTEST${customerId}`, status)
    .run();
  return { cookieHeader, affiliateId: Number(insert.meta.last_row_id) };
}

async function seedResource(overrides: Partial<{ title: string; category: string; body: string | null; productSlug: string | null; status: string; sortOrder: number }> = {}) {
  const r = {
    title: 'WhatsApp message',
    category: 'message_template',
    body: 'Check this out: {{link}}',
    productSlug: 'treasury-bills-made-simple',
    status: 'published',
    sortOrder: 0,
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
     VALUES (?, ?, ?, ?, ?, ?, 'PRODUCTION')`
  )
    .bind(r.title, r.category, r.body, r.productSlug, r.sortOrder, r.status)
    .run();
}

describe('GET /api/customer/affiliates/resources', () => {
  it('returns only published resources, in sort_order, for an approved affiliate', async () => {
    await seedResource({ title: 'Draft copy', status: 'draft', sortOrder: 1 });
    await seedResource({ title: 'Archived copy', status: 'archived', sortOrder: 2 });
    await seedResource({ title: 'Facebook post', category: 'social_caption', status: 'published', sortOrder: 3 });
    await seedResource({ title: 'WhatsApp message', category: 'message_template', status: 'published', sortOrder: 4 });

    const { cookieHeader } = await seedAffiliate('approved-resources@example.com', 'approved');
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/resources', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();

    expect(body.success).toBe(true);
    expect(body.data.resources.map((r: any) => r.title)).toEqual(['Facebook post', 'WhatsApp message']);
    expect(body.data.resources[0].productSlug).toBe('treasury-bills-made-simple');
  });

  it('blocks a pending affiliate from accessing resources', async () => {
    await seedResource();
    const { cookieHeader } = await seedAffiliate('pending-resources@example.com', 'pending');
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/resources', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('AFFILIATE_NOT_APPROVED');
  });

  it('blocks a suspended affiliate from accessing resources', async () => {
    await seedResource();
    const { cookieHeader } = await seedAffiliate('suspended-resources@example.com', 'suspended');
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/resources', { headers: { Cookie: cookieHeader } });
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('AFFILIATE_SUSPENDED');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch('https://example.com/api/customer/affiliates/resources');
    const body = await res.json<any>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_AUTHENTICATED');
  });
});
