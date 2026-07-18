/**
 * Site Settings Service — Version 2.1 Phase 5 (Settings). See
 * docs/v2.1-phase5-design.md. The only code that writes to
 * `site_settings`. Owns exactly the six editable settings the design
 * doc scoped this phase to (maintenance mode, download defaults,
 * email sender/reply-to, per-template kill switches) plus the
 * read-only diagnostics aggregated from tables other services already
 * own (`payment_transactions`, `email_log`, `d1_migrations`).
 *
 * Every returned field is tagged with its configuration `source`, per
 * the user's explicit "settings ownership" requirement — a value is
 * never shown without saying where it actually lives, and `editable`
 * is `false` for anything whose authoritative source isn't
 * `site_settings` (a Cloudflare Secret, a `wrangler.jsonc` var, or a
 * derived/computed value can never be written through this service,
 * regardless of what a client sends).
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { EmailTemplateName } from '../emailService';
import * as auditService from './auditService';
import packageJson from '../../package.json';

/**
 * Identifies which `site_settings` key *shape* this deployment
 * expects. Bumped by hand alongside a migration that changes what any
 * of the six keys below mean — not a migration framework, just a
 * lightweight, honest "does the code's expectation match what's
 * actually stored" signal for troubleshooting, per explicit request.
 */
export const EXPECTED_SETTINGS_SCHEMA_VERSION = 1;

export type ConfigSource = 'site_settings' | 'wrangler_var' | 'secret' | 'derived';

export interface SettingsField<T> {
  value: T;
  source: ConfigSource;
  editable: boolean;
}

function field<T>(value: T, source: ConfigSource, editable: boolean): SettingsField<T> {
  return { value, source, editable };
}

// ============================================================
// The six editable settings — defaults applied when a key has never
// been explicitly set, so `site_settings` being empty is behaviorally
// identical to every setting being at its safe, off/unlimited default.
// ============================================================

export const EMAIL_TEMPLATE_NAMES: readonly EmailTemplateName[] = [
  'newsletter-welcome',
  'free-guide-delivery',
  'consultation-acknowledgement',
  'contact-acknowledgement',
  'purchase-receipt',
  'secure-download',
  'password-reset',
  'admin-invite',
];

export interface MaintenanceModeValue {
  enabled: boolean;
  message: string;
}

const DEFAULTS = {
  maintenance_mode: { enabled: false, message: '' } as MaintenanceModeValue,
  default_max_downloads: null as number | null,
  default_download_expires_days: null as number | null,
  email_sender_name: 'Robayer WealthLab',
  email_reply_to: null as string | null,
  email_template_enabled: Object.fromEntries(EMAIL_TEMPLATE_NAMES.map((t) => [t, true])) as Record<EmailTemplateName, boolean>,
  // Version 2.1 Phase 6 (Newsletter Campaigns) — the architectural
  // boundary of "synchronous Workers execution, no queue" is fixed;
  // only the exact number is configurable, per explicit request, so
  // it can be tuned without a code deploy as real subscriber counts
  // change. Not a promise that raising this indefinitely stays safe —
  // see docs/v2.1-phase6-design.md's §4.
  campaign_recipient_cap: 300 as number,
};

type SettingsKey = keyof typeof DEFAULTS;
const SETTINGS_KEYS = Object.keys(DEFAULTS) as SettingsKey[];

interface SettingsRow {
  key: string;
  value: string;
}

async function readRawSettings(env: Env): Promise<Map<string, unknown>> {
  const { results } = await env.DB.prepare(`SELECT key, value FROM site_settings`).all<SettingsRow>();
  const map = new Map<string, unknown>();
  for (const row of results) {
    try {
      map.set(row.key, JSON.parse(row.value));
    } catch {
      // A malformed stored value (e.g. hand-edited directly in D1)
      // falls back to the default below rather than ever throwing —
      // a settings read must never 500 the entire admin.
    }
  }
  return map;
}

/** The single place a value for a given key is resolved: stored (if present and parseable) else the safe default. */
function resolve<K extends SettingsKey>(raw: Map<string, unknown>, key: K): (typeof DEFAULTS)[K] {
  return raw.has(key) ? (raw.get(key) as (typeof DEFAULTS)[K]) : DEFAULTS[key];
}

