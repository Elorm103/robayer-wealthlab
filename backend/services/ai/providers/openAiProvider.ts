/**
 * OpenAI implementation of AiProvider (../types.ts) — Version 5.0
 * Milestone 1. The first, and today the only, AiProvider this project
 * has wired up; every future provider (Anthropic, etc.) is one more
 * file in this folder plus one more case in ../providerRegistry.ts,
 * never a change here or in ../aiGateway.ts.
 *
 * Calls OpenAI's Chat Completions API (`POST /v1/chat/completions`) —
 * the same plain-fetch, bearer-auth style already proven by
 * services/payments/paystackProvider.ts and services/emailService.ts,
 * not a new HTTP pattern for this codebase.
 */

import type { Env } from '../../../worker/env';
import type { AiProvider, CompletionRequest, CompletionResult, EmbeddingRequest, EmbeddingResult } from '../types';
import { DEFAULT_MAX_TOKENS } from '../types';

/**
 * Models this provider is allowed to serve. Deliberately a small,
 * explicit allowlist (not "anything OpenAI supports") — the routing
 * config (../routingConfig.ts) is the ONE place a model name is
 * chosen for a given feature; this list exists only to let the
 * Gateway validate a routing-table entry against real, known pricing
 * (below) rather than silently accepting a typo'd or discontinued
 * model id.
 *
 * Pricing is OpenAI's own published per-1M-token rate as of this
 * milestone's implementation (2026) — USD, not GHS, per types.ts's own
 * `estimateCostUsdMicros` comment. Verify against
 * https://openai.com/api/pricing/ before trusting this for real
 * budget alerts; provider pricing changes outside this project's
 * control and this table is not automatically kept in sync.
 */
const MODEL_PRICING_USD_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  // Version 5.0 Milestone 2 (Knowledge Base) — an embedding model has
  // no "output tokens" concept; output: 0 is correct, not a
  // placeholder, and keeps estimateCostUsdMicros() uniform across
  // completion and embedding models without a second pricing table.
  'text-embedding-3-small': { input: 0.02, output: 0 },
};

interface OpenAiChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string };
}

interface OpenAiEmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[];
  usage?: { prompt_tokens?: number };
  model?: string;
  error?: { message?: string };
}

export const openAiProvider: AiProvider = {
  name: 'openai',

  supportsModel(model: string): boolean {
    return model in MODEL_PRICING_USD_PER_MILLION_TOKENS;
  },

  async complete(request: CompletionRequest, env: Env): Promise<CompletionResult> {
    const messages: { role: 'system' | 'user'; content: string }[] = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.userPrompt });

    let response: Response;
    try {
      response = await fetch(`${env.OPENAI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          messages,
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: request.temperature ?? 0.7,
        }),
      });
    } catch (err) {
      throw new Error(`OpenAI request failed: ${err instanceof Error ? err.message : 'unknown network error'}`);
    }

    const body = (await response.json().catch(() => null)) as OpenAiChatCompletionResponse | null;

    if (!response.ok) {
      throw new Error(`OpenAI API error (${response.status}): ${body?.error?.message ?? 'unknown error'}`);
    }
    if (!body) {
      throw new Error('OpenAI response could not be parsed as JSON.');
    }

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('OpenAI response contained no completion content.');
    }

    return {
      content,
      model: body.model ?? request.model,
      tokensIn: body.usage?.prompt_tokens ?? 0,
      tokensOut: body.usage?.completion_tokens ?? 0,
    };
  },

  async embed(request: EmbeddingRequest, env: Env): Promise<EmbeddingResult> {
    let response: Response;
    try {
      response = await fetch(`${env.OPENAI_BASE_URL}/v1/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: request.model, input: request.texts }),
      });
    } catch (err) {
      throw new Error(`OpenAI embeddings request failed: ${err instanceof Error ? err.message : 'unknown network error'}`);
    }

    const body = (await response.json().catch(() => null)) as OpenAiEmbeddingResponse | null;

    if (!response.ok) {
      throw new Error(`OpenAI API error (${response.status}): ${body?.error?.message ?? 'unknown error'}`);
    }
    if (!body) {
      throw new Error('OpenAI response could not be parsed as JSON.');
    }
    if (!Array.isArray(body.data) || body.data.length !== request.texts.length) {
      throw new Error(`OpenAI embeddings response returned ${body.data?.length ?? 0} vectors for ${request.texts.length} input texts.`);
    }

    // The API documents `data` as returned in input order via each
    // entry's own `index`, but does not guarantee array order matches
    // — sort explicitly rather than trusting array position, since a
    // silently-mismatched embedding/text pairing would corrupt every
    // downstream Vectorize upsert without ever throwing.
    const sorted = [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const embeddings = sorted.map((entry, i) => {
      if (!Array.isArray(entry.embedding)) throw new Error(`OpenAI embeddings response is missing a vector at index ${i}.`);
      return entry.embedding;
    });

    return {
      embeddings,
      model: body.model ?? request.model,
      tokensIn: body.usage?.prompt_tokens ?? 0,
    };
  },

  estimateCostUsdMicros(tokensIn: number, tokensOut: number, model: string): number {
    const pricing = MODEL_PRICING_USD_PER_MILLION_TOKENS[model];
    if (!pricing) return 0; // Unknown model — supportsModel() should have already rejected this upstream; returning 0 rather than throwing keeps cost estimation a non-fatal, best-effort concern.
    const inputCostUsd = (tokensIn / 1_000_000) * pricing.input;
    const outputCostUsd = (tokensOut / 1_000_000) * pricing.output;
    return Math.round((inputCostUsd + outputCostUsd) * 1_000_000);
  },
};
