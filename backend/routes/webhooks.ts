/**
 * POST /api/webhooks/paystack — see docs/payment-verification.md.
 * Thin HTTP layer only: verifies the signature, parses/validates the
 * webhook's own envelope shape, calls services/commerceService.ts for
 * all business logic. No D1 write or payment-provider call happens
 * directly in this file — see backend/routes/README.md's "routes stay
 * thin" rule.
 *
 * Response semantics are deliberately different from every other route
 * in this Worker: once the request is verified (real signature) and
 * well-formed (parses, has the fields this handler needs), this route
 * **always** returns 200 — regardless of what commerceService.ts's
 * business logic decided (verified / already processed / expired /
 * rejected). This is standard webhook-handling practice, not specific
 * to this codebase: retrying a webhook whose outcome will never change
 * just produces a permanent stream of retries from Paystack for
 * nothing. A non-200 is reserved for cases where retrying genuinely
 * might help — an invalid signature (not really from Paystack, or a
 * misconfigured secret) or a malformed payload this handler couldn't
 * even parse.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { jsonError, jsonSuccess } from '../utils/responses';
import { verifyPaystackSignature } from '../utils/webhookSignature';
import { handlePaymentWebhook } from '../services/commerceService';

const SIGNATURE_HEADER = 'x-paystack-signature';

interface PaystackWebhookPayload {
  event?: unknown;
  data?: {
    reference?: unknown;
    amount?: unknown;
    currency?: unknown;
  };
}

export async function handlePaystackWebhook(request: Request, env: Env, logger: Logger): Promise<Response> {
  // Read the raw body FIRST, before any JSON parsing — the signature
  // covers the exact bytes Paystack sent; parsing and re-serializing
  // can change whitespace/key order, which would change the hash and
  // cause every signature check to fail. See
  // docs/payment-verification.md's "Webhook security."
  const rawBody = await request.text();
  const signature = request.headers.get(SIGNATURE_HEADER);

  // Paystack signs webhooks with the account's own secret key, not a
  // separate webhook-specific secret (unlike some other providers) —
  // see docs/payment-verification.md's "Known limitations" for the
  // confidence caveat on this (unverified against a live account).
  const isValidSignature = await verifyPaystackSignature(rawBody, signature, env.PAYSTACK_SECRET_KEY);
  if (!isValidSignature) {
    logger.warn('webhook.invalid_signature');
    return jsonError('INVALID_SIGNATURE', 'Invalid signature.');
  }

  let payload: PaystackWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    logger.warn('webhook.malformed_payload');
    return jsonError('VALIDATION_ERROR', 'Malformed webhook payload.');
  }

  const event = payload.event;
  const reference = payload.data?.reference;
  const amount = payload.data?.amount;
  const currency = payload.data?.currency;

  if (typeof event !== 'string' || typeof reference !== 'string' || typeof amount !== 'number' || typeof currency !== 'string') {
    logger.warn('webhook.malformed_payload', { event: typeof event === 'string' ? event : undefined });
    return jsonError('VALIDATION_ERROR', 'Malformed webhook payload.');
  }

  // From here on, always 200 — see this file's own header comment.
  await handlePaymentWebhook(env, logger, {
    event,
    providerReference: reference,
    amountPesewas: amount,
    currency,
    rawPayload: rawBody,
  });

  return jsonSuccess({ received: true });
}
