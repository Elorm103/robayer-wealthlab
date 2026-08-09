/**
 * Meta implementation of AnalyticsProvider (./types.ts) — Version 5.0
 * (Customer Acquisition Phase 1, Phase 7 Conversions API).
 *
 * `sendServerEvent()` calls Meta's own Graph API Conversions API
 * endpoint (`POST /{pixel-id}/events`) — see
 * https://developers.facebook.com/docs/marketing-api/conversions-api.
 * Mirrors `services/payments/paystackProvider.ts`'s own shape: a thin,
 * faithful wrapper around the provider's real HTTP API, throwing only
 * on a genuine network-level failure (never on a business-level
 * rejection, which is reported back via `ServerEventResult.ok`) —
 * `conversionDispatchService.ts` (the only caller) decides how to log
 * and retry, same division of responsibility Paystack's provider
 * already established for payment verification.
 */

import type { Env } from '../../worker/env';
import type { AnalyticsProvider, ServerEventInput, ServerEventResult } from './types';

interface MetaEventsResponse {
  events_received?: number;
  fbtrace_id?: string;
  error?: { message?: string; type?: string; code?: number };
}

export const metaProvider: AnalyticsProvider = {
  name: 'meta',

  isConfigured(env: Env): boolean {
    return Boolean(env.META_PIXEL_ID && env.META_CAPI_ACCESS_TOKEN);
  },

  async sendServerEvent(input: ServerEventInput, env: Env): Promise<ServerEventResult> {
    const payload: Record<string, unknown> = {
      data: [
        {
          event_name: input.eventName,
          event_time: Math.floor(Date.now() / 1000),
          event_id: input.eventId,
          event_source_url: input.eventSourceUrl,
          action_source: 'website',
          // Meta requires each identifier as an array, even a single
          // value — its own documented `user_data` shape. Omitted
          // entirely (not sent as an empty array) when there's no
          // hash available, since Meta treats a present-but-empty `em`
          // array as a malformed identifier, not "no identifier."
          user_data: input.userData.emailHash ? { em: [input.userData.emailHash] } : {},
          custom_data: input.customData,
        },
      ],
      access_token: env.META_CAPI_ACCESS_TOKEN,
    };

    // Non-secret, optional — set only while verifying in Meta's Test
    // Events tool (Phase 12). Absent in real production traffic; see
    // docs/v5.0-analytics-architecture.md's own "Configuration" note.
    if (env.META_TEST_EVENT_CODE) {
      payload.test_event_code = env.META_TEST_EVENT_CODE;
    }

    const url = `${env.META_GRAPH_API_BASE_URL}/${env.META_GRAPH_API_VERSION}/${env.META_PIXEL_ID}/events`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new Error(`Meta Conversions API request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const bodyText = await response.text();
    let parsed: MetaEventsResponse | null = null;
    try {
      parsed = JSON.parse(bodyText) as MetaEventsResponse;
    } catch {
      // Non-JSON body — genuinely unusual for this API, but the raw
      // text is still recorded by the caller for troubleshooting; not
      // itself a reason to throw.
    }

    return {
      ok: response.ok && !parsed?.error,
      status: response.status,
      body: bodyText,
      traceId: parsed?.fbtrace_id,
    };
  },
};
