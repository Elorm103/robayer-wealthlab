/**
 * AI Gateway — Version 5.0 Milestone 1 (foundation), hardened in
 * Milestone 1.1 (operational visibility) and Milestone 1.2 (AI
 * Governance & Safety). See docs/v5.0-ai-gateway.md and
 * docs/v5.0-milestone-1.2-engineering-report.md.
 *
 * `callAi()` is the ONLY door. Every current and future AI feature —
 * customer-facing or admin-facing — calls this function and never a
 * provider SDK or `fetch()` to an AI vendor directly. This is not a
 * convention this project merely asks engineers to follow; it is the
 * literal only way this codebase can reach an AI provider at all,
 * since no other module imports `services/ai/providers/*` except
 * `providerRegistry.ts`, which only this file imports. This remains
 * the founder's permanent architectural rule for every future AI
 * product (Customer AI, Knowledge Base, Investment Assistant, Fraud
 * Detection, Recommendation Engine, Analytics AI, etc.) — see the
 * Milestone 1.2 Governance Report's "Founder Principle" section.
 *
 * Milestone 1.2 additions (Tasks 1-6):
 *  - PREVENTIVE cost enforcement (Task 1) — a candidate's maximum
 *    possible cost is estimated and checked against the per-request
 *    cap, daily budget, monthly budget, provider (lifetime) budget,
 *    and platform (lifetime) budget BEFORE the provider is ever
 *    contacted. A candidate that would exceed any of these is skipped
 *    with zero real spend, exactly like a policy or model-support
 *    failure. The pre-existing POST-call check (Milestone 1's actual
 *    reported cost vs. the effective cap) is kept as a secondary
 *    safety net — the pre-call estimate is a heuristic (see
 *    `estimateInputTokens()` below), not a guarantee, so this is
 *    genuine defense in depth, not redundant.
 *  - Mandatory default budgets (Task 2) — a caller that omits
 *    `maxCostUsdMicros` automatically inherits the platform-configured
 *    default (services/ai/aiGatewayConfig.ts), logged as such via
 *    `budget_decision`. There is no code path left where an AI call
 *    runs with literally no cost ceiling.
 *  - Data classification (Task 3) — every request MUST declare a
 *    `classification`; an unrecognized one is refused immediately,
 *    before routing is even resolved.
 *  - Provider policy (Task 4) — a candidate whose provider is not
 *    approved for the request's classification (services/ai/providerPolicy.ts)
 *    is skipped, never contacted.
 *  - Retention + masking (Tasks 5-6) — the prompt/response text that
 *    would be logged is masked for recognizable secrets
 *    (services/ai/sensitiveDataMasking.ts) and then stored according to
 *    the configured retention policy (services/ai/aiGatewayConfig.ts),
 *    optionally AES-GCM encrypted (services/ai/promptEncryption.ts).
 *    Masking/retention apply ONLY to what gets written to
 *    `ai_usage_log` — never to the actual request sent to the
 *    provider.
 *
 * Deliberately NOT this function's job (unchanged from Milestone 1):
 * rate limiting (stays at the route layer, via middleware/rateLimit.ts)
 * and audit logging of a feature's specific side effect (stays the
 * calling feature's responsibility, via services/admin/auditService.ts).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { getAiProvider } from './providerRegistry';
import { getRoutingCandidates } from './routingConfig';
import { DEFAULT_MAX_TOKENS } from './types';
import { getAiGatewayBudgetConfig, getAiGatewayRetentionConfig, resolveProviderBudget, type AiGatewayBudgetConfig, type AiGatewayRetentionConfig } from './aiGatewayConfig';
import { isValidSensitivityClassification, isProviderApprovedForClassification, POLICY_VERSION, type AiSensitivityClassification } from './providerPolicy';
import { maskSensitiveData } from './sensitiveDataMasking';
import { encryptText, isEncryptionAvailable } from './promptEncryption';

export const GATEWAY_VERSION = '1.2.0';

export type AiActorType = 'customer' | 'admin' | 'system';

export class AiClassificationError extends Error {
  readonly name = 'AiClassificationError';
}

export class AiPolicyViolationError extends Error {
  readonly name = 'AiPolicyViolationError';
}

export class AiBudgetExceededError extends Error {
  readonly name = 'AiBudgetExceededError';
}

export interface AiGatewayRequest {
  /** e.g. 'internal.gateway-diagnostic' — resolved against routingConfig.ts, never a provider/model name itself. */
  feature: string;
  actorType: AiActorType;
  actorId: number | null;
  /** admin_sessions.id, when actorType is 'admin' and the call happened within a real authenticated session — see requireAuth's AdminAuthContext.sessionId. Version 5.0 Milestone 1.1, purely for the AI Usage Log's "Session ID" column; never used for authorization. */
  sessionId?: number | null;
  /**
   * Version 5.0 Milestone 1.2, Task 3 — MANDATORY. What kind of
   * sensitive data this request's prompt touches. Entirely separate
   * from `ai_usage_log.data_classification` (PRODUCTION/INTERNAL/
   * DEVELOPMENT/UNKNOWN, the pre-existing Version 4.9 "is this real
   * traffic" convention) — see services/ai/providerPolicy.ts's header
   * comment. An unrecognized value throws AiClassificationError before
   * anything else in this function runs.
   */
  classification: AiSensitivityClassification;
  /** Resolves the current version of a stored prompt template from ai_prompts, if provided. Real customer-/admin-facing features (Milestone 4+) should register a versioned prompt rather than passing raw text — see docs/v5.0-ai-gateway.md §6. Internal/diagnostic calls may omit this and pass systemPrompt/userPrompt directly. */
  promptKey?: string;
  systemPrompt?: string;
  userPrompt: string;
  /** Per-request cost ceiling override. Omit to inherit the platform-configured default (Task 2) — there is no way to run a call with no ceiling at all. */
  maxCostUsdMicros?: number;
  maxTokens?: number;
  /**
   * Version 5.0 Milestone 1.1 — reserved, currently a no-op. Every
   * future AI product (Customer AI, Knowledge Base, Investment
   * Assistant, Fraud Detection, Recommendation Engine, etc.) will
   * eventually need to inject prior conversation turns, retrieved
   * documents, or business-context snippets into a call without each
   * feature reinventing its own mechanism. Reserving the shape now (an
   * ordered list of plain-text snippets the Gateway would one day
   * splice into the prompt ahead of systemPrompt/userPrompt) means a
   * future milestone can add real memory storage/retrieval and wire it
   * in here without redesigning this interface. callAi() does not read
   * this field yet — passing it today has no effect on the request
   * sent to the provider.
   */
  memoryContext?: string[];
}

