/**
 * Sends transactional email via Resend's HTTP API — see
 * docs/email-architecture.md. Templates are bundled as plain strings
 * at build time (wrangler.toml's `[[rules]] type = "Text"`, since
 * Workers have no runtime filesystem to read backend/emails/*.html
 * from) and rendered by simple {{placeholder}} substitution — no
 * templating engine dependency.
 *
 * Sending must never block or fail the action that triggered it
 * (docs/email-architecture.md's "Retry strategy"): one immediate retry
 * on a transient failure, then the attempt is recorded to `email_log`
 * either way (sent or failed) and this function returns normally —
 * it never throws back into the calling route/service.
 *
 * The scheduled Cron Trigger that later retries rows still `failed`
 * in `email_log` is NOT implemented in this sprint — Version 1.2
 * Sprint 3's explicit scope is "integrate Resend for acknowledgement
 * and welcome emails" and "structured logging," not a scheduled retry
 * consumer. Failed attempts are safely recorded either way, so no data
 * is lost; building the consumer is future work.
 */

import baseLayout from '../emails/layouts/base.html';
import newsletterWelcomeTemplate from '../emails/templates/newsletter-welcome.html';
import freeGuideDeliveryTemplate from '../emails/templates/free-guide-delivery.html';
import consultationAcknowledgementTemplate from '../emails/templates/consultation-acknowledgement.html';
import contactAcknowledgementTemplate from '../emails/templates/contact-acknowledgement.html';
import purchaseReceiptTemplate from '../emails/templates/purchase-receipt.html';
import secureDownloadTemplate from '../emails/templates/secure-download.html';
import passwordResetTemplate from '../emails/templates/password-reset.html';
import adminInviteTemplate from '../emails/templates/admin-invite.html';
import newsletterCampaignTemplate from '../emails/templates/newsletter-campaign.html';
import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { getEmailSendSettings } from './admin/settingsService';

export type EmailTemplateName =
  | 'newsletter-welcome'
  | 'free-guide-delivery'
  | 'consultation-acknowledgement'
  | 'contact-acknowledgement'
  | 'purchase-receipt'
  | 'secure-download'
  | 'password-reset'
  | 'admin-invite'
  | 'newsletter-campaign';

const TEMPLATES: Record<EmailTemplateName, string> = {
  'newsletter-welcome': newsletterWelcomeTemplate,
  'free-guide-delivery': freeGuideDeliveryTemplate,
  'consultation-acknowledgement': consultationAcknowledgementTemplate,
  'contact-acknowledgement': contactAcknowledgementTemplate,
  'purchase-receipt': purchaseReceiptTemplate,
  'secure-download': secureDownloadTemplate,
  'password-reset': passwordResetTemplate,
  'admin-invite': adminInviteTemplate,
  'newsletter-campaign': newsletterCampaignTemplate,
};

export interface SendEmailOptions {
  template: EmailTemplateName;
  to: string;
  /** Placeholder values substituted into the template — escaped before insertion, since these often contain free-text user input (see docs/backend-security.md's "escape on output"). */
  data: Record<string, string>;
  /** Ties this attempt back to the row that triggered it, mirroring audit_logs' generic entity_type/entity_id pattern (docs/database-design.md). */
  entityType: string;
  entityId: number;
  /**
   * Set only for the newsletter-family templates that carry a real
   * unsubscribe link (docs/newsletter-unsubscribe-design.md) — adds
   * `List-Unsubscribe` + `List-Unsubscribe-Post` headers so mail
   * clients that support RFC 8058 (Gmail, Yahoo, others) can offer
   * their own native one-click "Unsubscribe" button, which POSTs
   * directly to this same URL rather than opening the visible footer
   * link. Never set for transactional templates (purchase-receipt,
   * secure-download, consultation/contact acknowledgements) — those
   * aren't a recurring list a person "unsubscribes" from.
   */
  listUnsubscribeUrl?: string;
  /**
   * Version 2.1 Phase 6 (Newsletter Campaigns) — the campaign body is
   * admin-authored rich HTML, already passed through
   * `sanitizeRichTextHtml()` before it ever reaches this function, and
   * must be inserted as HTML, not escaped into visible tag text like
   * every other (plain-string) placeholder. Set only by the campaign
   * send path; every other template ignores this entirely.
   */
  rawBody?: string;
  /**
   * Version 2.1 Phase 6 — a campaign's Subject: header is
   * admin-authored, per-campaign text. The normal `{{SUBJECT}}` meta
   * mechanism always HTML-escapes its value (correct for text
   * rendered inside the HTML body, wrong for an RFC822 header, which
   * is plain text) — so the campaign path supplies the real subject
   * here instead, bypassing that escaping entirely. Ignored by every
   * other template, which keeps using its own bundled SUBJECT comment.
   */
  subjectOverride?: string;
}

