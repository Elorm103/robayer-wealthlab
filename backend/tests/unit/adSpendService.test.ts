/**
 * Unit tests: advertising spend ledger — P0-B (Business Intelligence
 * backbone, first component). Exercises services/admin/adSpendService.ts
 * directly against a real D1 instance, mirroring
 * tests/unit/couponService.test.ts's own structure for this codebase's
 * comparable financial-record admin resource.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createLogger } from '../../utils/logger';
import {
  isValidAdSpendSource,
  isValidEntryDate,
  isValidCurrency,
  createAdSpendEntry,
  updateAdSpendEntry,
  softDeleteAdSpendEntry,
  listAdSpendEntries,
} from '../../services/admin/adSpendService';

const logger = createLogger('test-request-id', 'test');

beforeEach(async () => {
  await env.DB.exec('DELETE FROM ad_spend_entries');
  await env.DB.exec('DELETE FROM audit_logs');
  await env.DB.exec('DELETE FROM admin_users');
});

async function seedAdmin(): Promise<number> {
  const insert = await env.DB.prepare(`INSERT INTO admin_users (email, password_hash, role) VALUES (?, 'x:1:x', 'super_admin')`)
    .bind(`admin-${Math.random().toString(36).slice(2)}@example.com`)
    .run();
  return Number(insert.meta.last_row_id);
}

describe('validators', () => {
  it('accepts only the four known sources', () => {
    expect(isValidAdSpendSource('meta')).toBe(true);
    expect(isValidAdSpendSource('google')).toBe(true);
    expect(isValidAdSpendSource('linkedin')).toBe(true);
    expect(isValidAdSpendSource('other')).toBe(true);
    expect(isValidAdSpendSource('tiktok')).toBe(false);
    expect(isValidAdSpendSource(undefined)).toBe(false);
  });

  it('accepts only YYYY-MM-DD dates', () => {
    expect(isValidEntryDate('2026-08-12')).toBe(true);
    expect(isValidEntryDate('08/12/2026')).toBe(false);
    expect(isValidEntryDate('2026-8-12')).toBe(false);
  });

  it('accepts only 3-letter uppercase currency codes', () => {
    expect(isValidCurrency('GHS')).toBe(true);
    expect(isValidCurrency('USD')).toBe(true);
    expect(isValidCurrency('usd')).toBe(false);
    expect(isValidCurrency('US')).toBe(false);
  });
});

describe('createAdSpendEntry', () => {
  it('creates an entry, preserving its original currency exactly as entered, and writes an audit log row', async () => {
    const adminId = await seedAdmin();

    const result = await createAdSpendEntry(env as any, logger, adminId, {
      entryDate: '2026-08-05',
      source: 'meta',
      campaignLabel: 'RWL | Book 3 | Ghana | Purchase',
      amountMinorUnits: 470,
      currency: 'USD',
      notes: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await env.DB.prepare('SELECT amount_minor_units AS amountMinorUnits, currency, source, campaign_label AS campaignLabel FROM ad_spend_entries WHERE id = ?')
      .bind(result.id)
      .first<any>();
    expect(row.amountMinorUnits).toBe(470);
    expect(row.currency).toBe('USD'); // never converted to GHS or anything else
    expect(row.source).toBe('meta');
    expect(row.campaignLabel).toBe('RWL | Book 3 | Ghana | Purchase');

    const audit = await env.DB.prepare(`SELECT actor_id AS actorId, action FROM audit_logs WHERE action = 'ad_spend.created'`).first<any>();
    expect(audit.actorId).toBe(adminId);
  });

  it('rejects a negative amount', async () => {
    const adminId = await seedAdmin();
    const result = await createAdSpendEntry(env as any, logger, adminId, {
      entryDate: '2026-08-05',
      source: 'meta',
      campaignLabel: 'Test',
      amountMinorUnits: -1,
      currency: 'USD',
      notes: null,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid source', async () => {
    const adminId = await seedAdmin();
    const result = await createAdSpendEntry(env as any, logger, adminId, {
      entryDate: '2026-08-05',
      source: 'tiktok' as any,
      campaignLabel: 'Test',
      amountMinorUnits: 100,
      currency: 'USD',
      notes: null,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an empty campaign label', async () => {
    const adminId = await seedAdmin();
    const result = await createAdSpendEntry(env as any, logger, adminId, {
      entryDate: '2026-08-05',
      source: 'meta',
      campaignLabel: '   ',
      amountMinorUnits: 100,
      currency: 'USD',
      notes: null,
    });
    expect(result.ok).toBe(false);
  });
});

describe('updateAdSpendEntry', () => {
  it('updates only the supplied fields, preserving the rest', async () => {
    const adminId = await seedAdmin();
    const created = await createAdSpendEntry(env as any, logger, adminId, {
      entryDate: '2026-08-05',
      source: 'meta',
      campaignLabel: 'Original label',
      amountMinorUnits: 470,
      currency: 'USD',
      notes: null,
    });
    if (!created.ok) throw new Error('setup failed');

    const result = await updateAdSpendEntry(env as any, logger, adminId, created.id, { amountMinorUnits: 999 });
    expect(result.ok).toBe(true);

    const row = await env.DB.prepare('SELECT amount_minor_units AS amountMinorUnits, campaign_label AS campaignLabel, currency FROM ad_spend_entries WHERE id = ?')
      .bind(created.id)
      .first<any>();
    expect(row.amountMinorUnits).toBe(999);
    expect(row.campaignLabel).toBe('Original label'); // untouched
    expect(row.currency).toBe('USD'); // untouched, never converted
  });

  it('returns not_found for a nonexistent entry', async () => {
    const adminId = await seedAdmin();
    const result = await updateAdSpendEntry(env as any, logger, adminId, 999999, { amountMinorUnits: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });
});

describe('softDeleteAdSpendEntry', () => {
  it('hides a deleted entry from listAdSpendEntries but never removes the row', async () => {
    const adminId = await seedAdmin();
    const created = await createAdSpendEntry(env as any, logger, adminId, {
      entryDate: '2026-08-05',
      source: 'meta',
      campaignLabel: 'To be deleted',
      amountMinorUnits: 100,
      currency: 'GHS',
      notes: null,
    });
    if (!created.ok) throw new Error('setup failed');

    const del = await softDeleteAdSpendEntry(env as any, logger, adminId, created.id);
    expect(del.ok).toBe(true);

    const list = await listAdSpendEntries(env as any, 1, 20);
    expect(list.items.find((i) => i.id === created.id)).toBeUndefined();

    // The row itself is never hard-deleted — matches payment_transactions'
    // "financial records are never deleted, soft or hard" convention,
    // applied here as soft-delete-only.
    const row = await env.DB.prepare('SELECT deleted_at FROM ad_spend_entries WHERE id = ?').bind(created.id).first<any>();
    expect(row).toBeTruthy();
    expect(row.deleted_at).toBeTruthy();
  });
});

describe('listAdSpendEntries', () => {
  it('paginates and orders by entry_date descending', async () => {
    const adminId = await seedAdmin();
    await createAdSpendEntry(env as any, logger, adminId, { entryDate: '2026-08-01', source: 'meta', campaignLabel: 'Early', amountMinorUnits: 100, currency: 'GHS', notes: null });
    await createAdSpendEntry(env as any, logger, adminId, { entryDate: '2026-08-10', source: 'meta', campaignLabel: 'Late', amountMinorUnits: 100, currency: 'GHS', notes: null });

    const result = await listAdSpendEntries(env as any, 1, 20);
    expect(result.total).toBe(2);
    expect(result.items[0].campaignLabel).toBe('Late');
    expect(result.items[1].campaignLabel).toBe('Early');
  });
});
