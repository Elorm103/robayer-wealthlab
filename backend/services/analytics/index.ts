/**
 * Registers every AnalyticsProvider this project has an adapter for,
 * and returns only the ones actually configured in this environment —
 * see ./types.ts's header comment for why this is a fan-out registry,
 * not a single-provider selector like services/payments/index.ts's
 * getPaymentProvider(). Adding a second provider (Google, TikTok,
 * etc.) means one more file in this folder and one more entry in
 * `PROVIDERS` below, not touching conversionDispatchService.ts or any
 * call site.
 */

import type { Env } from '../../worker/env';
import type { AnalyticsProvider } from './types';
import { metaProvider } from './metaProvider';

export type {
  AnalyticsProvider,
  ConversionEventName,
  ServerEventInput,
  ServerEventResult,
} from './types';

const PROVIDERS: AnalyticsProvider[] = [metaProvider];

export function getAnalyticsProviders(env: Env): AnalyticsProvider[] {
  return PROVIDERS.filter((provider) => provider.isConfigured(env));
}
