/**
 * Unit tests: tax breakdown - Version 3.0.2 Milestone M2. Per the
 * Product Owner's approved decision, this business is assumed NOT
 * VAT-registered unless `site_settings` explicitly says otherwise -
 * these tests exercise exactly that default and its override.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { isVatRegistered, computeTaxBreakdown, sumTaxBreakdown, VAT_REGISTERED_SETTING_KEY } from '../../services/orders/taxService';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM site_settings');
});

describe('isVatRegistered', () => {
  it('defaults to false when the setting has never been set', async () => {
    expect(await isVatRegistered(env as any)).toBe(false);
  });

  it('is true only when the stored value is the literal JSON boolean true', async () => {
    await env.DB.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').bind(VAT_REGISTERED_SETTING_KEY, 'true').run();
    expect(await isVatRegistered(env as any)).toBe(true);
  });

  it('defaults to false for a malformed stored value rather than throwing', async () => {
    await env.DB.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').bind(VAT_REGISTERED_SETTING_KEY, 'not-json{{{').run();
    expect(await isVatRegistered(env as any)).toBe(false);
  });

  it('defaults to false for a truthy-but-not-boolean-true stored value (e.g. the string "yes")', async () => {
    await env.DB.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').bind(VAT_REGISTERED_SETTING_KEY, '"yes"').run();
    expect(await isVatRegistered(env as any)).toBe(false);
  });
});

describe('computeTaxBreakdown', () => {
  it('returns an empty array when the business is not VAT-registered', async () => {
    const result = await computeTaxBreakdown(env as any, 3900, 'inclusive');
    expect(result).toEqual([]);
  });

  it('still returns an empty array when VAT-registered but the real computation logic is not yet implemented (honest, never a guessed rate)', async () => {
    await env.DB.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').bind(VAT_REGISTERED_SETTING_KEY, 'true').run();
    const result = await computeTaxBreakdown(env as any, 3900, 'inclusive');
    expect(result).toEqual([]);
  });
});

describe('sumTaxBreakdown', () => {
  it('sums amountPesewas across entries', () => {
    expect(sumTaxBreakdown([{ label: 'VAT', ratePercent: 15, amountPesewas: 500 }, { label: 'NHIL', ratePercent: 2.5, amountPesewas: 100 }])).toBe(600);
  });

  it('returns 0 for an empty array', () => {
    expect(sumTaxBreakdown([])).toBe(0);
  });
});
