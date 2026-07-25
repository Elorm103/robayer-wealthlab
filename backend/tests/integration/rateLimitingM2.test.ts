/**
 * Integration tests: rate limiting on Milestone M2's new endpoints -
 * Version 3.0.2, added at Sprint M2C's MAR closeout. Mirrors
 * tests/integration/rateLimiting.test.ts's own pattern exactly (one
 * distinct CF-Connecting-IP per test for an isolated KV bucket). The
 * rate limiter itself was already implemented and wired into every
 * M2 endpoint below, but had zero automated test coverage - this file
 * closes that gap.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { findOrCreateCustomer } from '../../services/customer/identityService';
import { createSession as createCustomerSession } from '../../services/customer/sessionService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM receipt_download_tokens');
  await env.DB.exec('DELETE FROM receipts');
  await env.DB.exec('DELETE FROM licenses');
  await env.DB.exec('DELETE FROM order_items');
  await env.DB.exec('DELETE FROM purchase_sessions');
  await env.DB.exec('DELETE FROM customer_sessions');
  await env.DB.exec('DELETE FROM customer_profiles');
  await env.DB.exec('DELETE FROM customers');
});

describe('M2 endpoint rate limiting', () => {
  it('POST /api/purchases/:reference/receipt-download: the 21st attempt within the window is rejected with RATE_LIMITED (limit is 20/min)', async () => {
    const ip = '203.0.113.101';
    const results: any[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await SELF.fetch('https://example.com/api/purchases/RWL-2026-999901/receipt-download', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': ip },
      });
      results.push(await res.json());
    }

    for (let i = 0; i < 20; i++) {
      expect(results[i].error.code).toBe('RECEIPT_NOT_FOUND'); // no such purchase/receipt, but rate limit not yet hit
    }
    expect(results[20].error.code).toBe('RATE_LIMITED');
  });

  it('GET /api/download-receipt/:token: the 21st attempt within the window is rejected with RATE_LIMITED (limit is 20/min)', async () => {
    const ip = '203.0.113.102';
    const results: any[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await SELF.fetch('https://example.com/api/download-receipt/not-a-real-token', { headers: { 'CF-Connecting-IP': ip } });
      results.push(await res.json());
    }

    for (let i = 0; i < 20; i++) {
      expect(results[i].error.code).toBe('RECEIPT_NOT_FOUND');
    }
    expect(results[20].error.code).toBe('RATE_LIMITED');
  });

  it('GET /api/customer/receipts/:receiptNumber/download: the 21st attempt within the window is rejected with RATE_LIMITED (limit is 20/15min)', async () => {
    const ip = '203.0.113.103';
    const { customerId } = await findOrCreateCustomer(env as any, 'm2-ratelimit-1@example.com', false);
    const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });
    const cookieHeader = `customer_session=${session.sessionToken}`;

    const results: any[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await SELF.fetch('https://example.com/api/customer/receipts/RWL-RCT-2026-999999/download', {
        headers: { Cookie: cookieHeader, 'CF-Connecting-IP': ip },
      });
      results.push(await res.json());
    }

    for (let i = 0; i < 20; i++) {
      expect(results[i].error.code).toBe('RECEIPT_NOT_FOUND'); // no such receipt, but rate limit not yet hit
    }
    expect(results[20].error.code).toBe('RATE_LIMITED');
  });

  it('GET /api/customer/purchases: the 61st attempt within the window is rejected with RATE_LIMITED (limit is 60/15min)', async () => {
    const ip = '203.0.113.104';
    const { customerId } = await findOrCreateCustomer(env as any, 'm2-ratelimit-2@example.com', false);
    const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });
    const cookieHeader = `customer_session=${session.sessionToken}`;

    const results: any[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await SELF.fetch('https://example.com/api/customer/purchases', { headers: { Cookie: cookieHeader, 'CF-Connecting-IP': ip } });
      results.push(await res.json());
    }

    for (let i = 0; i < 60; i++) {
      expect(results[i].success).toBe(true);
    }
    expect(results[60].error.code).toBe('RATE_LIMITED');
  }, 30_000);

  it('rate-limit buckets are per-endpoint, not shared: exhausting the receipt-download mint limit does not affect the customer purchases-read limit for the same IP', async () => {
    const ip = '203.0.113.105';
    const { customerId } = await findOrCreateCustomer(env as any, 'm2-ratelimit-3@example.com', false);
    const session = await createCustomerSession(env as any, customerId, { ip: null, userAgent: null });
    const cookieHeader = `customer_session=${session.sessionToken}`;

    for (let i = 0; i < 20; i++) {
      await SELF.fetch('https://example.com/api/purchases/RWL-2026-999902/receipt-download', { method: 'POST', headers: { 'CF-Connecting-IP': ip } });
    }
    const exhausted = await SELF.fetch('https://example.com/api/purchases/RWL-2026-999902/receipt-download', { method: 'POST', headers: { 'CF-Connecting-IP': ip } });
    expect((await exhausted.json<any>()).error.code).toBe('RATE_LIMITED');

    const stillFine = await SELF.fetch('https://example.com/api/customer/purchases', { headers: { Cookie: cookieHeader, 'CF-Connecting-IP': ip } });
    expect((await stillFine.json<any>()).success).toBe(true);
  });
});
