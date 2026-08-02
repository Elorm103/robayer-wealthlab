/**
 * AI Gateway — Version 5.0 Milestone 1. See docs/v5.0-ai-gateway.md.
 *
 * `callAi()` is the ONLY door. Every current and future AI feature —
 * customer-facing or admin-facing — calls this function and never a
 * provider SDK or `fetch()` to an AI vendor directly. This is not a
 * convention this project merely asks engineers to follow; it is the
 * literal only way this codebase can reach an AI provider at all,
 * since no other module imports `services/ai/providers/*` except
 * `providerRegistry.ts`, which only this file imports.
 *
 * Responsibilities, matching docs/v5.0-ai-gateway.md exactly:
 *  - Model routing + fallback (§5) — tries routing candidates in
 *    order, falls through to the next on any failure.
 *  - Prompt resolution (§6) — an optional stored, versioned prompt
 *    (ai_prompts), or a raw prompt for internal/diagnostic calls.
 *  - Usage tracking (§7) — one ai_usage_log row per call, success or
 *    failure, with data_classification from day one.
 *  - Cost ceiling (§8) — `maxCostUsdMicros` refuses an over-budget
 *    candidate and tries the next one, rather than silently
 *    overspending.
 *
 * Deliberately NOT this function's job (per the design doc's own
 * "what this Gateway deliberately does NOT do", §9): rate limiting
 * (stays at the route layer, via middleware/rateLimit.ts, exactly like
 * every other endpoint in this codebase) and audit logging of a
 * feature's specific side effect (stays the calling feature's
 * responsibility, via services/admin/auditService.ts, if the feature
 * has one — a Gateway call itself is not treated as an auditable
 * business event, only the calling feature's own action is).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { getAiProvider } from './providerRegistry';
import { getRoutingCandidates } from './routingConfig';

export type AiActorType = 'customer' | 'admin' | 'system';

export interface AiGatewayRequest {
  /** e.g. 'internal.gateway-diagnostic' — resolved against routingConfig.ts, never a provider/model name itself. */
  feature: string;
  actorType: AiActorType;
  actorId: number | null;
  /** Resolves the current version of a stored prompt template from ai_prompts, if provided. Real customer-/admin-facing features (Milestone 4+) should register a versioned prompt rather than passing raw text — see docs/v5.0-ai-gateway.md §6. Internal/diagnostic calls may omit this and pass systemPrompt/userPrompt directly. */
  promptKey?: string;
  systemPrompt?: string;
  userPrompt: string;
  maxCostUsdMicros?: number;
}

export interface AiGatewayResponse {
  content: string;
  provider: string;
  model: string;
  promptVersion: number | null;
  costUsdMicros: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  fallbackUsed: boolean;
}

interface ResolvedPrompt {
  version: number;
  template: string;
}

async function resolvePrompt(env: Env, promptKey: string): Promise<ResolvedPrompt | null> {
  const row = await env.DB.prepare(`SELECT version, template FROM ai_prompts WHERE prompt_key = ? ORDER BY version DESC LIMIT 1`)
    .bind(promptKey)
    .first<{ version: number; template: string }>();
  return row ?? null;
}

