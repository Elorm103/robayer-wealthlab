/**
 * AI Gateway runtime configuration — Version 5.0 Milestone 1.2 (AI
 * Governance & Safety). The SINGLE place budget and retention config
 * is read from `site_settings`, for both the Gateway's own
 * enforcement (services/ai/aiGateway.ts) and the admin-facing
 * dashboard/editor (services/admin/settingsService.ts).
 *
 * This file exists specifically to avoid a circular import: Milestone
 * 1.1 left the Gateway with no way to read its own configured cost
 * cap without importing services/admin/settingsService.ts, which
 * itself already imports FROM services/ai/ (routingConfig.ts, for the
 * dashboard's routing snapshot). services/ai/ importing
 * services/admin/ would create exactly the cycle that import
 * direction is supposed to prevent. Putting the raw read here — a
 * small, self-contained module with no dependency on
 * settingsService.ts's generic editable-settings machinery — lets
 * services/ai/aiGateway.ts depend on it directly (services/ai →
 * services/ai, always safe), while services/admin/settingsService.ts
 * delegates its own reads here too (services/admin → services/ai, the
 * already-established safe direction) rather than maintaining a
 * second, independent copy of the same key names and defaults.
 *
 * settingsService.ts remains the only code that WRITES to
 * site_settings (validation + the PATCH endpoint) — this file only
 * reads.
 *
 * Budget model (Task 1's five enforcement layers):
 *   - Per-request cap: the maximum a single call may cost.
 *   - Daily budget: total spend across every feature/provider, rolling 24h.
 *   - Monthly budget: total spend across every feature/provider, rolling 30 days.
 *   - Provider budget: a LIFETIME ceiling for one specific provider
 *     (e.g. "OpenAI may never cost this business more than $X, ever"),
 *     distinct from the rolling time windows above.
 *   - Platform budget: the ultimate LIFETIME ceiling across every
 *     provider and every feature combined.
 * `null` for daily/monthly/provider/platform is a valid, EXPLICIT
 * "no limit" — but the DEFAULT (a key that was never configured at
 * all) is always a real, protective number, never null. That is the
 * literal mechanism behind Task 2's "every feature must inherit a
 * default budget automatically" / "make unsafe configurations
 * impossible."
 *
 * The specific default dollar figures below are engineering-judgment
 * placeholders, not founder-approved business figures — chosen to be
 * clearly conservative for a platform with a handful of internal
 * diagnostic calls today, and adjustable at any time via the Settings
 * page. See the Milestone 1.2 Governance Report for this same caveat
 * stated to the founder directly.
 */

import type { Env } from '../../worker/env';

export interface AiGatewayBudgetConfig {
  perRequestCapUsdMicros: number;
  dailyBudgetUsdMicros: number | null;
  monthlyBudgetUsdMicros: number | null;
  /** Per-provider LIFETIME ceiling. A provider absent from this map falls back to `defaultProviderBudgetUsdMicros`. */
  providerBudgetsUsdMicros: Record<string, number | null>;
  defaultProviderBudgetUsdMicros: number | null;
  platformBudgetUsdMicros: number | null;
}

export const DEFAULT_PER_REQUEST_CAP_USD_MICROS = 1_000; // $0.001
export const DEFAULT_DAILY_BUDGET_USD_MICROS = 1_000_000; // $1.00
export const DEFAULT_MONTHLY_BUDGET_USD_MICROS = 20_000_000; // $20.00
export const DEFAULT_PROVIDER_BUDGET_USD_MICROS = 50_000_000; // $50.00 lifetime, per provider
export const DEFAULT_PLATFORM_BUDGET_USD_MICROS = 100_000_000; // $100.00 lifetime, across every provider

export type AiRetentionStorageMode = 'never' | 'metadata_only' | 'encrypted_prompt' | 'encrypted_response' | 'encrypted_both';
export const VALID_RETENTION_STORAGE_MODES: readonly AiRetentionStorageMode[] = ['never', 'metadata_only', 'encrypted_prompt', 'encrypted_response', 'encrypted_both'];
export const VALID_RETENTION_DAYS: readonly (number | null)[] = [30, 90, 180, 365, null]; // null = forever

export interface AiGatewayRetentionConfig {
  storageMode: AiRetentionStorageMode;
  retentionDays: number | null;
}

