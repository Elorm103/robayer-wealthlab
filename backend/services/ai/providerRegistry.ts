/**
 * Provider Registry — Version 5.0 Milestone 1. The one place this
 * project knows which `AiProvider` implementations exist, mirroring
 * services/payments/index.ts's `getPaymentProvider()` selector
 * exactly. Unlike Payments (one active provider, chosen by an env var),
 * the AI Gateway can route different features to different providers
 * simultaneously (see ./routingConfig.ts) — so this registry exposes
 * every known provider by name, and the Gateway looks one up per
 * routing-table entry rather than selecting a single global provider.
 *
 * Adding a second provider (Anthropic, etc.): implement `AiProvider`
 * in a new file under `./providers/`, add one line to `PROVIDERS`
 * below, then reference its name in ./routingConfig.ts. Nothing in
 * ./aiGateway.ts or any calling feature ever changes.
 */

import type { AiProvider } from './types';
import { openAiProvider } from './providers/openAiProvider';

const PROVIDERS: Record<string, AiProvider> = {
  openai: openAiProvider,
};

export function getAiProvider(name: string): AiProvider {
  const provider = PROVIDERS[name];
  if (!provider) {
    // A routing-table entry naming an unregistered provider is a
    // deployment/configuration error, not a request-time one — thrown
    // here rather than returned as an API error code, same convention
    // as getPaymentProvider()'s own unknown-provider case.
    throw new Error(`Unknown AI provider: "${name}"`);
  }
  return provider;
}