async function logUsage(
  env: Env,
  logger: Logger,
  entry: {
    feature: string;
    provider: string;
    model: string;
    actorType: AiActorType;
    actorId: number | null;
    promptKey: string | null;
    promptVersion: number | null;
    tokensIn: number;
    tokensOut: number;
    costUsdMicros: number;
    latencyMs: number;
    fallbackUsed: boolean;
    succeeded: boolean;
    errorMessage: string | null;
  }
): Promise<void> {
  // Mirrors auditService.record()'s own "never let a logging failure
  // fail the calling request" posture — the AI call itself already
  // happened (or genuinely failed) by the time this runs; a failure to
  // *log* that must not additionally break the caller.
  try {
    await env.DB.prepare(
      `INSERT INTO ai_usage_log (
         feature, provider, model, actor_type, actor_id, prompt_key, prompt_version,
         tokens_in, tokens_out, cost_usd_micros, latency_ms, fallback_used, succeeded, error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        entry.feature,
        entry.provider,
        entry.model,
        entry.actorType,
        entry.actorId,
        entry.promptKey,
        entry.promptVersion,
        entry.tokensIn,
        entry.tokensOut,
        entry.costUsdMicros,
        entry.latencyMs,
        entry.fallbackUsed ? 1 : 0,
        entry.succeeded ? 1 : 0,
        entry.errorMessage
      )
      .run();
  } catch (err) {
    logger.error('ai_gateway.usage_log_write_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function callAi(env: Env, logger: Logger, request: AiGatewayRequest): Promise<AiGatewayResponse> {
  const candidates = getRoutingCandidates(request.feature);

  let resolvedPrompt: ResolvedPrompt | null = null;
  if (request.promptKey) {
    resolvedPrompt = await resolvePrompt(env, request.promptKey);
    if (!resolvedPrompt) {
      throw new Error(`No stored prompt found for prompt_key "${request.promptKey}".`);
    }
  }

  const systemPrompt = resolvedPrompt?.template ?? request.systemPrompt;

  let lastError: Error | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const fallbackUsed = i > 0;
    const provider = getAiProvider(candidate.provider);

    if (!provider.supportsModel(candidate.model)) {
      lastError = new Error(`Provider "${candidate.provider}" does not support model "${candidate.model}" (routing misconfiguration).`);
      continue;
    }

    const startedAt = Date.now();
    try {
      const result = await provider.complete(
        { model: candidate.model, systemPrompt, userPrompt: request.userPrompt },
        env
      );
      const latencyMs = Date.now() - startedAt;
      const costUsdMicros = provider.estimateCostUsdMicros(result.tokensIn, result.tokensOut, result.model);

      if (request.maxCostUsdMicros !== undefined && costUsdMicros > request.maxCostUsdMicros) {
        // Over budget — refuse this candidate and try the next
        // (typically cheaper) one, per docs/v5.0-ai-gateway.md §8,
        // rather than silently overspending. Logged as a failure so
        // the over-budget attempt is still visible in usage tracking.
        await logUsage(env, logger, {
          feature: request.feature,
          provider: candidate.provider,
          model: candidate.model,
          actorType: request.actorType,
          actorId: request.actorId,
          promptKey: request.promptKey ?? null,
          promptVersion: resolvedPrompt?.version ?? null,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          costUsdMicros,
          latencyMs,
          fallbackUsed,
          succeeded: false,
          errorMessage: `Cost ${costUsdMicros} micros exceeded cap ${request.maxCostUsdMicros}.`,
        });
        lastError = new Error(`Candidate "${candidate.provider}/${candidate.model}" exceeded the cost cap.`);
        continue;
      }

      await logUsage(env, logger, {
        feature: request.feature,
        provider: candidate.provider,
        model: candidate.model,
        actorType: request.actorType,
        actorId: request.actorId,
        promptKey: request.promptKey ?? null,
        promptVersion: resolvedPrompt?.version ?? null,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsdMicros,
        latencyMs,
        fallbackUsed,
        succeeded: true,
        errorMessage: null,
      });

      return {
        content: result.content,
        provider: candidate.provider,
        model: result.model,
        promptVersion: resolvedPrompt?.version ?? null,
        costUsdMicros,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs,
        fallbackUsed,
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : 'Unknown AI provider error';
      await logUsage(env, logger, {
        feature: request.feature,
        provider: candidate.provider,
        model: candidate.model,
        actorType: request.actorType,
        actorId: request.actorId,
        promptKey: request.promptKey ?? null,
        promptVersion: resolvedPrompt?.version ?? null,
        tokensIn: 0,
        tokensOut: 0,
        costUsdMicros: 0,
        latencyMs,
        fallbackUsed,
        succeeded: false,
        errorMessage,
      });
      lastError = err instanceof Error ? err : new Error(errorMessage);
      logger.error('ai_gateway.candidate_failed', { feature: request.feature, provider: candidate.provider, model: candidate.model, error: errorMessage });
    }
  }

  // Every candidate failed — matches docs/v5.0-ai-gateway.md §9 and
  // v5.0a-ai-design-principles.md §13 (Graceful Failure): the Gateway
  // itself throws here, and it is every calling feature's own
  // responsibility to catch this and degrade gracefully (e.g. a
  // disabled affordance, a "temporarily unavailable" state) rather
  // than break the page it's embedded in — the Gateway cannot know
  // what graceful degradation looks like for an arbitrary caller.
  throw lastError ?? new Error(`All routing candidates for feature "${request.feature}" failed.`);
}
