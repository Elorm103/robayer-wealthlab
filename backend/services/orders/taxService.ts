/**
 * Tax Breakdown Service — Version 3.0.2 Milestone M2 (Orders,
 * Receipts & Customer Library). See
 * docs/v3.0.2-commerce-architecture-blueprint.md's ADR-008 and
 * docs/v3.0.2-m2-receipt-architecture-plan.md's "Tax breakdown" and
 * "VAT readiness" sections.
 *
 * `receipts.tax_breakdown` is a JSON array of
 * `{label, rate_percent, amount_pesewas}` entries, populated here and
 * only here. Per the M2A Product Owner decision, this business is
 * assumed NOT VAT-registered unless `site_settings` explicitly says
 * otherwise — the honest default is an empty array, never a guessed
 * rate. This function is deliberately isolated and narrow so that
 * "the business confirms its real VAT-registration status and rates"
 * is a change to this one function, not a receipt-architecture change
 * (the schema already supports the real answer, whatever it turns out
 * to be).
 *
 * Reads `site_settings` directly, not through
 * `services/admin/settingsService.ts` — that file's own header
 * comment explicitly scopes itself to "exactly the six editable
 * settings" Version 2.1 Phase 5 defined; a VAT flag is a different
 * concern added by a later milestone, not a seventh member of that
 * already-closed set. An operator can set this today via a direct
 * `site_settings` row (`wrangler d1 execute ... "INSERT OR REPLACE
 * INTO site_settings (key, value) VALUES ('vat_registered', 'true')"`);
 * a future admin-settings page can add a form control for it without
 * any change here.
 */

import type { Env } from '../../worker/env';

export const VAT_REGISTERED_SETTING_KEY = 'vat_registered';

export interface TaxBreakdownEntry {
  label: string;
  ratePercent: number;
  amountPesewas: number;
}

/**
 * Resolves whether the business is currently VAT-registered.
 * Defaults to `false` (not registered) whenever the setting is
 * absent, malformed, or anything other than the literal JSON boolean
 * `true` — an unset or ambiguous configuration must never be
 * interpreted as "registered," since that would mean fabricating a
 * tax charge nobody actually authorized.
 */
export async function isVatRegistered(env: Env): Promise<boolean> {
  const row = await env.DB.prepare('SELECT value FROM site_settings WHERE key = ?').bind(VAT_REGISTERED_SETTING_KEY).first<{ value: string }>();
  if (!row) return false;
  try {
    return JSON.parse(row.value) === true;
  } catch {
    return false;
  }
}

/**
 * Computes the tax breakdown for a purchase. `totalPesewas` is the
 * already-locked, already-charged amount (never recomputed from a
 * rate applied to itself in a way that could disagree with what was
 * actually charged) — when VAT-registered support is genuinely
 * implemented, this function will need the real rate(s) and the
 * product's `taxBehavior` ('inclusive' | 'exclusive' | 'exempt') to
 * decide how to decompose `totalPesewas` into a taxable base plus tax
 * lines; until the business confirms registration, the only correct
 * answer is the empty array.
 */
export async function computeTaxBreakdown(env: Env, _totalPesewas: number, _taxBehavior: string): Promise<TaxBreakdownEntry[]> {
  const registered = await isVatRegistered(env);
  if (!registered) return [];

  // Registered but the real rate/computation logic has not been
  // implemented yet (pending the business's actual confirmed rates,
  // per the M2 Risk Assessment) — logged, not guessed. Returning an
  // empty array here too is deliberate: an unimplemented computation
  // must never silently fabricate a number on a real receipt.
  return [];
}

/** Sums a tax breakdown into the single `receipts.tax_pesewas` value stored alongside it. */
export function sumTaxBreakdown(entries: TaxBreakdownEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.amountPesewas, 0);
}