export interface SendEmailResult {
  sent: boolean;
  permanentFailure: boolean;
  errorMessage?: string;
  /**
   * Version 2.1 Phase 6 (Newsletter Campaigns) — the exact status this
   * attempt was recorded under in `email_log`, and that row's id (or
   * `null` if the log write itself failed, which never blocks the
   * caller — see `recordEmailLog`'s own comment). `campaignService.ts`
   * needs both: the id to link `newsletter_campaign_recipients.email_log_id`,
   * and the precise status to distinguish a real send failure from the
   * per-template kill switch skipping the attempt entirely — `sent`/
   * `permanentFailure` alone can't tell those two apart. Every
   * pre-Phase-6 caller ignores these two fields, unaffected.
   */
  status: 'sent' | 'failed' | 'permanently_failed' | 'skipped';
  emailLogId: number | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function substitute(template: string, data: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = data[key];
    return value === undefined ? '' : escapeHtml(value);
  });
}

function extractMeta(template: string, name: string): string {
  const match = template.match(new RegExp(`<!--\\s*${name}:\\s*(.*?)\\s*-->`));
  return match ? match[1] : '';
}

function extractFooterExtra(template: string): string {
  const match = template.match(/<!-- FOOTER_EXTRA_START -->([\s\S]*?)<!-- FOOTER_EXTRA_END -->/);
  return match ? match[1].trim() : '';
}

function bodyWithoutMeta(template: string): string {
  return template
    .replace(/<!-- FOOTER_EXTRA_START -->[\s\S]*?<!-- FOOTER_EXTRA_END -->/, '')
    .replace(/<!--\s*(SUBJECT|PREHEADER):.*?-->/g, '')
    .trim();
}

function renderTemplate(
  templateName: EmailTemplateName,
  data: Record<string, string>,
  rawBody?: string,
  subjectOverride?: string
): { subject: string; html: string } {
  const raw = TEMPLATES[templateName];

  const subject = subjectOverride ?? substitute(extractMeta(raw, 'SUBJECT'), data);
  const preheader = substitute(extractMeta(raw, 'PREHEADER'), data);
  const footerExtra = substitute(extractFooterExtra(raw), data);
  // `%%BODY_CONTENT_RAW%%` — deliberately not `{{...}}` syntax, since
  // `substitute()`'s regex below would otherwise match and consume
  // the inner `{{BODY_CONTENT_RAW}}` of a naively-chosen
  // `{{{BODY_CONTENT_RAW}}}` token first (found during implementation,
  // before it could ship as a real bug), escaping/blanking it before
  // this raw substitution ever ran. This token is inserted verbatim,
  // never HTML-escaped — see SendEmailOptions.rawBody's comment for why.
  const bodyContent = substitute(bodyWithoutMeta(raw), data).replace(/%%BODY_CONTENT_RAW%%/g, rawBody ?? '');

  const html = baseLayout
    .replace(/\{\{SUBJECT\}\}/g, subject)
    .replace(/\{\{PREHEADER\}\}/g, preheader)
    .replace(/\{\{BODY_CONTENT\}\}/g, bodyContent)
    .replace(/\{\{FOOTER_EXTRA\}\}/g, footerExtra);

  return { subject, html };
}