/**
 * 'metadata_only' — the safe default. Storing raw or even encrypted
 * prompt/response text is something an admin must deliberately opt
 * into (and, for the two encrypted modes, requires the
 * AI_PROMPT_ENCRYPTION_KEY secret to actually be set — see
 * services/ai/promptEncryption.ts). Until an admin makes that choice,
 * no prompt/response text is ever persisted, only the numeric/metadata
 * columns this table already stored before Milestone 1.2.
 */
export const DEFAULT_RETENTION_CONFIG: AiGatewayRetentionConfig = { storageMode: 'metadata_only', retentionDays: 90 };

interface RawSettingsRow {
  key: string;
  value: string;
}

async function readKeys(env: Env, keys: string[]): Promise<Map<string, unknown>> {
  const placeholders = keys.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(`SELECT key, value FROM site_settings WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<RawSettingsRow>();
  const map = new Map<string, unknown>();
  for (const row of results) {
    try {
      map.set(row.key, JSON.parse(row.value));
    } catch {
      // Malformed stored value — falls back to the default, same
      // "never 500 a read" posture as settingsService.ts's own
      // readRawSettings().
    }
  }
  return map;
}

export async function getAiGatewayBudgetConfig(env: Env): Promise<AiGatewayBudgetConfig> {
  const raw = await readKeys(env, [
    'ai_gateway_cost_cap_usd_micros',
    'ai_gateway_daily_budget_usd_micros',
    'ai_gateway_monthly_budget_usd_micros',
    'ai_gateway_provider_budgets_usd_micros',
    'ai_gateway_platform_budget_usd_micros',
  ]);

  const perRequestCapUsdMicros = typeof raw.get('ai_gateway_cost_cap_usd_micros') === 'number' ? (raw.get('ai_gateway_cost_cap_usd_micros') as number) : DEFAULT_PER_REQUEST_CAP_USD_MICROS;
  const dailyBudgetUsdMicros = raw.has('ai_gateway_daily_budget_usd_micros') ? (raw.get('ai_gateway_daily_budget_usd_micros') as number | null) : DEFAULT_DAILY_BUDGET_USD_MICROS;
  const monthlyBudgetUsdMicros = raw.has('ai_gateway_monthly_budget_usd_micros') ? (raw.get('ai_gateway_monthly_budget_usd_micros') as number | null) : DEFAULT_MONTHLY_BUDGET_USD_MICROS;
  const providerBudgetsUsdMicros = (raw.get('ai_gateway_provider_budgets_usd_micros') as Record<string, number | null> | undefined) ?? {};
  const platformBudgetUsdMicros = raw.has('ai_gateway_platform_budget_usd_micros') ? (raw.get('ai_gateway_platform_budget_usd_micros') as number | null) : DEFAULT_PLATFORM_BUDGET_USD_MICROS;

  return {
    perRequestCapUsdMicros,
    dailyBudgetUsdMicros,
    monthlyBudgetUsdMicros,
    providerBudgetsUsdMicros,
    defaultProviderBudgetUsdMicros: DEFAULT_PROVIDER_BUDGET_USD_MICROS,
    platformBudgetUsdMicros,
  };
}

/** Resolves the effective lifetime budget for a specific provider — its explicit override if configured, else the platform-wide per-provider default. */
export function resolveProviderBudget(config: AiGatewayBudgetConfig, provider: string): number | null {
  return provider in config.providerBudgetsUsdMicros ? config.providerBudgetsUsdMicros[provider] : config.defaultProviderBudgetUsdMicros;
}

export async function getAiGatewayRetentionConfig(env: Env): Promise<AiGatewayRetentionConfig> {
  const raw = await readKeys(env, ['ai_gateway_retention_storage_mode', 'ai_gateway_retention_days']);

  const storageModeRaw = raw.get('ai_gateway_retention_storage_mode');
  const storageMode = typeof storageModeRaw === 'string' && (VALID_RETENTION_STORAGE_MODES as string[]).includes(storageModeRaw) ? (storageModeRaw as AiRetentionStorageMode) : DEFAULT_RETENTION_CONFIG.storageMode;

  const retentionDaysRaw = raw.get('ai_gateway_retention_days');
  const retentionDays = raw.has('ai_gateway_retention_days') && (retentionDaysRaw === null || (VALID_RETENTION_DAYS as (number | null)[]).includes(retentionDaysRaw as number))
    ? (retentionDaysRaw as number | null)
    : DEFAULT_RETENTION_CONFIG.retentionDays;

  return { storageMode, retentionDays };
}
