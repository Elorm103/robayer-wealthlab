/**
 * Records/updates a newsletter_subscribers row and sends the welcome
 * email on a genuinely first subscribe only — never on a re-subscribe
 * after an unsubscribe (docs/email-architecture.md's "Required
 * templates" #1) — re-sending a "welcome" email to someone who already
 * received it once would look like the site forgot they'd subscribed
 * before.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { sendEmail, type EmailTemplateName } from './emailService';
import { getOrCreateUnsubscribeToken } from './unsubscribeService';
import { getResourceBySlug } from './resourceService';

// The free guide's own `resources` row — see routes/free-guide.ts's
// header comment for why the guide is modeled as a resource (Media
// Library-managed, admin-editable) while keeping its own email-gated
// delivery, rather than the generic public download route.
const FREE_GUIDE_RESOURCE_SLUG = 'free-guide-7-money-mistakes';

// This Worker doesn't know its own public origin from an incoming
// request alone (no `request` is threaded this deep) — matches
// js/components/buy-button.js / fulfilment-status.js's own
// hardcoded-constant-with-an-update-comment convention for the same
// reason. `env.SITE_BASE_URL` already exists for the static site's
// own origin (Env, see worker/env.ts) — reused as-is, not duplicated.
const API_BASE_URL = 'https://robayer-wealthlab-api.robayerwealthlab.workers.dev';

/**
 * `source` is `window.location.pathname` from js/components/newsletter-form.js
 * (e.g. "/free-guide/"), not a bare slug — normalize before comparing so a
 * trailing/leading slash doesn't cause a silent mismatch.
 */
function isFreeGuideSource(source: string | null): boolean {
  return source !== null && source.replace(/^\/|\/$/g, '') === 'free-guide';
}

export interface SubscribeInput {
  email: string;
  source: string | null;
}

export interface SubscribeResult {
  status: 'subscribed';
}

interface ExistingSubscriber {
  id: number;
  status: string;
}

export async function subscribeToNewsletter(
  env: Env,
  logger: Logger,
  input: SubscribeInput
): Promise<SubscribeResult> {
  const existing = await env.DB.prepare(
    `SELECT id, status FROM newsletter_subscribers WHERE email = ?`
  )
    .bind(input.email)
    .first<ExistingSubscriber>();

  let subscriberId: number;
  let isFirstSubscribe = false;

  if (!existing) {
    const inserted = await env.DB.prepare(
      `INSERT INTO newsletter_subscribers (email, status, source, subscribed_at)
       VALUES (?, 'subscribed', ?, datetime('now'))`
    )
      .bind(input.email, input.source)
      .run();
    subscriberId = Number(inserted.meta.last_row_id);
    isFirstSubscribe = true;
  } else if (existing.status === 'unsubscribed') {
    await env.DB.prepare(
      `UPDATE newsletter_subscribers
       SET status = 'subscribed', subscribed_at = datetime('now'), unsubscribed_at = NULL, updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(existing.id)
      .run();
    subscriberId = existing.id;
  } else {
    // Already subscribed — idempotent, not an error (docs/worker-api-design.md).
    subscriberId = existing.id;
  }

  // A `/free-guide/` submission is a specific content request, not just a
  // subscribe-or-don't toggle — someone who's already subscribed but wants
  // the guide again (a real, now-confirmed case: an existing subscriber
  // testing/using the free-guide form and getting nothing) still needs it
  // resent. `newsletter-welcome` stays first-subscribe-only (resending a
  // "welcome to the club" email to someone already on the list would look
  // like the site forgot them), but `free-guide-delivery` re-sends on every
  // request from that source, since the visitor is explicitly asking for it
  // again, not being re-subscribed.
  const isFreeGuideRequest = isFreeGuideSource(input.source);
  if (isFirstSubscribe || isFreeGuideRequest) {
    const template: EmailTemplateName = isFreeGuideRequest
      ? 'free-guide-delivery'
      : 'newsletter-welcome';

    // Both newsletter-family templates carry a real unsubscribe link
    // (docs/newsletter-unsubscribe-design.md) — generated here, once,
    // rather than backfilled for every existing subscriber.
    const unsubscribeToken = await getOrCreateUnsubscribeToken(env, subscriberId);
    const unsubscribeUrl = `${env.SITE_BASE_URL}/newsletter/unsubscribe/?token=${unsubscribeToken}`;

    // Resolved live from the `resources` row on every send, not
    // hardcoded, so replacing the PDF in admin updates every future
    // delivery email automatically. Falls back to the last-known static
    // path only if the resource or its file is ever missing, so a
    // send never silently omits the download link.
    let downloadUrl = `${env.SITE_BASE_URL}/assets/downloads/7-money-mistakes-ghana.pdf`;
    if (isFreeGuideRequest) {
      const resource = await getResourceBySlug(env, FREE_GUIDE_RESOURCE_SLUG);
      if (resource?.filePublicUrl) {
        downloadUrl = `${env.SITE_BASE_URL}${resource.filePublicUrl}`;
      }
    }

    await sendEmail(env, logger, {
      template,
      to: input.email,
      data: { unsubscribeUrl, downloadUrl },
      entityType: 'newsletter_subscriber',
      entityId: subscriberId,
      listUnsubscribeUrl: `${API_BASE_URL}/api/newsletter/unsubscribe/${unsubscribeToken}`,
    });
  }

  return { status: 'subscribed' };
}