async function callResend(
  env: Env,
  to: string,
  subject: string,
  html: string,
  senderName: string,
  replyTo: string | null,
  listUnsubscribeUrl?: string
): Promise<{ ok: boolean; status: number; body: string }> {
  const payload: Record<string, unknown> = {
    // Only the display name is settings-driven (Version 2.1 Phase 5) —
    // the sending address itself stays the real, domain-verified
    // hello@robayerwealthlab.com; changing that would mean re-verifying
    // a different address/domain with Resend, well beyond this phase's
    // "operational configuration only" scope.
    from: `${senderName} <hello@robayerwealthlab.com>`,
    to: [to],
    subject,
    html,
  };

  // Resend's send API accepts a `headers` map for custom email headers
  // (verify against the current Resend API reference before relying on
  // this in production — not independently confirmed against a live
  // Resend account in this change, see docs/newsletter-unsubscribe-design.md's
  // "Known limitations"). `List-Unsubscribe-Post` is what makes Gmail/Yahoo's
  // native one-click button actually one-click (RFC 8058) rather than
  // just linking to our own confirmation page.
  if (listUnsubscribeUrl) {
    payload.headers = {
      'List-Unsubscribe': `<${listUnsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }

  // `reply_to` — Resend's documented field name for a reply-to
  // address; same "not independently confirmed against a live Resend
  // account" caveat as List-Unsubscribe above. Version 2.1 Phase 5.
  if (replyTo) {
    payload.reply_to = replyTo;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
}

function parseProviderId(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { id?: string };
    return parsed.id;
  } catch {
    return undefined;
  }
}

interface EmailLogDetails {
  status: 'sent' | 'failed' | 'permanently_failed' | 'skipped';
  attemptCount: number;
  providerId?: string;
  lastError?: string;
}

async function recordEmailLog(
  env: Env,
  logger: Logger,
  options: SendEmailOptions,
  details: EmailLogDetails
): Promise<number | null> {
  try {
    const result = await env.DB.prepare(
      `INSERT INTO email_log (template, recipient, entity_type, entity_id, status, attempt_count, last_error, provider_id, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        options.template,
        options.to,
        options.entityType,
        options.entityId,
        details.status,
        details.attemptCount,
        details.lastError ? details.lastError.slice(0, 2000) : null,
        details.providerId ?? null,
        details.status === 'sent' ? new Date().toISOString() : null
      )
      .run();
    return Number(result.meta.last_row_id);
  } catch (err) {
    // A failure to log a failure must never throw back into the caller —
    // the business action (newsletter/contact/consultation) has already
    // succeeded and must not be affected by this.
    logger.error('Failed to write email_log row', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function sendEmail(
  env: Env,
  logger: Logger,
  options: SendEmailOptions
): Promise<SendEmailResult> {
  // Version 2.1 Phase 5 (Settings) — a per-template kill switch,
  // checked before anything else (before even rendering the
  // template): every one of this function's 8 existing callers
  // (newsletter, consultation, contact, purchase receipt, secure
  // download, password reset, admin invite) is covered automatically,
  // with zero changes to any of those call sites. Defaults to enabled
  // for every template when `site_settings` has never been touched —
  // see settingsService.ts's DEFAULTS.
  const sendSettings = await getEmailSendSettings(env);
  if (sendSettings.templateEnabled[options.template] === false) {
    logger.info('Email skipped (template disabled)', { template: options.template, to: options.to });
    const emailLogId = await recordEmailLog(env, logger, options, { status: 'skipped', attemptCount: 0 });
    return { sent: false, permanentFailure: false, status: 'skipped', emailLogId };
  }

  const { subject, html } = renderTemplate(options.template, options.data, options.rawBody, options.subjectOverride);

  let attempt = 0;
  let lastStatus = 0;
  let lastError = '';

  while (attempt < 2) {
    attempt += 1;
    try {
      const result = await callResend(env, options.to, subject, html, sendSettings.senderName, sendSettings.replyTo, options.listUnsubscribeUrl);

      if (result.ok) {
        const providerId = parseProviderId(result.body);
        logger.info('Email sent', { template: options.template, to: options.to, attempt });
        const emailLogId = await recordEmailLog(env, logger, options, { status: 'sent', attemptCount: attempt, providerId });
        return { sent: true, permanentFailure: false, status: 'sent', emailLogId };
      }

      lastStatus = result.status;
      lastError = result.body;

      // A 4xx (other than 429, which is Resend's own rate limit and
      // worth one retry) means Resend itself rejected the request —
      // e.g. an invalid recipient address — and won't succeed on retry.
      if (result.status >= 400 && result.status < 500 && result.status !== 429) {
        break;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  logger.error('Email send failed', {
    template: options.template,
    to: options.to,
    attempts: attempt,
    lastStatus,
    lastError,
  });

  const permanentFailure = lastStatus >= 400 && lastStatus < 500 && lastStatus !== 429;
  const failureStatus = permanentFailure ? 'permanently_failed' : 'failed';

  const emailLogId = await recordEmailLog(env, logger, options, {
    status: failureStatus,
    attemptCount: attempt,
    lastError,
  });

  return { sent: false, permanentFailure, errorMessage: lastError, status: failureStatus, emailLogId };
}