export interface AiGatewayResponse {
  content: string;
  provider: string;
  model: string;
  classification: AiSensitivityClassification;
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

/**
 * Conservative token-count heuristic (~4 characters per token, rounded
 * UP) used only for the PRE-call cost estimate — this project has no
 * tokenizer library dependency, and adding one purely to shave
 * precision off an estimate used for a safety check was judged not
 * worth the new dependency. Deliberately biased to over-estimate
 * (ceil, not round), so a borderline call is more likely to be
 * preventively rejected than to slip through — see the Milestone 1.2
 * Known Limitations report for the honest precision caveat.
 */
export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMaxCostUsdMicros(
  provider: ReturnType<typeof getAiProvider>,
  model: string,
  promptText: string,
  maxTokens: number | undefined
): number {
  const estimatedTokensIn = estimateInputTokens(promptText);
  const estimatedMaxTokensOut = maxTokens ?? DEFAULT_MAX_TOKENS;
  return provider.estimateCostUsdMicros(estimatedTokensIn, estimatedMaxTokensOut, model);
}

interface SpendSnapshot {
  todayUsdMicros: number;
  last30dUsdMicros: number;
  platformLifetimeUsdMicros: number;
}

async function getSpendSnapshot(env: Env): Promise<SpendSnapshot> {
  const [today, last30d, lifetime] = await Promise.all([
    env.DB.prepare(`SELECT COALESCE(SUM(cost_usd_micros), 0) AS cost FROM ai_usage_log WHERE date(created_at) = date('now')`).first<{ cost: number }>(),
    env.DB.prepare(`SELECT COALESCE(SUM(cost_usd_micros), 0) AS cost FROM ai_usage_log WHERE created_at > datetime('now', '-30 days')`).first<{ cost: number }>(),
    env.DB.prepare(`SELECT COALESCE(SUM(cost_usd_micros), 0) AS cost FROM ai_usage_log`).first<{ cost: number }>(),
  ]);
  return {
    todayUsdMicros: today?.cost ?? 0,
    last30dUsdMicros: last30d?.cost ?? 0,
    platformLifetimeUsdMicros: lifetime?.cost ?? 0,
  };
}

const providerSpendCache = new Map<string, number>();

async function getProviderLifetimeSpend(env: Env, provider: string): Promise<number> {
  if (providerSpendCache.has(provider)) return providerSpendCache.get(provider)!;
  const row = await env.DB.prepare(`SELECT COALESCE(SUM(cost_usd_micros), 0) AS cost FROM ai_usage_log WHERE provider = ?`).bind(provider).first<{ cost: number }>();
  const spend = row?.cost ?? 0;
  providerSpendCache.set(provider, spend);
  return spend;
}

interface BudgetCheck {
  ok: boolean;
  decision: string;
  effectiveCapUsdMicros: number;
}

function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

/**
 * Takes just `maxCostUsdMicrosOverride` (not a whole request object) so
 * both `callAi()` and Version 5.0 Milestone 2's `embedText()` — two
 * genuinely different request shapes — can share one budget-check
 * implementation rather than each maintaining its own copy.
 */
async function checkBudget(
  env: Env,
  maxCostUsdMicrosOverride: number | undefined,
  budgetConfig: AiGatewayBudgetConfig,
  spend: SpendSnapshot,
  provider: string,
  estimatedCostUsdMicros: number
): Promise<BudgetCheck> {
  const usingDefaultCap = maxCostUsdMicrosOverride === undefined;
  const effectiveCapUsdMicros = maxCostUsdMicrosOverride ?? budgetConfig.perRequestCapUsdMicros;
  const capNote = usingDefaultCap ? ' (default cap inherited — no maxCostUsdMicros supplied)' : '';

  if (estimatedCostUsdMicros > effectiveCapUsdMicros) {
    return { ok: false, decision: `rejected: estimated cost ${formatUsd(estimatedCostUsdMicros)} exceeds per-request cap ${formatUsd(effectiveCapUsdMicros)}${capNote}`, effectiveCapUsdMicros };
  }
  if (budgetConfig.dailyBudgetUsdMicros !== null && spend.todayUsdMicros + estimatedCostUsdMicros > budgetConfig.dailyBudgetUsdMicros) {
    return {
      ok: false,
      decision: `rejected: daily budget would be exceeded (${formatUsd(spend.todayUsdMicros)} spent + est. ${formatUsd(estimatedCostUsdMicros)} > ${formatUsd(budgetConfig.dailyBudgetUsdMicros)} daily budget)`,
      effectiveCapUsdMicros,
    };
  }
  if (budgetConfig.monthlyBudgetUsdMicros !== null && spend.last30dUsdMicros + estimatedCostUsdMicros > budgetConfig.monthlyBudgetUsdMicros) {
    return {
      ok: false,
      decision: `rejected: monthly budget would be exceeded (${formatUsd(spend.last30dUsdMicros)} spent + est. ${formatUsd(estimatedCostUsdMicros)} > ${formatUsd(budgetConfig.monthlyBudgetUsdMicros)} monthly budget)`,
      effectiveCapUsdMicros,
    };
  }
  const providerBudget = resolveProviderBudget(budgetConfig, provider);
  if (providerBudget !== null) {
    const providerSpend = await getProviderLifetimeSpend(env, provider);
    if (providerSpend + estimatedCostUsdMicros > providerBudget) {
      return {
        ok: false,
        decision: `rejected: provider "${provider}" lifetime budget would be exceeded (${formatUsd(providerSpend)} spent + est. ${formatUsd(estimatedCostUsdMicros)} > ${formatUsd(providerBudget)} provider budget)`,
        effectiveCapUsdMicros,
      };
    }
  }
  if (budgetConfig.platformBudgetUsdMicros !== null && spend.platformLifetimeUsdMicros + estimatedCostUsdMicros > budgetConfig.platformBudgetUsdMicros) {
    return {
      ok: false,
      decision: `rejected: platform lifetime budget would be exceeded (${formatUsd(spend.platformLifetimeUsdMicros)} spent + est. ${formatUsd(estimatedCostUsdMicros)} > ${formatUsd(budgetConfig.platformBudgetUsdMicros)} platform budget)`,
      effectiveCapUsdMicros,
    };
  }

  return { ok: true, decision: `approved: est. ${formatUsd(estimatedCostUsdMicros)} within all configured budgets (per-request cap ${formatUsd(effectiveCapUsdMicros)}${capNote})`, effectiveCapUsdMicros };
}

interface StorageFields {
  promptTextToStore: string | null;
  responseTextToStore: string | null;
  maskingApplied: boolean;
  retentionDecision: string;
  cleanupEligibleDays: number | null;
}

/**
 * Applies masking (Task 6) then the configured retention policy (Task
 * 5) to decide exactly what — if anything — gets written to
 * `ai_usage_log.prompt_text`/`response_text`. Masking is computed
 * regardless of the storage decision, so "was a secret pattern
 * detected" remains a real, queryable signal even when the text
 * itself is never persisted.
 */
async function prepareStorageFields(env: Env, retentionConfig: AiGatewayRetentionConfig, rawPromptText: string, rawResponseText: string | null): Promise<StorageFields> {
  const promptMask = maskSensitiveData(rawPromptText);
  const responseMask = maskSensitiveData(rawResponseText);
  const maskingApplied = promptMask.wasMasked || responseMask.wasMasked;
  const cleanupEligibleDays = retentionConfig.retentionDays;

  if (retentionConfig.storageMode === 'never' || retentionConfig.storageMode === 'metadata_only') {
    return {
      promptTextToStore: null,
      responseTextToStore: null,
      maskingApplied,
      retentionDecision: retentionConfig.storageMode,
      cleanupEligibleDays: null, // nothing stored, nothing to ever clean up
    };
  }

  const wantsPrompt = retentionConfig.storageMode === 'encrypted_prompt' || retentionConfig.storageMode === 'encrypted_both';
  const wantsResponse = retentionConfig.storageMode === 'encrypted_response' || retentionConfig.storageMode === 'encrypted_both';

  if (!(await isEncryptionAvailable(env))) {
    // Fail SAFE, never fail open: an encrypted mode was configured but
    // AI_PROMPT_ENCRYPTION_KEY is absent/malformed — do not fall back
    // to storing plaintext. Recorded in retention_decision so this is
    // visible on the dashboard, not a silent downgrade.
    return {
      promptTextToStore: null,
      responseTextToStore: null,
      maskingApplied,
      retentionDecision: `${retentionConfig.storageMode} requested but AI_PROMPT_ENCRYPTION_KEY is not configured — stored as metadata_only instead`,
      cleanupEligibleDays: null,
    };
  }

  const promptTextToStore = wantsPrompt && promptMask.masked !== null ? await encryptText(env, promptMask.masked) : null;
  const responseTextToStore = wantsResponse && responseMask.masked !== null ? await encryptText(env, responseMask.masked) : null;

  return {
    promptTextToStore,
    responseTextToStore,
    maskingApplied,
    retentionDecision: `${retentionConfig.storageMode}, ${retentionConfig.retentionDays === null ? 'forever' : `${retentionConfig.retentionDays} days`}`,
    cleanupEligibleDays,
  };
}

interface LogUsageEntry {
  feature: string;
  provider: string;
  model: string;
  actorType: AiActorType;
  actorId: number | null;
  sessionId: number | null;
  classification: AiSensitivityClassification;
  promptKey: string | null;
  promptVersion: number | null;
  storage: StorageFields;
  tokensIn: number;
  tokensOut: number;
  costUsdMicros: number;
  latencyMs: number;
  fallbackUsed: boolean;
  succeeded: boolean;
  errorMessage: string | null;
  providerDecision: string;
  budgetDecision: string;
}

async function logUsage(env: Env, logger: Logger, entry: LogUsageEntry): Promise<void> {
  // Mirrors auditService.record()'s own "never let a logging failure
  // fail the calling request" posture — the AI call itself already
  // happened (or genuinely failed) by the time this runs; a failure to
  // *log* that must not additionally break the caller.
  try {
    await env.DB.prepare(
      `INSERT INTO ai_usage_log (
         feature, provider, model, actor_type, actor_id, session_id, sensitivity_classification, prompt_key, prompt_version,
         prompt_text, response_text, tokens_in, tokens_out, cost_usd_micros, latency_ms, fallback_used, succeeded, error_message,
         gateway_version, policy_version, provider_decision, budget_decision, retention_decision, masking_applied, cleanup_eligible_date
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', '+' || ? || ' days') END)`
    )
      .bind(
        entry.feature,
        entry.provider,
        entry.model,
        entry.actorType,
        entry.actorId,
        entry.sessionId,
        entry.classification,
        entry.promptKey,
        entry.promptVersion,
        entry.storage.promptTextToStore,
        entry.storage.responseTextToStore,
        entry.tokensIn,
        entry.tokensOut,
        entry.costUsdMicros,
        entry.latencyMs,
        entry.fallbackUsed ? 1 : 0,
        entry.succeeded ? 1 : 0,
        entry.errorMessage,
        GATEWAY_VERSION,
        POLICY_VERSION,
        entry.providerDecision,
        entry.budgetDecision,
        entry.storage.retentionDecision,
        entry.storage.maskingApplied ? 1 : 0,
        entry.storage.cleanupEligibleDays,
        entry.storage.cleanupEligibleDays
      )
      .run();
  } catch (err) {
    logger.error('ai_gateway.usage_log_write_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function callAi(env: Env, logger: Logger, request: AiGatewayRequest): Promise<AiGatewayResponse> {
  if (!isValidSensitivityClassification(request.classification)) {
    throw new AiClassificationError(`"${request.classification}" is not a recognized sensitivity classification. No AI Gateway call may proceed without a valid one.`);
  }

  const candidates = getRoutingCandidates(request.feature);

  let resolvedPrompt: ResolvedPrompt | null = null;
  if (request.promptKey) {
    resolvedPrompt = await resolvePrompt(env, request.promptKey);
    if (!resolvedPrompt) {
      throw new Error(`No stored prompt found for prompt_key "${request.promptKey}".`);
    }
  }

  const systemPrompt = resolvedPrompt?.template ?? request.systemPrompt;
  const promptText = systemPrompt ? `[system]\n${systemPrompt}\n\n[user]\n${request.userPrompt}` : request.userPrompt;

  const [budgetConfig, retentionConfig, spend] = await Promise.all([getAiGatewayBudgetConfig(env), getAiGatewayRetentionConfig(env), getSpendSnapshot(env)]);
  providerSpendCache.clear();

  let lastError: Error | null = null;
  let lastErrorKind: 'policy' | 'budget' | 'provider' | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const fallbackUsed = i > 0;
    const provider = getAiProvider(candidate.provider);

    if (!provider.supportsModel(candidate.model)) {
      lastError = new Error(`Provider "${candidate.provider}" does not support model "${candidate.model}" (routing misconfiguration).`);
      lastErrorKind = 'provider';
      continue;
    }

    // Task 4 — provider policy, checked before any budget math or
    // network call: an unapproved provider is refused regardless of
    // whether it would have been affordable.
    if (!isProviderApprovedForClassification(candidate.provider, request.classification)) {
      const providerDecision = `rejected: provider "${candidate.provider}" is not approved for classification ${request.classification} (policy v${POLICY_VERSION})`;
      const storage = await prepareStorageFields(env, retentionConfig, promptText, null);
      await logUsage(env, logger, {
        feature: request.feature,
        provider: candidate.provider,
        model: candidate.model,
        actorType: request.actorType,
        actorId: request.actorId,
        sessionId: request.sessionId ?? null,
        classification: request.classification,
        promptKey: request.promptKey ?? null,
        promptVersion: resolvedPrompt?.version ?? null,
        storage,
        tokensIn: 0,
        tokensOut: 0,
        costUsdMicros: 0,
        latencyMs: 0,
        fallbackUsed,
        succeeded: false,
        errorMessage: providerDecision,
        providerDecision,
        budgetDecision: 'not evaluated: rejected by provider policy before budget check',
      });
      lastError = new AiPolicyViolationError(providerDecision);
      lastErrorKind = 'policy';
      continue;
    }

    // Task 1 — preventive cost enforcement, checked BEFORE the
    // provider is contacted. Nothing below this point runs (no
    // network call, no real spend) if the estimate says any budget
    // layer would be exceeded.
    const estimatedCostUsdMicros = estimateMaxCostUsdMicros(provider, candidate.model, promptText, request.maxTokens);
    const budgetCheck = await checkBudget(env, request.maxCostUsdMicros, budgetConfig, spend, candidate.provider, estimatedCostUsdMicros);
    if (!budgetCheck.ok) {
      const storage = await prepareStorageFields(env, retentionConfig, promptText, null);
      await logUsage(env, logger, {
        feature: request.feature,
        provider: candidate.provider,
        model: candidate.model,
        actorType: request.actorType,
        actorId: request.actorId,
        sessionId: request.sessionId ?? null,
        classification: request.classification,
        promptKey: request.promptKey ?? null,
        promptVersion: resolvedPrompt?.version ?? null,
        storage,
        tokensIn: 0,
        tokensOut: 0,
        costUsdMicros: 0,
        latencyMs: 0,
        fallbackUsed,
        succeeded: false,
        errorMessage: budgetCheck.decision,
        providerDecision: `${candidate.provider}/${candidate.model}: policy-approved, not attempted (rejected before call)`,
        budgetDecision: budgetCheck.decision,
      });
      lastError = new AiBudgetExceededError(budgetCheck.decision);
      lastErrorKind = 'budget';
      continue;
    }

    const startedAt = Date.now();
    try {
      const result = await provider.complete({ model: candidate.model, systemPrompt, userPrompt: request.userPrompt, maxTokens: request.maxTokens }, env);
      const latencyMs = Date.now() - startedAt;
      const costUsdMicros = provider.estimateCostUsdMicros(result.tokensIn, result.tokensOut, result.model);

      // Secondary, POST-call safety net — the pre-call estimate above
      // is a heuristic (see estimateInputTokens()'s header comment),
      // not exact, so this catches the rare case where the real cost
      // exceeds what was estimated. By this point the provider has
      // already been billed for this call; see the Milestone 1.2
      // Known Limitations report for why no non-streaming API can ever
      // make this check fully preventive for the FINAL token of a
      // response.
      if (costUsdMicros > budgetCheck.effectiveCapUsdMicros) {
        const storage = await prepareStorageFields(env, retentionConfig, promptText, result.content);
        await logUsage(env, logger, {
          feature: request.feature,
          provider: candidate.provider,
          model: candidate.model,
          actorType: request.actorType,
          actorId: request.actorId,
          sessionId: request.sessionId ?? null,
          classification: request.classification,
          promptKey: request.promptKey ?? null,
          promptVersion: resolvedPrompt?.version ?? null,
          storage,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          costUsdMicros,
          latencyMs,
          fallbackUsed,
          succeeded: false,
          errorMessage: `Actual cost ${formatUsd(costUsdMicros)} exceeded cap ${formatUsd(budgetCheck.effectiveCapUsdMicros)} (post-call check — the pre-call estimate under-predicted this one).`,
          providerDecision: `${candidate.provider}/${candidate.model}: called, response received`,
          budgetDecision: `post-call rejection: actual cost exceeded the cap the pre-call estimate said would be safe`,
        });
        lastError = new AiBudgetExceededError(`Candidate "${candidate.provider}/${candidate.model}" exceeded the cost cap after the call completed.`);
        lastErrorKind = 'budget';
        continue;
      }

      const storage = await prepareStorageFields(env, retentionConfig, promptText, result.content);
      await logUsage(env, logger, {
        feature: request.feature,
        provider: candidate.provider,
        model: candidate.model,
        actorType: request.actorType,
        actorId: request.actorId,
        sessionId: request.sessionId ?? null,
        classification: request.classification,
        promptKey: request.promptKey ?? null,
        promptVersion: resolvedPrompt?.version ?? null,
        storage,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsdMicros,
        latencyMs,
        fallbackUsed,
        succeeded: true,
        errorMessage: null,
        providerDecision: `${candidate.provider}/${candidate.model}: policy-approved and used`,
        budgetDecision: budgetCheck.decision,
      });

      return {
        content: result.content,
        provider: candidate.provider,
        model: result.model,
        classification: request.classification,
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
      const storage = await prepareStorageFields(env, retentionConfig, promptText, null);
      await logUsage(env, logger, {
        feature: request.feature,
        provider: candidate.provider,
        model: candidate.model,
        actorType: request.actorType,
        actorId: request.actorId,
        sessionId: request.sessionId ?? null,
        classification: request.classification,
        promptKey: request.promptKey ?? null,
        promptVersion: resolvedPrompt?.version ?? null,
        storage,
        tokensIn: 0,
        tokensOut: 0,
        costUsdMicros: 0,
        latencyMs,
        fallbackUsed,
        succeeded: false,
        errorMessage,
        providerDecision: `${candidate.provider}/${candidate.model}: called, request failed`,
        budgetDecision: budgetCheck.decision,
      });
      lastError = err instanceof Error ? err : new Error(errorMessage);
      lastErrorKind = 'provider';
      logger.error('ai_gateway.candidate_failed', { feature: request.feature, provider: candidate.provider, model: candidate.model, error: errorMessage });
    }
  }

  // Every candidate failed — matches docs/v5.0-ai-gateway.md §9 and
  // v5.0a-ai-design-principles.md §13 (Graceful Failure): the Gateway
  // itself throws here, and it is every calling feature's own
  // responsibility to catch this and degrade gracefully. The thrown
  // error TYPE reflects the last reason a candidate was rejected
  // (policy/budget/provider) so a caller — or a route handler mapping
  // to an ApiErrorCode — can distinguish "OpenAI is down" from
  // "governance refused this on purpose" without parsing message text.
  if (lastErrorKind === 'budget' && lastError) throw lastError;
  if (lastErrorKind === 'policy' && lastError) throw lastError;
  throw lastError ?? new Error(`All routing candidates for feature "${request.feature}" failed.`);
}

// ============================================================
// Version 5.0 Milestone 2 (Knowledge Base) — embeddings.
//
// `embedText()` is `callAi()`'s sibling, not a bypass of it: it is
// still the ONLY way any code in this project may reach an embedding
// endpoint (no module besides providerRegistry.ts imports a provider
// file), and it reuses the exact same governance this file already
// enforces for completions — classification is mandatory, provider
// policy is checked per candidate, cost is estimated and checked
// PREVENTIVELY before the provider is contacted, the text being
// embedded is masked and subject to the same configured retention
// policy, and every call is logged to the same ai_usage_log table
// with the same gateway_version/policy_version/decision columns. This
// is the literal meaning of "reuse the governance framework from
// Milestone 1.2" — not a similar-looking parallel mechanism, the same
// one.
// ============================================================

export interface AiEmbeddingRequest {
  /** e.g. 'knowledge.embed' — resolved against routingConfig.ts. */
  feature: string;
  actorType: AiActorType;
  actorId: number | null;
  sessionId?: number | null;
  classification: AiSensitivityClassification;
  /** Batched — see services/ai/types.ts's EmbeddingRequest for why. */
  texts: string[];
  maxCostUsdMicros?: number;
}

export interface AiEmbeddingResponse {
  /** Same order as the input `texts` array — index-for-index. */
  embeddings: number[][];
  provider: string;
  model: string;
  tokensIn: number;
  costUsdMicros: number;
  latencyMs: number;
}

export async function embedText(env: Env, logger: Logger, request: AiEmbeddingRequest): Promise<AiEmbeddingResponse> {
  if (!isValidSensitivityClassification(request.classification)) {
    throw new AiClassificationError(`"${request.classification}" is not a recognized sensitivity classification. No AI Gateway call may proceed without a valid one.`);
  }
  if (request.texts.length === 0) {
    throw new Error('embedText() requires at least one text to embed.');
  }

  const candidates = getRoutingCandidates(request.feature);
  // Joined only for masking/estimation/audit-logging purposes — never
  // what's actually sent to the provider, which gets the real
  // `texts` array batched natively (see EmbeddingRequest's own
  // header comment on why batching, not one call per text).
  const combinedText = request.texts.join('\n\n---\n\n');

  const [budgetConfig, retentionConfig, spend] = await Promise.all([getAiGatewayBudgetConfig(env), getAiGatewayRetentionConfig(env), getSpendSnapshot(env)]);
  providerSpendCache.clear();

  let lastError: Error | null = null;
  let lastErrorKind: 'policy' | 'budget' | 'provider' | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const fallbackUsed = i > 0;
    const provider = getAiProvider(candidate.provider);

    if (!provider.supportsModel(candidate.model)) {
      lastError = new Error(`Provider "${candidate.provider}" does not support model "${candidate.model}" (routing misconfiguration).`);
      lastErrorKind = 'provider';
      continue;
    }
    if (!provider.embed) {
      lastError = new Error(`Provider "${candidate.provider}" does not implement embeddings.`);
      lastErrorKind = 'provider';
      continue;
    }

    if (!isProviderApprovedForClassification(candidate.provider, request.classification)) {
      const providerDecision = `rejected: provider "${candidate.provider}" is not approved for classification ${request.classification} (policy v${POLICY_VERSION})`;
      const storage = await prepareStorageFields(env, retentionConfig, combinedText, null);
      await logUsage(env, logger, {
        feature: request.feature,
        provider: candidate.provider,
        model: candidate.model,
        actorType: request.actorType,
        actorId: request.actorId,
        sessionId: request.sessionId ?? null,
        classification: request.classification,
        promptKey: null,
        promptVersion: null,
        storage,
        tokensIn: 0,
        tokensOut: 0,
        costUsdMicros: 0,
        latencyMs: 0,
        fallbackUsed,
        succeeded: false,
        errorMessage: providerDecision,
        providerDecision,
        budgetDecision: 'not evaluated: rejected by provider policy before budget check',
      });
      lastError = new AiPolicyViolationError(providerDecision);
      lastErrorKind = 'policy';
      continue;
    }

    const estimatedCostUsdMicros = provider.estimateCostUsdMicros(estimateInputTokens(combinedText), 0, candidate.model);
    const budgetCheck = await checkBudget(env, request.maxCostUsdMicros, budgetConfig, spend, candidate.provider, estimatedCostUsdMicros);
    if (!budgetCheck.ok) {
      const storage = await prepareStorageFields(env, retentionConfig, combinedText, null);
      await logUsage(env, logger, {
        feature: request.feature,
        provider: candidate.provider,
        model: candidate.model,
        actorType: request.actorType,
        actorId: request.actorId,
        sessionId: request.sessionId ?? null,
        classification: request.classification,
        promptKey: null,
        promptVersion: null,
        storage,
        tokensIn: 0,
        tokensOut: 0,
        costUsdMicros: 0,
        latencyMs: 0,
        fallbackUsed,
        succeeded: false,
        errorMessage: budgetCheck.decision,
        providerDecision: `${candidate.provider}/${candidate.model}: policy-approved, not attempted (rejected before call)`,
        budgetDecision: budgetCheck.decision,
      });
      lastError = new AiBudgetExceededError(budgetCheck.decision);
      lastErrorKind = 'budget';
      continue;
    }

    const startedAt = Date.now();
    try {
      const result = await provider.embed({ model: candidate.model, texts: request.texts }, env);
      const latencyMs = Date.now() - startedAt;
      const costUsdMicros = provider.estimateCostUsdMicros(result.tokensIn, 0, result.model);

      if (costUsdMicros > budgetCheck.effectiveCapUsdMicros) {
        const storage = await prepareStorageFields(env, retentionConfig, combinedText, null);
        await logUsage(env, logger, {
          feature: request.feature,
          provider: candidate.provider,
          model: candidate.model,
          actorType: request.actorType,
          actorId: request.actorId,
          sessionId: request.sessionId ?? null,
          classification: request.classification,
          promptKey: null,
          promptVersion: null,
          storage,
          tokensIn: result.tokensIn,
          tokensOut: 0,
          costUsdMicros,
          latencyMs,
          fallbackUsed,
          succeeded: false,
          errorMessage: `Actual cost ${formatUsd(costUsdMicros)} exceeded cap ${formatUsd(budgetCheck.effectiveCapUsdMicros)} (post-call check — the pre-call estimate under-predicted this one).`,
          providerDecision: `${candidate.provider}/${candidate.model}: called, response received`,
          budgetDecision: `post-call rejection: actual cost exceeded the cap the pre-call estimate said would be safe`,
        });
        lastError = new AiBudgetExceededError(`Candidate "${candidate.provider}/${candidate.model}" exceeded the cost cap after the call completed.`);
        lastErrorKind = 'budget';
        continue;
      }

      const storage = await prepareStorageFields(env, retentionConfig, combinedText, null);
      await logUsage(env, logger, {
        feature: request.feature,
        provider: candidate.provider,
        model: candidate.model,
        actorType: request.actorType,
        actorId: request.actorId,
        sessionId: request.sessionId ?? null,
        classification: request.classification,
        promptKey: null,
        promptVersion: null,
        storage,
        tokensIn: result.tokensIn,
        tokensOut: 0,
        costUsdMicros,
        latencyMs,
        fallbackUsed,
        succeeded: true,
        errorMessage: null,
        providerDecision: `${candidate.provider}/${candidate.model}: policy-approved and used`,
        budgetDecision: budgetCheck.decision,
      });

      return {
        embeddings: result.embeddings,
        provider: candidate.provider,
        model: result.model,
        tokensIn: result.tokensIn,
        costUsdMicros,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : 'Unknown AI provider error';
      const storage = await prepareStorageFields(env, retentionConfig, combinedText, null);
      await logUsage(env, logger, {
        feature: request.feature,
        provider: candidate.provider,
        model: candidate.model,
        actorType: request.actorType,
        actorId: request.actorId,
        sessionId: request.sessionId ?? null,
        classification: request.classification,
        promptKey: null,
        promptVersion: null,
        storage,
        tokensIn: 0,
        tokensOut: 0,
        costUsdMicros: 0,
        latencyMs,
        fallbackUsed,
        succeeded: false,
        errorMessage,
        providerDecision: `${candidate.provider}/${candidate.model}: called, request failed`,
        budgetDecision: budgetCheck.decision,
      });
      lastError = err instanceof Error ? err : new Error(errorMessage);
      lastErrorKind = 'provider';
      logger.error('ai_gateway.embedding_candidate_failed', { feature: request.feature, provider: candidate.provider, model: candidate.model, error: errorMessage });
    }
  }

  if (lastErrorKind === 'budget' && lastError) throw lastError;
  if (lastErrorKind === 'policy' && lastError) throw lastError;
  throw lastError ?? new Error(`All routing candidates for feature "${request.feature}" failed.`);
}
