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
import { getAllRoutingConfig } from '../ai/routingConfig';
import {
  getAiGatewayBudgetConfig as readAiGatewayBudgetConfig,
  getAiGatewayRetentionConfig as readAiGatewayRetentionConfig,
  DEFAULT_PER_REQUEST_CAP_USD_MICROS,
  DEFAULT_DAILY_BUDGET_USD_MICROS,
  DEFAULT_MONTHLY_BUDGET_USD_MICROS,
  DEFAULT_PLATFORM_BUDGET_USD_MICROS,
  DEFAULT_RETENTION_CONFIG,
  VALID_RETENTION_STORAGE_MODES,
  VALID_RETENTION_DAYS,
  type AiRetentionStorageMode,
} from '../ai/aiGatewayConfig';
import { isEncryptionAvailable } from '../ai/promptEncryption';
import { POLICY_VERSION, SENSITIVITY_CLASSIFICATIONS } from '../ai/providerPolicy';
import { getAiGovernanceSummary } from './aiUsageService';
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
  // Version 4.0 Milestone C1 (Core Email Lifecycle) — the one
  // genuinely new template this milestone adds. Not backfilling the
  // other customer-* templates (customer-welcome,
  // customer-password-reset, customer-purchase-reconciliation,
  // customer-review-reminder, newsletter-campaign) here — they predate
  // this list and were never added to it; leaving that pre-existing
  // gap alone rather than changing behavior for templates this
  // milestone didn't touch.
  'customer-purchase-followup',
];

export interface MaintenanceModeValue {
  enabled: boolean;
  message: string;
}

/**
 * Version 3.4 Milestone M6 (CMS Completion) - the generic hero copy
 * that surrounds the featured-product block. The featured product's
 * own title/cover/price are already CMS-driven through the Products
 * admin and productCatalogService.ts; this covers only the surrounding
 * headline/subheading/buttons that were previously hardcoded directly
 * in index.html.
 */
export interface HeroContentValue {
  eyebrow: string;
  headline: string;
  subheading: string;
  primaryCtaText: string;
  primaryCtaHref: string;
  secondaryCtaText: string;
  secondaryCtaHref: string;
}

/**
 * Phase C (Announcement / Notification System) — a single site-wide
 * strip, admin-controlled, following hero_content's exact precedent
 * (a JSON blob under site_settings, one narrow public GET, one
 * super_admin-gated PATCH via the existing settings routes). No new
 * table, no new migration: site_settings' plain key/value shape
 * already fits this exactly the way it fits hero_content.
 *
 * `type` reuses the same four-way vocabulary this codebase's own
 * `.alert--info/--success/--warning` classes already use, plus
 * `promotion` for a product-announcement tone — no new color system.
 * `buttonUrl` reuses HERO_HREF_PATTERN/validateHeroHref's own
 * relative-path-or-mailto/tel allowlist (see below) — the same
 * reasoning applies identically here: an admin-supplied absolute URL
 * would make this field a stored-XSS/open-redirect vector, so
 * `javascript:` and any other scheme is rejected the same way.
 */
export type AnnouncementType = 'info' | 'success' | 'warning' | 'promotion';
export const ANNOUNCEMENT_TYPES: readonly AnnouncementType[] = ['info', 'success', 'warning', 'promotion'];

export interface AnnouncementValue {
  enabled: boolean;
  type: AnnouncementType;
  title: string;
  message: string;
  buttonText: string;
  buttonUrl: string;
  dismissible: boolean;
}