export interface EditableSettingsView {
  maintenanceMode: SettingsField<MaintenanceModeValue>;
  defaultMaxDownloads: SettingsField<number | null>;
  defaultDownloadExpiresDays: SettingsField<number | null>;
  emailSenderName: SettingsField<string>;
  emailReplyTo: SettingsField<string | null>;
  emailTemplateEnabled: SettingsField<Record<string, boolean>>;
  campaignRecipientCap: SettingsField<number>;
  settingsSchemaVersion: SettingsField<{ stored: number; expected: number; matches: boolean }>;
}

export async function getEditableSettings(env: Env): Promise<EditableSettingsView> {
  const raw = await readRawSettings(env);

  const storedVersionRaw = raw.get('settings_schema_version');
  const storedVersion = typeof storedVersionRaw === 'number' ? storedVersionRaw : Number(storedVersionRaw) || 0;

  return {
    maintenanceMode: field(resolve(raw, 'maintenance_mode'), 'site_settings', true),
    defaultMaxDownloads: field(resolve(raw, 'default_max_downloads'), 'site_settings', true),
    defaultDownloadExpiresDays: field(resolve(raw, 'default_download_expires_days'), 'site_settings', true),
    emailSenderName: field(resolve(raw, 'email_sender_name'), 'site_settings', true),
    emailReplyTo: field(resolve(raw, 'email_reply_to'), 'site_settings', true),
    emailTemplateEnabled: field(resolve(raw, 'email_template_enabled'), 'site_settings', true),
    campaignRecipientCap: field(resolve(raw, 'campaign_recipient_cap'), 'site_settings', true),
    settingsSchemaVersion: field(
      { stored: storedVersion, expected: EXPECTED_SETTINGS_SCHEMA_VERSION, matches: storedVersion === EXPECTED_SETTINGS_SCHEMA_VERSION },
      'site_settings',
      false
    ),
  };
}

/** Resolves just the configured campaign recipient safety cap — `campaignService.ts` needs this at send time. */
export async function getCampaignRecipientCap(env: Env): Promise<number> {
  const raw = await readRawSettings(env);
  return resolve(raw, 'campaign_recipient_cap');
}

/**
 * Resolves just the three values `emailService.ts` needs at send
 * time, with defaults applied — a narrower, cheaper read than the
 * full admin-facing view above.
 */
export async function getEmailSendSettings(env: Env): Promise<{ senderName: string; replyTo: string | null; templateEnabled: Record<EmailTemplateName, boolean> }> {
  const raw = await readRawSettings(env);
  return {
    senderName: resolve(raw, 'email_sender_name'),
    replyTo: resolve(raw, 'email_reply_to'),
    templateEnabled: resolve(raw, 'email_template_enabled'),
  };
}

/** Resolves just the two download-default values `productService.ts` needs at create time. */
export async function getDownloadDefaults(env: Env): Promise<{ maxDownloads: number | null; downloadExpiresDays: number | null }> {
  const raw = await readRawSettings(env);
  return {
    maxDownloads: resolve(raw, 'default_max_downloads'),
    downloadExpiresDays: resolve(raw, 'default_download_expires_days'),
  };
}

/** Resolves just `maintenance_mode` — the one setting read on every single request, kept as small a query as the others for consistency even though it's a single-row lookup either way. */
export async function getMaintenanceMode(env: Env): Promise<MaintenanceModeValue> {
  const row = await env.DB.prepare(`SELECT value FROM site_settings WHERE key = 'maintenance_mode'`).first<{ value: string }>();
  if (!row) return DEFAULTS.maintenance_mode;
  try {
    return JSON.parse(row.value) as MaintenanceModeValue;
  } catch {
    return DEFAULTS.maintenance_mode;
  }
}

// ============================================================
// Validation — every editable setting has explicit server-side
// validation; nothing here trusts client-side checks.
// ============================================================

export interface SettingsValidationError {
  field: string;
  message: string;
}

