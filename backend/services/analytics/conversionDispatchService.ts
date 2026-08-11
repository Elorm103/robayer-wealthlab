/**
 * Conversion Dispatch Service — Version 5.0 (Customer Acquisition
 * Phase 1). The ONE call site every server-side conversion event
 * flows through, fanning out to every configured AnalyticsProvider
 * (./index.ts) — see docs/v5.0-analytics-architecture.md §3: "One
 * dispatch service, not five." Mirrors services/emailService.ts's own
 * sendEmail() shape deliberately: one immediate retry on a transient
 * failure, the attempt always recorded (to analytics_conversion_log,
 * email_log's own sibling table) whether it succeeds or fails, and
 * this never throws back into the caller — a conversion-tracking
 * failure must never affect the real business action (a payment) that
 * already succeeded, the exact same discipline
 * services/fulfilmentService.ts already applies to email delivery.
 *
 * `dispatchPurchase()` is the one concrete wrapper this phase needs
 * (Phase 7 scopes server-side/CAPI dispatch to Purchase specifically —
 * every other event in Phases 2-6 is browser-pixel-only, matching
 * js/components/analytics.js's own existing first-party-beacon
 * architecture). A future server-side event (e.g. a subscription
 * renewal) calls the generic `dispatchServerEvent()` directly with no
 * change needed here.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { getAnalyticsProviders } from './index';
import { hashEmail, hashExternalId } from './hashing';
import type { ConversionEventName, ServerEventInput } from './types';

const RETRY_MAX_ATTEMPTS = 2; // matches emailService.ts's own inline retry budget
const CRON_RETRY_MAX_ATTEMPTS = 5; // total attempts (inline + cron sweeps) before a row is given up on as permanently_failed

export interface DispatchServerEventInput {
  eventName: ConversionEventName;
  eventId: string;
  eventSourceUrl: string;
  /** Raw email — hashed exactly once, here, before any provider or log row ever sees it. Never persisted in raw form. */
  customerEmail: string | null;
  /** Event Match Quality — this project's own numeric customer id, hashed exactly once, here, same discipline as customerEmail above. Absent for an event with no provisioned customer yet (e.g. a guest-checkout edge case). */
  customerId?: number | null;
  /** Event Match Quality — all four read from a real, direct customer request (see migration 0041's header comment); never hashed (Meta's own documented spec), never fabricated when absent. */
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  fbc?: string | null;
  fbp?: string | null;
  customData: ServerEventInput['customData'];
  entityType: string;
  entityId: number;
}

interface ConversionLogDetails {
  status: 'sent' | 'failed' | 'permanently_failed' | 'skipped';
  attemptCount: number;
  providerTraceId?: string;
  lastError?: string;
}

