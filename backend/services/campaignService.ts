/**
 * Newsletter Campaign Service — Version 2.1 Phase 6 (Newsletter
 * Campaigns). See docs/v2.1-phase6-design.md. The only code that
 * writes to `newsletter_campaigns`/`newsletter_campaign_recipients`.
 *
 * Sends reuse `emailService.sendEmail()` exactly — one recipient at a
 * time, the same retry-once/record-to-`email_log` behavior every
 * other template already has — run inside `ctx.waitUntil()` so the
 * admin's HTTP request returns immediately rather than blocking on
 * potentially hundreds of sequential Resend calls. This project has no
 * Cloudflare Queues/Cron/Durable Objects; the durable
 * `newsletter_campaign_recipients` roster (one row per intended
 * recipient, snapshotted once and never re-derived) is what makes
 * duplicate-send prevention and mid-send recovery possible without
 * any of that infrastructure — see the design doc's §4-§6.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { sanitizeRichTextHtml } from '../utils/richTextSanitizer';
import { sendEmail } from './emailService';
import { getOrCreateUnsubscribeToken } from './unsubscribeService';
import { getCampaignRecipientCap } from './admin/settingsService';
import * as auditService from './admin/auditService';

// Matches newsletterService.ts's own hardcoded-constant convention —
// this Worker doesn't know its own public origin from an incoming
// request alone.
const API_BASE_URL = 'https://robayer-wealthlab-api.robayerwealthlab.workers.dev';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECT_LENGTH = 200;

export type CampaignStatus = 'draft' | 'sending' | 'sent' | 'failed';

export interface CampaignInput {
  subject: string;
  body: string;
}

export interface CampaignValidationError {
  field: string;
  message: string;
}

export function validateCampaignInput(input: Partial<CampaignInput>): CampaignValidationError[] {
  const errors: CampaignValidationError[] = [];
  if (!input.subject || input.subject.trim().length === 0) {
    errors.push({ field: 'subject', message: 'Subject is required.' });
  } else if (input.subject.length > MAX_SUBJECT_LENGTH) {
    errors.push({ field: 'subject', message: `Subject must be ${MAX_SUBJECT_LENGTH} characters or fewer.` });
  }
  if (!input.body || input.body.trim().length === 0) {
    errors.push({ field: 'body', message: 'Body content is required.' });
  }
  return errors;
}

export interface DeliverySummary {
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface CampaignRecord {
  id: number;
  subject: string;
  body: string;
  status: CampaignStatus;
  intendedRecipientCount: number | null;
  testSentAt: string | null;
  createdBy: number;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  sentBy: number | null;
  sentByName: string | null;
  sendingStartedAt: string | null;
  sentAt: string | null;
  delivery: DeliverySummary;
}

interface CampaignRow {
  id: number;
  subject: string;
  body: string;
  status: CampaignStatus;
  intended_recipient_count: number | null;
  test_sent_at: string | null;
  created_by: number;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  sent_by: number | null;
  sent_by_name: string | null;
  sending_started_at: string | null;
  sent_at: string | null;
  deleted_at: string | null;
}

const EMPTY_SUMMARY: DeliverySummary = { pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };

async function getDeliverySummary(env: Env, campaignId: number): Promise<DeliverySummary> {
  const { results } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS count FROM newsletter_campaign_recipients WHERE campaign_id = ? GROUP BY status`
  )
    .bind(campaignId)
    .all<{ status: string; count: number }>();

  const summary = { ...EMPTY_SUMMARY };
  for (const row of results) {
    if (row.status in summary) (summary as unknown as Record<string, number>)[row.status] = row.count;
  }
  return summary;
}

/**
 * Batched form of `getDeliverySummary()` for list views — one aggregate
 * query grouped by `(campaign_id, status)` instead of one query per
 * non-draft campaign. Found as a real N+1 during the Phase 7 acceptance
 * audit's performance review; fixed here rather than left as debt since
 * the fix is a straightforward query change with no added complexity.
 */
