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

  if (isFirstSubscribe) {
    const template: EmailTemplateName = isFreeGuideSource(input.source)
      ? 'free-guide-delivery'
      : 'newsletter-welcome';

    await sendEmail(env, logger, {
      template,
      to: input.email,
      data: {},
      entityType: 'newsletter_subscriber',
      entityId: subscriberId,
    });
  }

  return { status: 'subscribed' };
}