const MAX_MESSAGE_LENGTH = 500;
const MAX_SENDER_NAME_LENGTH = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateMaintenanceMode(value: unknown, errors: SettingsValidationError[]): MaintenanceModeValue | undefined {
  if (typeof value !== 'object' || value === null) {
    errors.push({ field: 'maintenanceMode', message: 'Maintenance mode must be an object with enabled/message.' });
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== 'boolean') {
    errors.push({ field: 'maintenanceMode.enabled', message: 'enabled must be true or false.' });
    return undefined;
  }
  if (typeof v.message !== 'string' || v.message.length > MAX_MESSAGE_LENGTH) {
    errors.push({ field: 'maintenanceMode.message', message: `message must be text, ${MAX_MESSAGE_LENGTH} characters or fewer.` });
    return undefined;
  }
  return { enabled: v.enabled, message: v.message };
}

function validateOptionalPositiveInt(value: unknown, fieldName: string, max: number, errors: SettingsValidationError[]): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    errors.push({ field: fieldName, message: `${fieldName} must be a whole number between 1 and ${max}, or null.` });
    return undefined;
  }
  return value;
}

function validateSenderName(value: unknown, errors: SettingsValidationError[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_SENDER_NAME_LENGTH) {
    errors.push({ field: 'emailSenderName', message: `Sender name must be 1-${MAX_SENDER_NAME_LENGTH} characters.` });
    return undefined;
  }
  return value.trim();
}

function validateReplyTo(value: unknown, errors: SettingsValidationError[]): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !EMAIL_PATTERN.test(value)) {
    errors.push({ field: 'emailReplyTo', message: 'Reply-to must be a valid email address, or null.' });
    return undefined;
  }
  return value;
}

const MAX_CAMPAIGN_RECIPIENT_CAP = 1000; // above this, the architectural note in docs/v2.1-phase6-design.md's §4 applies — a queue, not a bigger number here, is the correct next step

function validateCampaignRecipientCap(value: unknown, errors: SettingsValidationError[]): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_CAMPAIGN_RECIPIENT_CAP) {
    errors.push({ field: 'campaignRecipientCap', message: `campaignRecipientCap must be a whole number between 1 and ${MAX_CAMPAIGN_RECIPIENT_CAP}.` });
    return undefined;
  }
  return value;
}

function validateTemplateEnabled(value: unknown, errors: SettingsValidationError[]): Record<string, boolean> | undefined {
  if (typeof value !== 'object' || value === null) {
    errors.push({ field: 'emailTemplateEnabled', message: 'emailTemplateEnabled must be an object.' });
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const result: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(v)) {
    if (!(EMAIL_TEMPLATE_NAMES as readonly string[]).includes(key)) {
      errors.push({ field: 'emailTemplateEnabled', message: `Unrecognized template name: "${key}".` });
      return undefined;
    }
    if (typeof enabled !== 'boolean') {
      errors.push({ field: `emailTemplateEnabled.${key}`, message: 'Each template value must be true or false.' });
      return undefined;
    }
    result[key] = enabled;
  }
  return result;
}

// ============================================================
// Update — one changed key at a time, each independently validated,
// each independently audit-logged with before/after.
// ============================================================

export interface ActionContext {
  ip: string | null;
  userAgent: string | null;
}

export type UpdateSettingsResult = { ok: true } | { ok: false; errors: SettingsValidationError[] };

const PATCH_KEY_MAP: Record<string, SettingsKey> = {
  maintenanceMode: 'maintenance_mode',
  defaultMaxDownloads: 'default_max_downloads',
  defaultDownloadExpiresDays: 'default_download_expires_days',
  emailSenderName: 'email_sender_name',
  emailReplyTo: 'email_reply_to',
  emailTemplateEnabled: 'email_template_enabled',
  campaignRecipientCap: 'campaign_recipient_cap',
};