async function getDeliverySummaries(env: Env, campaignIds: number[]): Promise<Map<number, DeliverySummary>> {
  const map = new Map<number, DeliverySummary>();
  if (campaignIds.length === 0) return map;

  const placeholders = campaignIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT campaign_id, status, COUNT(*) AS count FROM newsletter_campaign_recipients WHERE campaign_id IN (${placeholders}) GROUP BY campaign_id, status`
  )
    .bind(...campaignIds)
    .all<{ campaign_id: number; status: string; count: number }>();

  for (const row of results) {
    const summary = map.get(row.campaign_id) ?? { ...EMPTY_SUMMARY };
    if (row.status in summary) (summary as unknown as Record<string, number>)[row.status] = row.count;
    map.set(row.campaign_id, summary);
  }
  return map;
}

function toApiShape(row: CampaignRow, delivery: DeliverySummary): CampaignRecord {
  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    status: row.status,
    intendedRecipientCount: row.intended_recipient_count,
    testSentAt: row.test_sent_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentBy: row.sent_by,
    sentByName: row.sent_by_name,
    sendingStartedAt: row.sending_started_at,
    sentAt: row.sent_at,
    delivery,
  };
}

const CAMPAIGN_SELECT = `
  SELECT c.*, creator.name AS created_by_name, sender.name AS sent_by_name
  FROM newsletter_campaigns c
  LEFT JOIN admin_users creator ON creator.id = c.created_by
  LEFT JOIN admin_users sender ON sender.id = c.sent_by
`;

export async function listCampaigns(env: Env): Promise<CampaignRecord[]> {
  const { results } = await env.DB.prepare(`${CAMPAIGN_SELECT} WHERE c.deleted_at IS NULL ORDER BY c.id DESC`).all<CampaignRow>();
  const nonDraftIds = results.filter((row) => row.status !== 'draft').map((row) => row.id);
  const deliveryByCampaign = await getDeliverySummaries(env, nonDraftIds);
  return results.map((row) => toApiShape(row, row.status === 'draft' ? EMPTY_SUMMARY : deliveryByCampaign.get(row.id) ?? EMPTY_SUMMARY));
}

export async function getCampaignById(env: Env, id: number): Promise<CampaignRecord | null> {
  const row = await env.DB.prepare(`${CAMPAIGN_SELECT} WHERE c.id = ? AND c.deleted_at IS NULL`).bind(id).first<CampaignRow>();
  if (!row) return null;
  const delivery = row.status === 'draft' ? EMPTY_SUMMARY : await getDeliverySummary(env, id);
  return toApiShape(row, delivery);
}

async function getRawCampaign(env: Env, id: number): Promise<CampaignRow | null> {
  return env.DB.prepare(`SELECT * FROM newsletter_campaigns WHERE id = ?`).bind(id).first<CampaignRow>();
}

export async function getSubscribedCount(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM newsletter_subscribers WHERE status = 'subscribed'`).first<{ c: number }>();
  return row?.c ?? 0;
}

// ============================================================
// Draft CRUD
// ============================================================

export async function createCampaign(env: Env, logger: Logger, actorId: number, input: CampaignInput): Promise<CampaignRecord> {
  const sanitizedBody = (await sanitizeRichTextHtml(input.body)) ?? '';

  const insert = await env.DB.prepare(
    `INSERT INTO newsletter_campaigns (subject, body, status, created_by) VALUES (?, ?, 'draft', ?)`
  )
    .bind(input.subject.trim(), sanitizedBody, actorId)
    .run();
  const id = Number(insert.meta.last_row_id);

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'newsletter_campaign.created',
    entityType: 'newsletter_campaign',
    entityId: id,
    metadata: { subject: input.subject.trim() },
  });

  return (await getCampaignById(env, id))!;
}

export type MutationOutcome = { ok: true } | { ok: false; reason: 'not_found' | 'not_draft' };

