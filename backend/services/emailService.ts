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
import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';

export type EmailTemplateName =
  | 'newsletter-welcome'
  | 'free-guide-delivery'
  | 'consultation-acknowledgement'
  | 'contact-acknowledgement'
  | 'purchase-receipt'
  | 'secure-download';

const TEMPLATES: Record<EmailTemplateName, string> = {
  'newsletter-welcome': newsletterWelcomeTemplate,
  'free-guide-delivery': freeGuideDeliveryTemplate,
  'consultation-acknowledgement': consultationAcknowledgementTemplate,
  'contact-acknowledgement': contactAcknowledgementTemplate,
  'purchase-receipt': purchaseReceiptTemplate,
  'secure-download': secureDownloadTemplate,
};

export interface SendEmailOptions {
  template: EmailTemplateName;
  to: string;
  /** Placeholder values substituted into the template — escaped before insertion, since these often contain free-text user input (see docs/backend-security.md's "escape on output"). */
  data: Record<string, string>;
  /** Ties this attempt back to the row that triggered it, mirroring audit_logs' generic entity_type/entity_id pattern (docs/database-design.md). */
  entityType: string;
  entityId: number;
}

export interface SendEmailResult {
  sent: boolean;
  permanentFailure: boolean;
  errorMessage?: string;
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

function renderTemplate(templateName: EmailTemplateName, data: Record<string, string>): { subject: string; html: string } {
  const raw = TEMPLATES[templateName];

  const subject = substitute(extractMeta(raw, 'SUBJECT'), data);
  const preheader = substitute(extractMeta(raw, 'PREHEADER'), data);
  const footerExtra = substitute(extractFooterExtra(raw), data);
  const bodyContent = substitute(bodyWithoutMeta(raw), data);

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
  html: string
): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Robayer WealthLab <hello@robayerwealthlab.com>',
      to: [to],
      subject,
      html,
    }),
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
  status: 'sent' | 'failed' | 'permanently_failed';
  attemptCount: number;
  providerId?: string;
  lastError?: string;
}

async function recordEmailLog(
  env: Env,
  logger: Logger,
  options: SendEmailOptions,
  details: EmailLogDetails
): Promise<void> {
  try {
    await env.DB.prepare(
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
  } catch (err) {
    // A failure to log a failure must never throw back into the caller —
    // the business action (newsletter/contact/consultation) has already
    // succeeded and must not be affected by this.
    logger.error('Failed to write email_log row', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function sendEmail(
  env: Env,
  logger: Logger,
  options: SendEmailOptions
): Promise<SendEmailResult> {
  const { subject, html } = renderTemplate(options.template, options.data);

  let attempt = 0;
  let lastStatus = 0;
  let lastError = '';

  while (attempt < 2) {
    attempt += 1;
    try {
      const result = await callResend(env, options.to, subject, html);

      if (result.ok) {
        const providerId = parseProviderId(result.body);
        logger.info('Email sent', { template: options.template, to: options.to, attempt });
        await recordEmailLog(env, logger, options, { status: 'sent', attemptCount: attempt, providerId });
        return { sent: true, permanentFailure: false };
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

  await recordEmailLog(env, logger, options, {
    status: permanentFailure ? 'permanently_failed' : 'failed',
    attemptCount: attempt,
    lastError,
  });

  return { sent: false, permanentFailure, errorMessage: lastError };
}