export async function updateSettings(env: Env, logger: Logger, actorId: number, patch: Record<string, unknown>, context: ActionContext): Promise<UpdateSettingsResult> {
  const errors: SettingsValidationError[] = [];
  const validated: Partial<Record<SettingsKey, unknown>> = {};

  for (const [apiKey, dbKey] of Object.entries(PATCH_KEY_MAP)) {
    if (!(apiKey in patch)) continue;
    const rawValue = patch[apiKey];

    let value: unknown;
    switch (dbKey) {
      case 'maintenance_mode':
        value = validateMaintenanceMode(rawValue, errors);
        break;
      case 'default_max_downloads':
        value = validateOptionalPositiveInt(rawValue, 'defaultMaxDownloads', 1000, errors);
        break;
      case 'default_download_expires_days':
        value = validateOptionalPositiveInt(rawValue, 'defaultDownloadExpiresDays', 3650, errors);
        break;
      case 'email_sender_name':
        value = validateSenderName(rawValue, errors);
        break;
      case 'email_reply_to':
        value = validateReplyTo(rawValue, errors);
        break;
      case 'email_template_enabled':
        value = validateTemplateEnabled(rawValue, errors);
        break;
      case 'campaign_recipient_cap':
        value = validateCampaignRecipientCap(rawValue, errors);
        break;
    }

    // undefined means validation already recorded an error for this key
    if (value !== undefined) validated[dbKey] = value;
  }

  if (errors.length > 0) return { ok: false, errors };
  if (Object.keys(validated).length === 0) return { ok: true };

  const raw = await readRawSettings(env);

  for (const [dbKey, newValue] of Object.entries(validated)) {
    const before = resolve(raw, dbKey as SettingsKey);
    await env.DB.prepare(
      `INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    )
      .bind(dbKey, JSON.stringify(newValue), actorId)
      .run();

    // One audit row per changed key — applies even to a simple
    // boolean toggle, per explicit requirement. before/after captured
    // as real values, not just "changed: true".
    await auditService.record(env, logger, {
      actorType: 'admin',
      actorId,
      action: 'site_settings.updated',
      entityType: 'site_settings',
      entityId: null,
      metadata: { key: dbKey, before, after: newValue, ip: context.ip, userAgent: context.userAgent },
    });
  }

  logger.info('site_settings.updated', { actorId, keys: Object.keys(validated) });

  return { ok: true };
}

// ============================================================
// Read-only diagnostics — GET /api/admin/settings/status. Every value
// here is derived live from tables another service already owns
// (payment_transactions, email_log) or from env/request context —
// nothing is duplicated into site_settings.
// ============================================================

function classifyPaystackEnvironment(secretKey: string): 'test' | 'live' | 'unknown' {
  // Only the fixed-length prefix is ever inspected — the full key is
  // never assigned to a variable that outlives this comparison, never
  // logged, never returned. Matches how real payment dashboards show
  // a test-mode banner without displaying the key itself.
  if (secretKey.startsWith('sk_test_')) return 'test';
  if (secretKey.startsWith('sk_live_')) return 'live';
  return 'unknown';
}

export interface PaymentDiagnostics {
  provider: SettingsField<string>;
  environment: SettingsField<'test' | 'live' | 'unknown' | 'not_configured'>;
  secretConfigured: SettingsField<boolean>;
  lastSuccessfulPaymentAt: SettingsField<string | null>;
  lastWebhookReceivedAt: SettingsField<string | null>;
  recentFailureCount7d: SettingsField<number>;
}

async function getPaymentDiagnostics(env: Env): Promise<PaymentDiagnostics> {
  const secretConfigured = typeof env.PAYSTACK_SECRET_KEY === 'string' && env.PAYSTACK_SECRET_KEY.length > 0;
  const environment = secretConfigured ? classifyPaystackEnvironment(env.PAYSTACK_SECRET_KEY) : 'not_configured';

  const [lastPayment, lastWebhook, recentFailures] = await Promise.all([
    env.DB.prepare(`SELECT MAX(created_at) AS at FROM payment_transactions WHERE status = 'success'`).first<{ at: string | null }>(),
    env.DB.prepare(`SELECT MAX(webhook_received_at) AS at FROM payment_transactions WHERE webhook_received_at IS NOT NULL`).first<{ at: string | null }>(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM payment_transactions WHERE status = 'failed' AND created_at > datetime('now', '-7 days')`).first<{ count: number }>(),
  ]);

  return {
    provider: field(env.PAYMENT_PROVIDER, 'wrangler_var', false),
    environment: field(environment, 'secret', false),
    secretConfigured: field(secretConfigured, 'secret', false),
    lastSuccessfulPaymentAt: field(lastPayment?.at ?? null, 'derived', false),
    lastWebhookReceivedAt: field(lastWebhook?.at ?? null, 'derived', false),
    recentFailureCount7d: field(recentFailures?.count ?? 0, 'derived', false),
  };
}