export async function updateCampaign(
  env: Env,
  logger: Logger,
  actorId: number,
  id: number,
  input: CampaignInput
): Promise<(MutationOutcome & { campaign?: CampaignRecord })> {
  const existing = await getRawCampaign(env, id);
  if (!existing || existing.deleted_at) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'draft') return { ok: false, reason: 'not_draft' };

  const sanitizedBody = (await sanitizeRichTextHtml(input.body)) ?? '';

  // Any edit to subject/body clears test_sent_at — a test sent against
  // the previous content must never authorize sending different,
  // untested content. See migration 0016's header comment.
  await env.DB.prepare(
    `UPDATE newsletter_campaigns SET subject = ?, body = ?, test_sent_at = NULL, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(input.subject.trim(), sanitizedBody, id)
    .run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'newsletter_campaign.updated',
    entityType: 'newsletter_campaign',
    entityId: id,
    metadata: { before: { subject: existing.subject }, after: { subject: input.subject.trim() } },
  });

  return { ok: true, campaign: (await getCampaignById(env, id))! };
}

export async function deleteCampaign(env: Env, logger: Logger, actorId: number, id: number): Promise<MutationOutcome> {
  const existing = await getRawCampaign(env, id);
  if (!existing || existing.deleted_at) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'draft') return { ok: false, reason: 'not_draft' };

  await env.DB.prepare(`UPDATE newsletter_campaigns SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(id).run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'newsletter_campaign.deleted',
    entityType: 'newsletter_campaign',
    entityId: id,
    metadata: { subject: existing.subject },
  });

  return { ok: true };
}

// ============================================================
// Test send
// ============================================================

export type TestSendOutcome =
  | { ok: true; results: { email: string; sent: boolean }[] }
  | { ok: false; reason: 'not_found' | 'no_valid_emails' };

export async function sendTestEmail(env: Env, logger: Logger, actorId: number, id: number, testEmails: string[]): Promise<TestSendOutcome> {
  const campaign = await getRawCampaign(env, id);
  if (!campaign || campaign.deleted_at) return { ok: false, reason: 'not_found' };

  const validEmails = [...new Set(testEmails.map((e) => e.trim()).filter((e) => EMAIL_PATTERN.test(e)))];
  if (validEmails.length === 0) return { ok: false, reason: 'no_valid_emails' };

  const testSubject = `[TEST] ${campaign.subject}`;
  const results: { email: string; sent: boolean }[] = [];

  for (const email of validEmails) {
    const result = await sendEmail(env, logger, {
      template: 'newsletter-campaign',
      to: email,
      // No real subscriber/unsubscribe token exists for a test
      // address — a placeholder anchor, not a broken real link,
      // honestly signals "this is a preview."
      data: { campaignSubject: testSubject, unsubscribeUrl: '#' },
      rawBody: campaign.body,
      subjectOverride: testSubject,
      entityType: 'newsletter_campaign_test',
      entityId: id,
    });
    results.push({ email, sent: result.sent });
  }

  // Only unlocks Send if at least one test genuinely went out — an
  // admin whose only test attempt failed (bad address, Resend down,
  // or the newsletter-campaign template itself disabled via Settings)
  // must not be able to send to real subscribers having never
  // actually seen a rendered preview. Caught during implementation,
  // before it could ship as a real gap in the "test required" safeguard.
  if (results.some((r) => r.sent)) {
    await env.DB.prepare(`UPDATE newsletter_campaigns SET test_sent_at = datetime('now') WHERE id = ?`).bind(id).run();
  }

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'newsletter_campaign.test_sent',
    entityType: 'newsletter_campaign',
    entityId: id,
    metadata: { testEmails: validEmails, results },
  });

  return { ok: true, results };
}

// ============================================================
// Send / Resume
// ============================================================

export interface ActionContext {
  ip: string | null;
  userAgent: string | null;
}