const DEFAULTS = {
  maintenance_mode: { enabled: false, message: '' } as MaintenanceModeValue,
  announcement: {
    enabled: false,
    type: 'info',
    title: '',
    message: '',
    buttonText: '',
    buttonUrl: '',
    dismissible: true,
  } as AnnouncementValue,
  hero_content: {
    eyebrow: 'Financial education for Ghana',
    headline: 'Financial education built for everyday Ghanaians.',
    subheading:
      'Practical, honest guidance on saving, investing, and growing money, grounded in treasury bills, mobile money, and the Ghana Stock Exchange, not advice imported from somewhere else.',
    primaryCtaText: 'Explore Free Resources',
    primaryCtaHref: '/resources/',
    secondaryCtaText: 'Get in Touch',
    secondaryCtaHref: '/contact/',
  } as HeroContentValue,
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
  // Version 5.0 Milestone 1.1 introduced these as warning-only
  // thresholds. Version 5.0 Milestone 1.2 (AI Governance & Safety,
  // Task 1) makes them PREVENTIVE — callAi() now refuses a candidate
  // BEFORE contacting the provider if the estimated cost would put
  // spend over any of these. The actual numbers are defined ONCE in
  // services/ai/aiGatewayConfig.ts (imported here, not
  // re-hardcoded) — that module is what services/ai/aiGateway.ts
  // itself reads at enforcement time, so this settings-editing layer
  // can never silently drift from what the Gateway actually enforces.
  ai_gateway_cost_cap_usd_micros: DEFAULT_PER_REQUEST_CAP_USD_MICROS as number,
  ai_gateway_daily_budget_usd_micros: DEFAULT_DAILY_BUDGET_USD_MICROS as number | null,
  ai_gateway_monthly_budget_usd_micros: DEFAULT_MONTHLY_BUDGET_USD_MICROS as number | null,
  // Version 5.0 Milestone 1.2 (Task 1) — per-provider LIFETIME ceiling
  // overrides, keyed by provider name (e.g. {"openai": 75000000}). A
  // provider absent from this map falls back to the platform-wide
  // per-provider default (services/ai/aiGatewayConfig.ts's
  // DEFAULT_PROVIDER_BUDGET_USD_MICROS).
  ai_gateway_provider_budgets_usd_micros: {} as Record<string, number | null>,
  ai_gateway_platform_budget_usd_micros: DEFAULT_PLATFORM_BUDGET_USD_MICROS as number | null,
  // Version 5.0 Milestone 1.2 (Task 5) — see
  // services/ai/aiGatewayConfig.ts's AiGatewayRetentionConfig for the
  // full mode/period semantics.
  ai_gateway_retention_storage_mode: DEFAULT_RETENTION_CONFIG.storageMode as AiRetentionStorageMode,
  ai_gateway_retention_days: DEFAULT_RETENTION_CONFIG.retentionDays as number | null,
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
  heroContent: SettingsField<HeroContentValue>;
  announcement: SettingsField<AnnouncementValue>;
  defaultMaxDownloads: SettingsField<number | null>;
  defaultDownloadExpiresDays: SettingsField<number | null>;
  emailSenderName: SettingsField<string>;
  emailReplyTo: SettingsField<string | null>;
  emailTemplateEnabled: SettingsField<Record<string, boolean>>;
  campaignRecipientCap: SettingsField<number>;
  aiGatewayCostCapUsdMicros: SettingsField<number>;
  aiGatewayDailyBudgetUsdMicros: SettingsField<number | null>;
  aiGatewayMonthlyBudgetUsdMicros: SettingsField<number | null>;
  aiGatewayProviderBudgetsUsdMicros: SettingsField<Record<string, number | null>>;
  aiGatewayPlatformBudgetUsdMicros: SettingsField<number | null>;
  aiGatewayRetentionStorageMode: SettingsField<AiRetentionStorageMode>;
  aiGatewayRetentionDays: SettingsField<number | null>;
  settingsSchemaVersion: SettingsField<{ stored: number; expected: number; matches: boolean }>;
}

