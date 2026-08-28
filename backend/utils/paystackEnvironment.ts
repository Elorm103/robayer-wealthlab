/**
 * Shared with services/admin/settingsService.ts's Payment Diagnostics
 * card (which needs the raw test/live/unknown value) and with the
 * data_classification stamping in commerceService.ts/identityService.ts
 * (which needs it mapped to PRODUCTION/DEVELOPMENT/UNKNOWN) — extracted
 * here so both callers apply the exact same evidence, not two versions
 * that could drift.
 */
export function classifyPaystackEnvironment(secretKey: string): 'test' | 'live' | 'unknown' {
  // Only the fixed-length prefix is ever inspected — the full key is
  // never assigned to a variable that outlives this comparison, never
  // logged, never returned. Matches how real payment dashboards show
  // a test-mode banner without displaying the key itself.
  if (secretKey.startsWith('sk_test_')) return 'test';
  if (secretKey.startsWith('sk_live_')) return 'live';
  return 'unknown';
}

export type DataClassification = 'PRODUCTION' | 'INTERNAL' | 'DEVELOPMENT' | 'UNKNOWN';

/**
 * Forensic-audit fix (2026-08-28): the configured Paystack key mode is
 * known and fixed at the moment a purchase_session/customer row is
 * inserted — the same evidence migration 0029 used after the fact
 * (Paystack gateway_response.domain), applied proactively instead of
 * leaving every new row stuck at migration 0028's 'UNKNOWN' default
 * forever. INTERNAL is deliberately never assigned here — telling a
 * genuine customer transaction apart from the founder's own real-money
 * internal use requires human judgment (who the person actually is),
 * exactly as migration 0029 itself required a founder review pass; an
 * automated guess at that distinction would be exactly the kind of
 * "change the meaning of the filters" this fix must not do.
 */
export function paystackKeyToDataClassification(secretKey: string | undefined): DataClassification {
  if (!secretKey) return 'UNKNOWN';
  const mode = classifyPaystackEnvironment(secretKey);
  if (mode === 'live') return 'PRODUCTION';
  if (mode === 'test') return 'DEVELOPMENT';
  return 'UNKNOWN';
}