export type SendOutcome =
  | { ok: true; recipientCount: number }
  | { ok: false; reason: 'not_found' | 'not_draft' | 'test_required' | 'no_recipients' | 'cap_exceeded'; cap?: number; subscribedCount?: number };

export async function sendCampaign(
  env: Env,
  logger: Logger,
  actorId: number,
  id: number,
  ctx: ExecutionContext,
  context: ActionContext
): Promise<SendOutcome> {
  const campaign = await getRawCampaign(env, id);
  if (!campaign || campaign.deleted_at) return { ok: false, reason: 'not_found' };
  if (campaign.status !== 'draft') return { ok: false, reason: 'not_draft' };
  if (!campaign.test_sent_at) return { ok: false, reason: 'test_required' };

  const subscribedCount = await getSubscribedCount(env);
  if (subscribedCount === 0) return { ok: false, reason: 'no_recipients' };

  const cap = await getCampaignRecipientCap(env);
  if (subscribedCount > cap) return { ok: false, reason: 'cap_exceeded', cap, subscribedCount };

  // Atomic Draft→Sending transition — the real duplicate-send guard.
  // If zero rows changed, another request already won this race (a
  // double-click, or two admins clicking Send at once).
  const transition = await env.DB.prepare(
    `UPDATE newsletter_campaigns SET status = 'sending', sent_by = ?, sending_started_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND status = 'draft'`
  )
    .bind(actorId, id)
    .run();
  if (transition.meta.changes !== 1) return { ok: false, reason: 'not_draft' };

  // Roster frozen here, once — per the user's explicit "immutable
  // recipient list once sending begins" recommendation. A subscriber
  // who joins afterward is never added to this campaign.
  const snapshot = await env.DB.prepare(
    `INSERT INTO newsletter_campaign_recipients (campaign_id, subscriber_id)
     SELECT ?, id FROM newsletter_subscribers WHERE status = 'subscribed'`
  )
    .bind(id)
    .run();
  const recipientCount = snapshot.meta.changes;

  await env.DB.prepare(`UPDATE newsletter_campaigns SET intended_recipient_count = ? WHERE id = ?`).bind(recipientCount, id).run();

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'newsletter_campaign.send_initiated',
    entityType: 'newsletter_campaign',
    entityId: id,
    metadata: { recipientCount, ip: context.ip, userAgent: context.userAgent },
  });

  ctx.waitUntil(
    processCampaignQueue(env, logger, id).catch((err) => {
      logger.error('campaign.queue_failed', { campaignId: id, error: err instanceof Error ? err.message : String(err) });
    })
  );

  return { ok: true, recipientCount };
}

export type ResumeOutcome = { ok: true; resumedCount: number } | { ok: false; reason: 'not_found' | 'not_sending' };

