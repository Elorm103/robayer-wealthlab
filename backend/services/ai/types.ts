/**
 * AI Provider Abstraction — Version 5.0 Milestone 1 (AI Gateway
 * Foundation), see docs/v5.0-ai-gateway.md.
 *
 * Every AI provider this project ever integrates implements this one
 * shape — the exact same pattern already proven by
 * services/payments/types.ts's `PaymentProvider`: the Gateway (the
 * only caller — see ../aiGateway.ts) depends on `AiProvider`, never on
 * a specific vendor's SDK or request/response shape directly. Adding a
 * second provider (Anthropic, etc.) means writing one more file in
 * `providers/` and one more case in `providerRegistry.ts`'s selector —
 * never touching `aiGateway.ts`, the routing config, or any
 * customer-/admin-facing code that eventually calls `callAi()`.
 */

import type { Env } from '../../worker/env';

/**
 * Shared between every AiProvider implementation (as the fallback
 * when a caller omits `maxTokens`) and services/ai/aiGateway.ts (as
 * the assumed output-token ceiling for preventive cost estimation —
 * Version 5.0 Milestone 1.2, Task 1). Defined once here so the two
 * can never drift out of sync with each other.
 */
export const DEFAULT_MAX_TOKENS = 512;

export interface CompletionRequest {
  model: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResult {
  content: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export interface AiProvider {
  name: string;

  /** Whether this provider can serve the given model id — used by the Gateway to validate a routing-table entry rather than discovering an unsupported model only at call time. */
  supportsModel(model: string): boolean;

  /**
   * Calls the provider's own completion endpoint. Must never be
   * passed anything the caller (aiGateway.ts) hasn't already resolved
   * from the routing config — a model name never originates from
   * request-time, feature-level code (see docs/v5.0-ai-gateway.md's
   * "Prompt versioning"/routing-table design).
   */
  complete(request: CompletionRequest, env: Env): Promise<CompletionResult>;

  /**
   * Returns a real integer cost in **USD micros** (1 micro =
   * $0.000001) — deliberately USD, not GHS pesewas, even though every
   * other financial figure in this codebase is pesewas. OpenAI (and
   * every other AI provider) bills in USD; converting to GHS here
   * would require this project to maintain its own USD→GHS exchange
   * rate, which does not exist anywhere else in this codebase and
   * would be a fabricated, drifting number this project's "never
   * guess" discipline (see docs/v4.9-production-certificate.md's
   * Known Limitations reasoning, applied here) explicitly argues
   * against. `ai_usage_log.cost_usd_micros` is the authoritative,
   * real unit — a future Executive Dashboard "AI cost" section should
   * either display it in USD directly or apply a real, sourced
   * exchange rate at display time, never bake a guessed one into
   * storage.
   */
  estimateCostUsdMicros(tokensIn: number, tokensOut: number, model: string): number;
}