async function insertConversionLog(
  env: Env,
  logger: Logger,
  provider: string,
  input: DispatchServerEventInput,
  requestPayload: string,
  details: ConversionLogDetails
): Promise<number | null> {
  try {
    const result = await env.DB.prepare(
      `INSERT INTO analytics_conversion_log
         (provider, event_name, event_id, entity_type, entity_id, status, attempt_count, last_error, provider_trace_id, request_payload, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        provider,
        input.eventName,
        input.eventId,
        input.entityType,
        input.entityId,
        details.status,
        details.attemptCount,
        details.lastError ? details.lastError.slice(0, 2000) : null,
        details.providerTraceId ?? null,
        requestPayload,
        details.status === 'sent' ? new Date().toISOString() : null
      )
      .run();
    return Number(result.meta.last_row_id);
  } catch (err) {
    // Same "a failure to log a failure must never throw back into the
    // caller" discipline emailService.ts's recordEmailLog() already
    // applies — the real conversion attempt has already happened.
    logger.error('analytics.dispatch_log_write_failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** 4xx (other than 429, the provider's own rate limit) means the provider rejected the request outright — retrying won't help, matches emailService.ts's identical classification for Resend. */
function isPermanentFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429;
}

/**
 * Fans out one logical conversion event to every configured provider,
 * independently. A provider that isn't configured (e.g. no Meta
 * access token set yet) is silently skipped and logged as such —
 * never an error, matching services/payments/'s "misconfiguration is
 * a deployment concern, not a request-time failure" stance, except
 * here a provider genuinely being absent is an expected, ordinary
 * state (not every environment runs every ad platform).
 */
export async function dispatchServerEvent(env: Env, logger: Logger, input: DispatchServerEventInput): Promise<void> {
  const [emailHash, externalIdHash] = await Promise.all([hashEmail(input.customerEmail), hashExternalId(input.customerId ?? null)]);
  const eventInput: ServerEventInput = {
    eventName: input.eventName,
    eventId: input.eventId,
    eventSourceUrl: input.eventSourceUrl,
    userData: {
      emailHash,
      externalIdHash,
      clientIpAddress: input.clientIpAddress ?? null,
      clientUserAgent: input.clientUserAgent ?? null,
      fbc: input.fbc ?? null,
      fbp: input.fbp ?? null,
    },
    customData: input.customData,
  };
  const requestPayload = JSON.stringify(eventInput);

  const providers = getAnalyticsProviders(env);
  if (providers.length === 0) {
    logger.info('analytics.dispatch_skipped_no_providers', { eventName: input.eventName, eventId: input.eventId });
    return;
  }

  await Promise.all(
    providers.map(async (provider) => {
      let attempt = 0;
      let lastStatus = 0;
      let lastError = '';
      let lastTraceId: string | undefined;

      while (attempt < RETRY_MAX_ATTEMPTS) {
        attempt += 1;
        try {
          const result = await provider.sendServerEvent(eventInput, env);
          lastTraceId = result.traceId;

          if (result.ok) {
            logger.info('analytics.dispatch_sent', { provider: provider.name, eventName: input.eventName, eventId: input.eventId, attempt });
            await insertConversionLog(env, logger, provider.name, input, requestPayload, {
              status: 'sent',
              attemptCount: attempt,
              providerTraceId: lastTraceId,
            });
            return;
          }

          lastStatus = result.status;
          lastError = result.body;
          if (isPermanentFailure(result.status)) break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      logger.error('analytics.dispatch_failed', {
        provider: provider.name,
        eventName: input.eventName,
        eventId: input.eventId,
        attempts: attempt,
        lastStatus,
        lastError,
      });

      const permanentFailure = isPermanentFailure(lastStatus);
      await insertConversionLog(env, logger, provider.name, input, requestPayload, {
        status: permanentFailure ? 'permanently_failed' : 'failed',
        attemptCount: attempt,
        providerTraceId: lastTraceId,
        lastError,
      });
    })
  );
}

export interface DispatchPurchaseInput {
  purchaseSessionId: number;
  purchaseReference: string;
  eventSourceUrl: string;
  customerEmail: string | null;
  amountPesewas: number;
  currency: string;
  productTitle: string;
  productId: string;
  productSlug: string;
  couponCode: string | null;
  /** Event Match Quality — see DispatchServerEventInput's own doc comments; all optional, all sourced from a real customer request, never fabricated. */
  customerId?: number | null;
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  fbc?: string | null;
  fbp?: string | null;
}

/**
 * The one concrete server-side event this phase fires — called from
 * services/commerceService.ts's completeVerifiedPurchase(), the
 * single place a purchase is known to have genuinely succeeded (see
 * that function's own header comment). `eventId` is deterministic
 * (`purchase:{purchaseReference}`) and must match whatever the browser
 * pixel used for the same purchase (js/components/meta-pixel.js /
 * fulfilment-status.js) — see migration 0040's header comment on why
 * this is Meta's real deduplication mechanism, not a bespoke one.
 */
export async function dispatchPurchase(env: Env, logger: Logger, input: DispatchPurchaseInput): Promise<void> {
  await dispatchServerEvent(env, logger, {
    eventName: 'Purchase',
    eventId: `purchase:${input.purchaseReference}`,
    eventSourceUrl: input.eventSourceUrl,
    customerEmail: input.customerEmail,
    customerId: input.customerId,
    clientIpAddress: input.clientIpAddress,
    clientUserAgent: input.clientUserAgent,
    fbc: input.fbc,
    fbp: input.fbp,
    entityType: 'purchase_session',
    entityId: input.purchaseSessionId,
    customData: {
      value: (input.amountPesewas / 100).toFixed(2),
      currency: input.currency,
      content_name: input.productTitle,
      content_ids: [input.productSlug],
      content_type: 'product',
      transaction_id: input.purchaseReference,
      product_id: input.productId,
      ...(input.couponCode ? { coupon: input.couponCode } : {}),
    },
  });
}

/**
 * Scheduled second chance for a row that exhausted dispatchServerEvent()'s
 * own inline retry budget — reuses the existing single daily Cron
 * Trigger (worker/index.ts's scheduled()), the same pattern
 * services/customer/reviewReminderService.ts and
 * purchaseFollowupService.ts already established, rather than
 * provisioning a new Cloudflare Queue purely for this (Meta CAPI
 * volume at this project's real scale doesn't justify one — see
 * wrangler.jsonc's own reasoning for when a Queue *was* justified,
 * Knowledge Base indexing's per-invocation subrequest budget, which
 * doesn't apply here at all).
 *
 * A row past CRON_RETRY_MAX_ATTEMPTS total attempts is given up on
 * (marked permanently_failed) rather than retried forever — visible on
 * the admin dashboard's "Failed events" panel either way.
 */
export async function retryFailedConversions(env: Env, logger: Logger): Promise<{ eligible: number; retried: number; nowSent: number }> {
  const { results } = await env.DB.prepare(
    `SELECT id, provider, event_name, event_id, entity_type, entity_id, attempt_count, request_payload
     FROM analytics_conversion_log WHERE status = 'failed' ORDER BY created_at ASC LIMIT 20`
  ).all<{
    id: number;
    provider: string;
    event_name: string;
    event_id: string;
    entity_type: string;
    entity_id: number;
    attempt_count: number;
    request_payload: string;
  }>();

  let retried = 0;
  let nowSent = 0;

  for (const row of results) {
    retried += 1;

    if (row.attempt_count >= CRON_RETRY_MAX_ATTEMPTS) {
      await env.DB.prepare(`UPDATE analytics_conversion_log SET status = 'permanently_failed', updated_at = datetime('now') WHERE id = ?`)
        .bind(row.id)
        .run();
      continue;
    }

    let eventInput: ServerEventInput;
    try {
      eventInput = JSON.parse(row.request_payload) as ServerEventInput;
    } catch {
      logger.error('analytics.retry_payload_unparsable', { id: row.id, provider: row.provider });
      continue;
    }

    const provider = getAnalyticsProviders(env).find((p) => p.name === row.provider);
    if (!provider) {
      // The provider was configured when this row was first logged but
      // isn't anymore (e.g. its access token was rotated out) — leave
      // the row as-is for the next sweep rather than guessing.
      continue;
    }

    const nextAttempt = row.attempt_count + 1;
    try {
      const result = await provider.sendServerEvent(eventInput, env);
      if (result.ok) {
        await env.DB.prepare(
          `UPDATE analytics_conversion_log SET status = 'sent', attempt_count = ?, provider_trace_id = ?, sent_at = datetime('now'), last_error = NULL, updated_at = datetime('now') WHERE id = ?`
        )
          .bind(nextAttempt, result.traceId ?? null, row.id)
          .run();
        nowSent += 1;
        logger.info('analytics.retry_sent', { id: row.id, provider: row.provider, eventId: row.event_id, attempt: nextAttempt });
        continue;
      }

      const status = isPermanentFailure(result.status) ? 'permanently_failed' : 'failed';
      await env.DB.prepare(
        `UPDATE analytics_conversion_log SET status = ?, attempt_count = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`
      )
        .bind(status, nextAttempt, result.body.slice(0, 2000), row.id)
        .run();
    } catch (err) {
      await env.DB.prepare(
        `UPDATE analytics_conversion_log SET attempt_count = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`
      )
        .bind(nextAttempt, (err instanceof Error ? err.message : String(err)).slice(0, 2000), row.id)
        .run();
    }
  }

  return { eligible: results.length, retried, nowSent };
}