export async function resumeCampaign(
  env: Env,
  logger: Logger,
  actorId: number,
  id: number,
  ctx: ExecutionContext,
  context: ActionContext
): Promise<ResumeOutcome> {
  const campaign = await getRawCampaign(env, id);
  if (!campaign || campaign.deleted_at) return { ok: false, reason: 'not_found' };
  if (campaign.status !== 'sending') return { ok: false, reason: 'not_sending' };

  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM newsletter_campaign_recipients WHERE campaign_id = ? AND status IN ('pending', 'sending')`
  )
    .bind(id)
    .first<{ c: number }>();
  const resumedCount = remaining?.c ?? 0;

  await auditService.record(env, logger, {
    actorType: 'admin',
    actorId,
    action: 'newsletter_campaign.resume_initiated',
    entityType: 'newsletter_campaign',
    entityId: id,
    metadata: { resumedCount, ip: context.ip, userAgent: context.userAgent },
  });

  // Even a zero-remaining resume still runs the queue once — the loop
  // itself finalizes the campaign to Sent if nothing is left, closing
  // out a run that completed every recipient but never got to flip
  // its own top-level status (e.g. the Worker died right after the
  // last recipient's row write).
  ctx.waitUntil(
    processCampaignQueue(env, logger, id).catch((err) => {
      logger.error('campaign.queue_failed', { campaignId: id, error: err instanceof Error ? err.message : String(err) });
    })
  );

  return { ok: true, resumedCount };
}

// ============================================================
// The actual send loop
// ============================================================

interface PendingRecipient {
  recipientRowId: number;
  subscriberId: number;
  email: string;
}

async function processCampaignQueue(env: Env, logger: Logger, campaignId: number): Promise<void> {
  // Reclaims any row left `sending` by a previous run that was
  // interrupted mid-attempt (a real, if rare, possibility — see
  // docs/v2.1-phase6-implementation.md's findings). By the time a
  // resume is manually triggered, enough time has passed that any
  // legitimately in-flight single send would already have completed.
  await env.DB.prepare(`UPDATE newsletter_campaign_recipients SET status = 'pending' WHERE campaign_id = ? AND status = 'sending'`)
    .bind(campaignId)
    .run();

  const campaign = await env.DB.prepare(`SELECT subject, body FROM newsletter_campaigns WHERE id = ?`)
    .bind(campaignId)
    .first<{ subject: string; body: string }>();
  if (!campaign) {
    logger.error('campaign.queue_missing_campaign', { campaignId });
    return;
  }

  for (;;) {
    const next = await env.DB.prepare(
      `SELECT r.id AS recipientRowId, s.id AS subscriberId, s.email AS email
       FROM newsletter_campaign_recipients r JOIN newsletter_subscribers s ON s.id = r.subscriber_id
       WHERE r.campaign_id = ? AND r.status = 'pending' ORDER BY r.id ASC LIMIT 1`
    )
      .bind(campaignId)
      .first<PendingRecipient>();
    if (!next) break;

    // Per-row atomic claim — the same conditional-UPDATE-as-guard idiom
    // as the campaign-level Draft→Sending transition above, applied
    // per recipient so a concurrent resume can never send the same
    // person twice.
    const claim = await env.DB.prepare(`UPDATE newsletter_campaign_recipients SET status = 'sending' WHERE id = ? AND status = 'pending'`)
      .bind(next.recipientRowId)
      .run();
    if (claim.meta.changes !== 1) continue;

    const unsubscribeToken = await getOrCreateUnsubscribeToken(env, next.subscriberId);
    const unsubscribeUrl = `${env.SITE_BASE_URL}/newsletter/unsubscribe/?token=${unsubscribeToken}`;

    const result = await sendEmail(env, logger, {
      template: 'newsletter-campaign',
      to: next.email,
      data: { campaignSubject: campaign.subject, unsubscribeUrl },
      rawBody: campaign.body,
      subjectOverride: campaign.subject,
      entityType: 'newsletter_campaign',
      entityId: campaignId,
      listUnsubscribeUrl: `${API_BASE_URL}/api/newsletter/unsubscribe/${unsubscribeToken}`,
    });

    // 'failed' and 'permanently_failed' (email_log's finer distinction)
    // both collapse to this roster's 'failed' — the delivery summary
    // cares whether it reached the recipient, not why it didn't.
    const finalStatus = result.status === 'sent' ? 'sent' : result.status === 'skipped' ? 'skipped' : 'failed';

    await env.DB.prepare(`UPDATE newsletter_campaign_recipients SET status = ?, email_log_id = ?, attempted_at = datetime('now') WHERE id = ?`)
      .bind(finalStatus, result.emailLogId, next.recipientRowId)
      .run();
  }

  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM newsletter_campaign_recipients WHERE campaign_id = ? AND status IN ('pending', 'sending')`
  )
    .bind(campaignId)
    .first<{ c: number }>();

  if ((remaining?.c ?? 0) === 0) {
    await env.DB.prepare(`UPDATE newsletter_campaigns SET status = 'sent', sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'sending'`)
      .bind(campaignId)
      .run();
    logger.info('campaign.completed', { campaignId });
  }
}