export async function getEditableSettings(env: Env): Promise<EditableSettingsView> {
  const raw = await readRawSettings(env);

  const storedVersionRaw = raw.get('settings_schema_version');
  const storedVersion = typeof storedVersionRaw === 'number' ? storedVersionRaw : Number(storedVersionRaw) || 0;

  return {
    maintenanceMode: field(resolve(raw, 'maintenance_mode'), 'site_settings', true),
    heroContent: field(resolve(raw, 'hero_content'), 'site_settings', true),
    announcement: field(resolve(raw, 'announcement'), 'site_settings', true),
    defaultMaxDownloads: field(resolve(raw, 'default_max_downloads'), 'site_settings', true),
    defaultDownloadExpiresDays: field(resolve(raw, 'default_download_expires_days'), 'site_settings', true),
    emailSenderName: field(resolve(raw, 'email_sender_name'), 'site_settings', true),
    emailReplyTo: field(resolve(raw, 'email_reply_to'), 'site_settings', true),
    emailTemplateEnabled: field(resolve(raw, 'email_template_enabled'), 'site_settings', true),
    campaignRecipientCap: field(resolve(raw, 'campaign_recipient_cap'), 'site_settings', true),
    aiGatewayCostCapUsdMicros: field(resolve(raw, 'ai_gateway_cost_cap_usd_micros'), 'site_settings', true),
    aiGatewayDailyBudgetUsdMicros: field(resolve(raw, 'ai_gateway_daily_budget_usd_micros'), 'site_settings', true),
    aiGatewayMonthlyBudgetUsdMicros: field(resolve(raw, 'ai_gateway_monthly_budget_usd_micros'), 'site_settings', true),
    aiGatewayProviderBudgetsUsdMicros: field(resolve(raw, 'ai_gateway_provider_budgets_usd_micros'), 'site_settings', true),
    aiGatewayPlatformBudgetUsdMicros: field(resolve(raw, 'ai_gateway_platform_budget_usd_micros'), 'site_settings', true),
    aiGatewayRetentionStorageMode: field(resolve(raw, 'ai_gateway_retention_storage_mode'), 'site_settings', true),
    aiGatewayRetentionDays: field(resolve(raw, 'ai_gateway_retention_days'), 'site_settings', true),
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

/**
 * Resolves just `hero_content` for the public, unauthenticated
 * GET /api/hero endpoint the homepage's client-side JS fetches on
 * every load - same single-row-lookup shape as getMaintenanceMode()
 * above, kept separate from getEditableSettings() so the public
 * endpoint never risks exposing any of the other five settings.
 */
export async function getHeroContent(env: Env): Promise<HeroContentValue> {
  const row = await env.DB.prepare(`SELECT value FROM site_settings WHERE key = 'hero_content'`).first<{ value: string }>();
  if (!row) return DEFAULTS.hero_content;
  try {
    return JSON.parse(row.value) as HeroContentValue;
  } catch {
    return DEFAULTS.hero_content;
  }
}

/**
 * Resolves `announcement` for the public, unauthenticated
 * GET /api/announcement endpoint — same narrow-read-only-what's-
 * needed reasoning as getHeroContent()/getMaintenanceMode() above,
 * so the public site never risks exposing any other site_settings
 * value through this path.
 *
 * `version` is site_settings.updated_at itself (already maintained by
 * every write, see updateSettings()'s own INSERT/UPDATE below) rather
 * than a new field — reused as a stable per-publish identifier so the
 * frontend's dismissal storage can key off "this exact announcement,
 * as last edited" and a newly published (or re-edited) announcement
 * is never hidden by an old dismissal.
 */
export async function getAnnouncement(env: Env): Promise<AnnouncementValue & { version: string | null }> {
  const row = await env.DB.prepare(`SELECT value, updated_at FROM site_settings WHERE key = 'announcement'`).first<{ value: string; updated_at: string }>();
  if (!row) return { ...DEFAULTS.announcement, version: null };
  try {
    return { ...(JSON.parse(row.value) as AnnouncementValue), version: row.updated_at };
  } catch {
    return { ...DEFAULTS.announcement, version: null };
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

const MAX_HERO_TEXT_LENGTH = 200;
const MAX_HERO_SUBHEADING_LENGTH = 500;
// Internal navigation only (relative paths) or a small allowlist of
// external protocols that are safe to redirect a visitor to - never an
// admin-supplied arbitrary absolute URL, which would make this field a
// stored-XSS/open-redirect vector for whoever can edit site settings.
//
// (?!\/) immediately after the required leading "/" - Phase C Final
// Review found that "/" is itself inside the allowed character class,
// so a SECOND leading slash ("//host/path") also matched this pattern
// before the lookahead was added. Browsers treat a "//"-prefixed URL
// as protocol-relative: on an HTTPS page it resolves to a full
// external navigation (https://host/path), not a same-site path - a
// real open-redirect/phishing vector, not a same-site one. Verified
// via a direct production query that zero site_settings rows
// currently exist for hero_content or announcement (this repo's only
// two consumers of this pattern), so tightening it has no legitimate
// stored value to break.
const HERO_HREF_PATTERN = /^\/(?!\/)[a-zA-Z0-9\-/_#?=&.]*$|^(mailto|tel):[^\s]+$/;

function validateHeroText(value: unknown, fieldName: string, maxLength: number, errors: SettingsValidationError[]): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    errors.push({ field: fieldName, message: `${fieldName} must be text, 1-${maxLength} characters.` });
    return undefined;
  }
  return value.trim();
}

function validateHeroHref(value: unknown, fieldName: string, errors: SettingsValidationError[]): string | undefined {
  if (typeof value !== 'string' || !HERO_HREF_PATTERN.test(value)) {
    errors.push({ field: fieldName, message: `${fieldName} must be a relative site path (starting with /), or a mailto:/tel: link.` });
    return undefined;
  }
  return value;
}

function validateHeroContent(value: unknown, errors: SettingsValidationError[]): HeroContentValue | undefined {
  if (typeof value !== 'object' || value === null) {
    errors.push({ field: 'heroContent', message: 'Hero content must be an object.' });
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const errorCountBefore = errors.length;

  const eyebrow = validateHeroText(v.eyebrow, 'heroContent.eyebrow', MAX_HERO_TEXT_LENGTH, errors);
  const headline = validateHeroText(v.headline, 'heroContent.headline', MAX_HERO_TEXT_LENGTH, errors);
  const subheading = validateHeroText(v.subheading, 'heroContent.subheading', MAX_HERO_SUBHEADING_LENGTH, errors);
  const primaryCtaText = validateHeroText(v.primaryCtaText, 'heroContent.primaryCtaText', MAX_HERO_TEXT_LENGTH, errors);
  const primaryCtaHref = validateHeroHref(v.primaryCtaHref, 'heroContent.primaryCtaHref', errors);
  const secondaryCtaText = validateHeroText(v.secondaryCtaText, 'heroContent.secondaryCtaText', MAX_HERO_TEXT_LENGTH, errors);
  const secondaryCtaHref = validateHeroHref(v.secondaryCtaHref, 'heroContent.secondaryCtaHref', errors);

  if (errors.length > errorCountBefore) return undefined;
  return {
    eyebrow: eyebrow!,
    headline: headline!,
    subheading: subheading!,
    primaryCtaText: primaryCtaText!,
    primaryCtaHref: primaryCtaHref!,
    secondaryCtaText: secondaryCtaText!,
    secondaryCtaHref: secondaryCtaHref!,
  };
}

const MAX_ANNOUNCEMENT_TITLE_LENGTH = 150;
const MAX_ANNOUNCEMENT_MESSAGE_LENGTH = 500;
const MAX_ANNOUNCEMENT_BUTTON_TEXT_LENGTH = 60;

function validateAnnouncement(value: unknown, errors: SettingsValidationError[]): AnnouncementValue | undefined {
  if (typeof value !== 'object' || value === null) {
    errors.push({ field: 'announcement', message: 'Announcement must be an object.' });
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const errorCountBefore = errors.length;

  if (typeof v.enabled !== 'boolean') {
    errors.push({ field: 'announcement.enabled', message: 'enabled must be true or false.' });
  }
  if (typeof v.type !== 'string' || !(ANNOUNCEMENT_TYPES as readonly string[]).includes(v.type)) {
    errors.push({ field: 'announcement.type', message: `type must be one of: ${ANNOUNCEMENT_TYPES.join(', ')}.` });
  }
  if (typeof v.title !== 'string' || v.title.length > MAX_ANNOUNCEMENT_TITLE_LENGTH) {
    errors.push({ field: 'announcement.title', message: `title must be text, ${MAX_ANNOUNCEMENT_TITLE_LENGTH} characters or fewer.` });
  }
  if (typeof v.message !== 'string' || v.message.length > MAX_ANNOUNCEMENT_MESSAGE_LENGTH) {
    errors.push({ field: 'announcement.message', message: `message must be text, ${MAX_ANNOUNCEMENT_MESSAGE_LENGTH} characters or fewer.` });
  }
  if (typeof v.buttonText !== 'string' || v.buttonText.length > MAX_ANNOUNCEMENT_BUTTON_TEXT_LENGTH) {
    errors.push({ field: 'announcement.buttonText', message: `buttonText must be text, ${MAX_ANNOUNCEMENT_BUTTON_TEXT_LENGTH} characters or fewer.` });
  }
  // Empty string is explicitly allowed (no button configured) —
  // otherwise the exact same relative-path-or-mailto/tel allowlist
  // validateHeroHref() already enforces for the hero's own CTAs,
  // reused here rather than re-invented, so an admin-supplied
  // absolute URL (including a javascript: scheme) can never reach
  // this field either.
  if (typeof v.buttonUrl !== 'string' || (v.buttonUrl !== '' && !HERO_HREF_PATTERN.test(v.buttonUrl))) {
    errors.push({ field: 'announcement.buttonUrl', message: 'buttonUrl must be empty, a relative site path (starting with /), or a mailto:/tel: link.' });
  }
  if (typeof v.dismissible !== 'boolean') {
    errors.push({ field: 'announcement.dismissible', message: 'dismissible must be true or false.' });
  }

  if (errors.length > errorCountBefore) return undefined;
  return {
    enabled: v.enabled as boolean,
    type: v.type as AnnouncementType,
    title: (v.title as string).trim(),
    message: (v.message as string).trim(),
    buttonText: (v.buttonText as string).trim(),
    buttonUrl: v.buttonUrl as string,
    dismissible: v.dismissible as boolean,
  };
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

const MAX_AI_GATEWAY_COST_CAP_USD_MICROS = 1_000_000; // $1.00 per call — well above any real single-call cost with today's models, a safety ceiling against a fat-fingered config value, not a realistic day-to-day figure
const MAX_AI_GATEWAY_BUDGET_USD_MICROS = 10_000_000_000; // $10,000 — same "safety ceiling against a typo" reasoning, not a recommended real budget

function validateAiGatewayCostCap(value: unknown, errors: SettingsValidationError[]): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_AI_GATEWAY_COST_CAP_USD_MICROS) {
    errors.push({ field: 'aiGatewayCostCapUsdMicros', message: `aiGatewayCostCapUsdMicros must be a whole number of USD micros between 1 and ${MAX_AI_GATEWAY_COST_CAP_USD_MICROS}.` });
    return undefined;
  }
  return value;
}

function validateAiGatewayBudget(value: unknown, fieldName: string, errors: SettingsValidationError[]): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_AI_GATEWAY_BUDGET_USD_MICROS) {
    errors.push({ field: fieldName, message: `${fieldName} must be a whole number of USD micros between 1 and ${MAX_AI_GATEWAY_BUDGET_USD_MICROS}, or null to leave unconfigured.` });
    return undefined;
  }
  return value;
}

/** Version 5.0 Milestone 1.2 (Task 1) — {providerName: budgetOrNull, ...}. Every provider name must be a known one (services/ai/providerRegistry.ts's registered set) and every value must independently pass the same rule as a single provider budget. */
function validateAiGatewayProviderBudgets(value: unknown, errors: SettingsValidationError[]): Record<string, number | null> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push({ field: 'aiGatewayProviderBudgetsUsdMicros', message: 'aiGatewayProviderBudgetsUsdMicros must be an object of provider name to budget (or null).' });
    return undefined;
  }
  const result: Record<string, number | null> = {};
  for (const [provider, budget] of Object.entries(value as Record<string, unknown>)) {
    if (budget === null) {
      result[provider] = null;
      continue;
    }
    if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1 || budget > MAX_AI_GATEWAY_BUDGET_USD_MICROS) {
      errors.push({ field: `aiGatewayProviderBudgetsUsdMicros.${provider}`, message: `Budget for provider "${provider}" must be a whole number of USD micros between 1 and ${MAX_AI_GATEWAY_BUDGET_USD_MICROS}, or null.` });
      return undefined;
    }
    result[provider] = budget;
  }
  return result;
}