export interface EmailTemplateDiagnostics {
  template: string;
  lastSentAt: string | null;
  sentCount30d: number;
  failedCount30d: number;
  skippedCount30d: number;
}

export interface EmailDiagnostics {
  resendConfigured: SettingsField<boolean>;
  perTemplate: EmailTemplateDiagnostics[];
}

async function getEmailDiagnostics(env: Env): Promise<EmailDiagnostics> {
  const { results } = await env.DB.prepare(
    `SELECT template,
            MAX(CASE WHEN status = 'sent' THEN sent_at END) AS lastSentAt,
            SUM(CASE WHEN status = 'sent' AND created_at > datetime('now', '-30 days') THEN 1 ELSE 0 END) AS sentCount30d,
            SUM(CASE WHEN status IN ('failed', 'permanently_failed') AND created_at > datetime('now', '-30 days') THEN 1 ELSE 0 END) AS failedCount30d,
            SUM(CASE WHEN status = 'skipped' AND created_at > datetime('now', '-30 days') THEN 1 ELSE 0 END) AS skippedCount30d
     FROM email_log
     GROUP BY template`
  ).all<EmailTemplateDiagnostics>();

  const byTemplate = new Map(results.map((r) => [r.template, r]));

  return {
    resendConfigured: field(typeof env.RESEND_API_KEY === 'string' && env.RESEND_API_KEY.length > 0, 'secret', false),
    perTemplate: EMAIL_TEMPLATE_NAMES.map((t) => byTemplate.get(t) ?? { template: t, lastSentAt: null, sentCount30d: 0, failedCount30d: 0, skippedCount30d: 0 }),
  };
}

export interface SystemDiagnostics {
  environment: SettingsField<'production' | 'development'>;
  appVersion: SettingsField<string>;
  deployedCommit: SettingsField<string | null>;
  deployedAt: SettingsField<string | null>;
  currentMigration: SettingsField<string | null>;
  settingsSchemaVersion: SettingsField<{ stored: number; expected: number; matches: boolean }>;
}

async function getSystemDiagnostics(env: Env, request: Request): Promise<SystemDiagnostics> {
  const hostname = new URL(request.url).hostname;
  const environment = hostname === 'robayerwealthlab.com' ? 'production' : 'development';

  const migrationRow = await env.DB.prepare(`SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1`).first<{ name: string }>();

  const raw = await readRawSettings(env);
  const storedVersionRaw = raw.get('settings_schema_version');
  const storedVersion = typeof storedVersionRaw === 'number' ? storedVersionRaw : Number(storedVersionRaw) || 0;

  return {
    environment: field(environment, 'derived', false),
    appVersion: field(packageJson.version, 'wrangler_var', false),
    deployedCommit: field(env.DEPLOYED_COMMIT || null, 'wrangler_var', false),
    deployedAt: field(env.DEPLOYED_AT || null, 'wrangler_var', false),
    currentMigration: field(migrationRow?.name ?? null, 'derived', false),
    settingsSchemaVersion: field(
      { stored: storedVersion, expected: EXPECTED_SETTINGS_SCHEMA_VERSION, matches: storedVersion === EXPECTED_SETTINGS_SCHEMA_VERSION },
      'site_settings',
      false
    ),
  };
}

export interface SettingsStatusView {
  payment: PaymentDiagnostics;
  email: EmailDiagnostics;
  system: SystemDiagnostics;
}

export async function getSettingsStatus(env: Env, request: Request): Promise<SettingsStatusView> {
  const [payment, email, system] = await Promise.all([getPaymentDiagnostics(env), getEmailDiagnostics(env), getSystemDiagnostics(env, request)]);
  return { payment, email, system };
}