function validateAiGatewayRetentionStorageMode(value: unknown, errors: SettingsValidationError[]): AiRetentionStorageMode | undefined {
  if (typeof value !== 'string' || !(VALID_RETENTION_STORAGE_MODES as readonly string[]).includes(value)) {
    errors.push({ field: 'aiGatewayRetentionStorageMode', message: `aiGatewayRetentionStorageMode must be one of: ${VALID_RETENTION_STORAGE_MODES.join(', ')}.` });
    return undefined;
  }
  return value as AiRetentionStorageMode;
}

function validateAiGatewayRetentionDays(value: unknown, errors: SettingsValidationError[]): number | null | undefined {
  if (!(VALID_RETENTION_DAYS as readonly (number | null)[]).includes(value as number | null)) {
    errors.push({ field: 'aiGatewayRetentionDays', message: `aiGatewayRetentionDays must be one of: ${VALID_RETENTION_DAYS.map((d) => d ?? 'null (forever)').join(', ')}.` });
    return undefined;
  }
  return value as number | null;
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
  heroContent: 'hero_content',
  announcement: 'announcement',
  defaultMaxDownloads: 'default_max_downloads',
  defaultDownloadExpiresDays: 'default_download_expires_days',
  emailSenderName: 'email_sender_name',
  emailReplyTo: 'email_reply_to',
  emailTemplateEnabled: 'email_template_enabled',
  campaignRecipientCap: 'campaign_recipient_cap',
  aiGatewayCostCapUsdMicros: 'ai_gateway_cost_cap_usd_micros',
  aiGatewayDailyBudgetUsdMicros: 'ai_gateway_daily_budget_usd_micros',
  aiGatewayMonthlyBudgetUsdMicros: 'ai_gateway_monthly_budget_usd_micros',
  aiGatewayProviderBudgetsUsdMicros: 'ai_gateway_provider_budgets_usd_micros',
  aiGatewayPlatformBudgetUsdMicros: 'ai_gateway_platform_budget_usd_micros',
  aiGatewayRetentionStorageMode: 'ai_gateway_retention_storage_mode',
  aiGatewayRetentionDays: 'ai_gateway_retention_days',
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
      case 'hero_content':
        value = validateHeroContent(rawValue, errors);
        break;
      case 'announcement':
        value = validateAnnouncement(rawValue, errors);
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
      case 'ai_gateway_cost_cap_usd_micros':
        value = validateAiGatewayCostCap(rawValue, errors);
        break;
      case 'ai_gateway_daily_budget_usd_micros':
        value = validateAiGatewayBudget(rawValue, 'aiGatewayDailyBudgetUsdMicros', errors);
        break;
      case 'ai_gateway_monthly_budget_usd_micros':
        value = validateAiGatewayBudget(rawValue, 'aiGatewayMonthlyBudgetUsdMicros', errors);
        break;
      case 'ai_gateway_provider_budgets_usd_micros':
        value = validateAiGatewayProviderBudgets(rawValue, errors);
        break;
      case 'ai_gateway_platform_budget_usd_micros':
        value = validateAiGatewayBudget(rawValue, 'aiGatewayPlatformBudgetUsdMicros', errors);
        break;
      case 'ai_gateway_retention_storage_mode':
        value = validateAiGatewayRetentionStorageMode(rawValue, errors);
        break;
      case 'ai_gateway_retention_days':
        value = validateAiGatewayRetentionDays(rawValue, errors);
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

// ============================================================
// AI Gateway diagnostics — Version 5.0 Milestone 1 (basic secret/usage
// status), expanded into a full AI Operations Dashboard in Version 5.0
// Milestone 1.1 (see docs/v5.0-milestone-1.1-engineering-report.md).
// Every figure below is derived from real ai_usage_log rows and the
// static routingConfig.ts table — nothing here is a synthetic ping or
// a fabricated metric. Per the founder's explicit decision, "health"
// is derived from real call history only (no scheduled synthetic
// ping — see the engineering report's Task 3 section for why), and
// daily/monthly budgets are warning-only figures, never enforced.
// ============================================================

export type AiGatewayHealthStatus = 'healthy' | 'warning' | 'offline';

export interface AiGatewayRoutingSnapshot {
  feature: string;
  primaryProvider: string;
  primaryModel: string;
  fallbackProvider: string | null;
  fallbackModel: string | null;
}

export type AiGatewayBudgetStatus = 'healthy' | 'near_limit' | 'blocking';

export interface AiGatewayDiagnostics {
  openAiConfigured: SettingsField<boolean>;
  healthStatus: SettingsField<AiGatewayHealthStatus>;
  healthReason: SettingsField<string>;
  lastSuccessfulCallAt: SettingsField<string | null>;
  lastFailedCallAt: SettingsField<string | null>;
  consecutiveFailures: SettingsField<number>;
  avgLatencyMs: SettingsField<number | null>;
  fastestLatencyMs: SettingsField<number | null>;
  slowestLatencyMs: SettingsField<number | null>;
  callsToday: SettingsField<number>;
  callsLast7d: SettingsField<number>;
  callsLast30d: SettingsField<number>;
  callsTotal: SettingsField<number>;
  costTodayUsdMicros: SettingsField<number>;
  costLast30dUsdMicros: SettingsField<number>;
  costLifetimeUsdMicros: SettingsField<number>;
  successRatePercent30d: SettingsField<number | null>;
  failureRatePercent30d: SettingsField<number | null>;
  routing: SettingsField<AiGatewayRoutingSnapshot[]>;
  costCapUsdMicros: SettingsField<number>;
  dailyBudgetUsdMicros: SettingsField<number | null>;
  monthlyBudgetUsdMicros: SettingsField<number | null>;
  providerBudgetsUsdMicros: SettingsField<Record<string, number | null>>;
  defaultProviderBudgetUsdMicros: SettingsField<number | null>;
  platformBudgetUsdMicros: SettingsField<number | null>;
  lastErrorMessage: SettingsField<string | null>;
  lastErrorAt: SettingsField<string | null>;
  warnings: SettingsField<string[]>;

  // ============================================================
  // Version 5.0 Milestone 1.2 (AI Governance & Safety), Task 7 — the
  // AI Governance Dashboard's fields. classificationDistribution/
  // providerDistribution/sensitivePromptCount/maskedPromptCount/
  // budgetBlocks/policyViolations/oldest+newestStoredPromptAt are
  // computed by services/admin/aiUsageService.ts's
  // getAiGovernanceSummary() — the same module that already owns every
  // other ai_usage_log aggregate query (Milestone 1.1's analytics
  // endpoint), rather than a second, independent copy of that SQL
  // living here.
  // ============================================================
  policyStatus: SettingsField<{ version: string; classifications: string[] }>;
  retentionStatus: SettingsField<{ storageMode: AiRetentionStorageMode; retentionDays: number | null; encryptionAvailable: boolean }>;
  budgetStatus: SettingsField<AiGatewayBudgetStatus>;
  classificationDistribution30d: SettingsField<{ label: string; value: number }[]>;
  providerDistribution30d: SettingsField<{ label: string; value: number }[]>;
  sensitivePromptCount30d: SettingsField<number>;
  maskedPromptCount30d: SettingsField<number>;
  budgetBlocks30d: SettingsField<number>;
  policyViolations30d: SettingsField<number>;
  retentionCleanupLastRunAt: SettingsField<string | null>;
  retentionCleanupTotalPurged: SettingsField<number>;
  oldestStoredPromptAt: SettingsField<string | null>;
  newestStoredPromptAt: SettingsField<string | null>;
}

function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

async function getAiGatewayDiagnostics(env: Env): Promise<AiGatewayDiagnostics> {
  const openAiConfigured = typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.length > 0;
  const [budget, retention, encryptionAvailable, governance] = await Promise.all([
    readAiGatewayBudgetConfig(env),
    readAiGatewayRetentionConfig(env),
    isEncryptionAvailable(env),
    getAiGovernanceSummary(env),
  ]);

  const [today, last7d, last30d, lifetime, recentRows, lastFailedRow, lastSuccessRow, costCapRejections7d, rateLimitMentions7d] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd_micros), 0) AS cost FROM ai_usage_log WHERE date(created_at) = date('now')`).first<{ calls: number; cost: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS calls FROM ai_usage_log WHERE created_at > datetime('now', '-7 days')`).first<{ calls: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd_micros), 0) AS cost, COALESCE(SUM(succeeded), 0) AS successes,
              AVG(latency_ms) AS avgLatency, MIN(latency_ms) AS minLatency, MAX(latency_ms) AS maxLatency
       FROM ai_usage_log WHERE created_at > datetime('now', '-30 days')`
    ).first<{ calls: number; cost: number; successes: number; avgLatency: number | null; minLatency: number | null; maxLatency: number | null }>(),
    env.DB.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd_micros), 0) AS cost FROM ai_usage_log`).first<{ calls: number; cost: number }>(),
    // Most recent calls, newest first — used to derive the true
    // consecutive-failure streak (stops at the first success) and the
    // single latest call's latency (for spike detection). 50 is a
    // generous cap; a real streak this long would already have
    // tripped the health status well before it was reached.
    env.DB.prepare(`SELECT succeeded, latency_ms FROM ai_usage_log ORDER BY id DESC LIMIT 50`).all<{ succeeded: number; latency_ms: number }>(),
    env.DB.prepare(`SELECT error_message, created_at FROM ai_usage_log WHERE succeeded = 0 ORDER BY id DESC LIMIT 1`).first<{ error_message: string | null; created_at: string }>(),
    env.DB.prepare(`SELECT created_at FROM ai_usage_log WHERE succeeded = 1 ORDER BY id DESC LIMIT 1`).first<{ created_at: string }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM ai_usage_log WHERE succeeded = 0 AND created_at > datetime('now', '-7 days') AND error_message LIKE '%cost cap%'`).first<{ c: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM ai_usage_log WHERE succeeded = 0 AND created_at > datetime('now', '-7 days') AND (error_message LIKE '%429%' OR error_message LIKE '%rate limit%')`
    ).first<{ c: number }>(),
  ]);

  let consecutiveFailures = 0;
  for (const row of recentRows.results) {
    if (row.succeeded === 0) consecutiveFailures++;
    else break;
  }
  const latestLatencyMs = recentRows.results[0]?.latency_ms ?? null;

  const callsTotal = lifetime?.calls ?? 0;
  const callsLast30d = last30d?.calls ?? 0;
  const successRatePercent30d = callsLast30d > 0 ? Math.round(((last30d!.successes / callsLast30d) * 100 + Number.EPSILON) * 10) / 10 : null;
  const failureRatePercent30d = successRatePercent30d === null ? null : Math.round((100 - successRatePercent30d) * 10) / 10;
  const avgLatencyMs = last30d?.avgLatency != null ? Math.round(last30d.avgLatency) : null;

  const routing: AiGatewayRoutingSnapshot[] = Object.entries(getAllRoutingConfig()).map(([feature, candidates]) => ({
    feature,
    primaryProvider: candidates[0]?.provider ?? 'unconfigured',
    primaryModel: candidates[0]?.model ?? 'unconfigured',
    fallbackProvider: candidates[1]?.provider ?? null,
    fallbackModel: candidates[1]?.model ?? null,
  }));

  const warnings: string[] = [];
  if (!openAiConfigured) warnings.push('OpenAI API key is not configured — the Gateway cannot serve any request.');
  if (consecutiveFailures >= 3) warnings.push(`${consecutiveFailures} consecutive AI Gateway calls have failed.`);
  if (failureRatePercent30d !== null && failureRatePercent30d > 20) warnings.push(`Failure rate over the last 30 days is ${failureRatePercent30d}%.`);
  if ((costCapRejections7d?.c ?? 0) > 0) warnings.push(`${costCapRejections7d!.c} call(s) were refused for exceeding the configured cost cap in the past 7 days.`);
  if ((rateLimitMentions7d?.c ?? 0) > 0) warnings.push(`OpenAI appears to be rate-limiting this application (${rateLimitMentions7d!.c} recent failure(s) mention rate limits).`);
  if (avgLatencyMs !== null && latestLatencyMs !== null && latestLatencyMs > Math.max(avgLatencyMs * 3, 5000)) {
    warnings.push(`Latest call latency (${latestLatencyMs}ms) is far above the 30-day average (${avgLatencyMs}ms).`);
  }
  if (budget.dailyBudgetUsdMicros !== null && (today?.cost ?? 0) >= budget.dailyBudgetUsdMicros * 0.8) {
    warnings.push(`Today's spend (${formatUsd(today?.cost ?? 0)}) is approaching or over the configured daily budget (${formatUsd(budget.dailyBudgetUsdMicros)}).`);
  }
  if (budget.monthlyBudgetUsdMicros !== null && callsLast30d > 0 && (last30d?.cost ?? 0) >= budget.monthlyBudgetUsdMicros * 0.8) {
    warnings.push(`Last 30 days' spend (${formatUsd(last30d?.cost ?? 0)}) is approaching or over the configured monthly budget (${formatUsd(budget.monthlyBudgetUsdMicros)}).`);
  }
  // Version 5.0 Milestone 1.2 — budgets now BLOCK (Task 1), so a
  // recent block is itself worth surfacing prominently, distinct from
  // the "approaching" warnings above.
  if (governance.budgetBlocks30d > 0) {
    warnings.push(`${governance.budgetBlocks30d} AI Gateway call(s) were blocked by budget enforcement in the last 30 days — no provider was contacted for these.`);
  }
  if (governance.policyViolations30d > 0) {
    warnings.push(`${governance.policyViolations30d} AI Gateway call(s) were blocked by provider policy in the last 30 days.`);
  }

  let budgetStatus: AiGatewayBudgetStatus = 'healthy';
  if (governance.budgetBlocks30d > 0) budgetStatus = 'blocking';
  else if (
    (budget.dailyBudgetUsdMicros !== null && (today?.cost ?? 0) >= budget.dailyBudgetUsdMicros * 0.8) ||
    (budget.monthlyBudgetUsdMicros !== null && (last30d?.cost ?? 0) >= budget.monthlyBudgetUsdMicros * 0.8)
  ) {
    budgetStatus = 'near_limit';
  }

  let healthStatus: AiGatewayHealthStatus;
  let healthReason: string;
  if (!openAiConfigured) {
    healthStatus = 'offline';
    healthReason = 'OpenAI API key is not configured.';
  } else if (consecutiveFailures >= 3) {
    healthStatus = 'offline';
    healthReason = `${consecutiveFailures} consecutive calls have failed.`;
  } else if (callsTotal === 0) {
    healthStatus = 'warning';
    healthReason = 'No AI Gateway activity has been recorded yet.';
  } else if (warnings.length > 0) {
    healthStatus = 'warning';
    healthReason = warnings[0];
  } else {
    healthStatus = 'healthy';
    healthReason = 'All recent AI Gateway calls are succeeding normally.';
  }

  return {
    openAiConfigured: field(openAiConfigured, 'secret', false),
    healthStatus: field(healthStatus, 'derived', false),
    healthReason: field(healthReason, 'derived', false),
    lastSuccessfulCallAt: field(lastSuccessRow?.created_at ?? null, 'derived', false),
    lastFailedCallAt: field(lastFailedRow?.created_at ?? null, 'derived', false),
    consecutiveFailures: field(consecutiveFailures, 'derived', false),
    avgLatencyMs: field(avgLatencyMs, 'derived', false),
    fastestLatencyMs: field(last30d?.minLatency ?? null, 'derived', false),
    slowestLatencyMs: field(last30d?.maxLatency ?? null, 'derived', false),
    callsToday: field(today?.calls ?? 0, 'derived', false),
    callsLast7d: field(last7d?.calls ?? 0, 'derived', false),
    callsLast30d: field(callsLast30d, 'derived', false),
    callsTotal: field(callsTotal, 'derived', false),
    costTodayUsdMicros: field(today?.cost ?? 0, 'derived', false),
    costLast30dUsdMicros: field(last30d?.cost ?? 0, 'derived', false),
    costLifetimeUsdMicros: field(lifetime?.cost ?? 0, 'derived', false),
    successRatePercent30d: field(successRatePercent30d, 'derived', false),
    failureRatePercent30d: field(failureRatePercent30d, 'derived', false),
    routing: field(routing, 'derived', false),
    costCapUsdMicros: field(budget.perRequestCapUsdMicros, 'site_settings', false),
    dailyBudgetUsdMicros: field(budget.dailyBudgetUsdMicros, 'site_settings', false),
    monthlyBudgetUsdMicros: field(budget.monthlyBudgetUsdMicros, 'site_settings', false),
    providerBudgetsUsdMicros: field(budget.providerBudgetsUsdMicros, 'site_settings', false),
    defaultProviderBudgetUsdMicros: field(budget.defaultProviderBudgetUsdMicros, 'derived', false),
    platformBudgetUsdMicros: field(budget.platformBudgetUsdMicros, 'site_settings', false),
    lastErrorMessage: field(lastFailedRow?.error_message ?? null, 'derived', false),
    lastErrorAt: field(lastFailedRow?.created_at ?? null, 'derived', false),
    warnings: field(warnings, 'derived', false),

    policyStatus: field({ version: POLICY_VERSION, classifications: [...SENSITIVITY_CLASSIFICATIONS] }, 'derived', false),
    retentionStatus: field({ storageMode: retention.storageMode, retentionDays: retention.retentionDays, encryptionAvailable }, 'site_settings', false),
    budgetStatus: field(budgetStatus, 'derived', false),
    classificationDistribution30d: field(governance.classificationDistribution30d, 'derived', false),
    providerDistribution30d: field(governance.providerDistribution30d, 'derived', false),
    sensitivePromptCount30d: field(governance.sensitivePromptCount30d, 'derived', false),
    maskedPromptCount30d: field(governance.maskedPromptCount30d, 'derived', false),
    budgetBlocks30d: field(governance.budgetBlocks30d, 'derived', false),
    policyViolations30d: field(governance.policyViolations30d, 'derived', false),
    retentionCleanupLastRunAt: field(governance.retentionCleanupLastRunAt, 'derived', false),
    retentionCleanupTotalPurged: field(governance.retentionCleanupTotalPurged, 'derived', false),
    oldestStoredPromptAt: field(governance.oldestStoredPromptAt, 'derived', false),
    newestStoredPromptAt: field(governance.newestStoredPromptAt, 'derived', false),
  };
}

export interface SettingsStatusView {
  payment: PaymentDiagnostics;
  email: EmailDiagnostics;
  system: SystemDiagnostics;
  aiGateway: AiGatewayDiagnostics;
}

export async function getSettingsStatus(env: Env, request: Request): Promise<SettingsStatusView> {
  const [payment, email, system, aiGateway] = await Promise.all([
    getPaymentDiagnostics(env),
    getEmailDiagnostics(env),
    getSystemDiagnostics(env, request),
    getAiGatewayDiagnostics(env),
  ]);
  return { payment, email, system, aiGateway };
}
