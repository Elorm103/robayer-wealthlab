/**
 * Branding Service — Homepage Modernization, Part 4 (CMS Logo
 * Management). The only code that writes the `branding_*` keys in
 * `site_settings` (see `services/admin/settingsService.ts`'s header for
 * why this is a separate service rather than a seventh entry in that
 * file's `DEFAULTS`: that file's own doc comment scopes it to exactly
 * six settings from an earlier phase, and branding has a materially
 * different shape — an asset reference that must be resolved against
 * `media_assets`, not a primitive value).
 *
 * A branding "slot" (primary logo, dark-mode logo, favicon, Open Graph
 * logo, email logo, mobile app icon) stores nothing but a
 * `media_assets.id` — the asset's real file, dimensions, and alt text
 * all live in the Media Library and are resolved live on every read.
 * There is deliberately no separate "branding alt text" field: an
 * asset's `alt_text` (editable in the Media Library, matching every
 * other media consumer in this codebase) is its alt text everywhere it
 * is used, including here.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import * as auditService from './auditService';
import { getMediaById } from '../mediaService';
import type { MediaRecord } from '../mediaService';

export const BRANDING_SLOTS = ['primary', 'dark', 'favicon', 'og', 'email', 'appIcon'] as const;
export type BrandingSlot = (typeof BRANDING_SLOTS)[number];

export const SLOT_LABELS: Record<BrandingSlot, string> = {
  primary: 'Primary logo',
  dark: 'Dark-mode logo',
  favicon: 'Favicon',
  og: 'Open Graph logo',
  email: 'Email logo',
  appIcon: 'Mobile app icon',
};

/**
 * Which slots have real, live, site-wide consumption today vs. are
 * stored as a real data-model field ready for a future consumer, per
 * the explicit "future-ready... even if built more minimally" scoping.
 * Surfaced to the admin UI so it never implies a slot does something it
 * doesn't yet do.
 */
export const SLOT_IS_WIRED: Record<BrandingSlot, boolean> = {
  primary: true,
  dark: true,
  favicon: true,
  og: false, // OG tags are static per-page HTML on a non-Worker-rendered homepage; a client-side swap would never reach social-preview crawlers, which don't execute JS
  email: false, // no transactional email template currently includes a logo image
  appIcon: false, // no app manifest/PWA icon consumer exists in this codebase yet
};

const SLOT_TO_KEY: Record<BrandingSlot, string> = {
  primary: 'branding_logo_primary',
  dark: 'branding_logo_dark',
  favicon: 'branding_favicon',
  og: 'branding_logo_og',
  email: 'branding_logo_email',
  appIcon: 'branding_icon_app',
};

interface SettingsRow {
  key: string;
  value: string;
}

async function readSlotIds(env: Env): Promise<Record<BrandingSlot, number | null>> {
  const keys = BRANDING_SLOTS.map((slot) => SLOT_TO_KEY[slot]);
  const { results } = await env.DB.prepare(`SELECT key, value FROM site_settings WHERE key IN (${keys.map(() => '?').join(',')})`)
    .bind(...keys)
    .all<SettingsRow>();

  const raw = new Map<string, unknown>();
  for (const row of results) {
    try {
      raw.set(row.key, JSON.parse(row.value));
    } catch {
      // A malformed stored value falls back to "unset" rather than ever throwing.
    }
  }

  const out = {} as Record<BrandingSlot, number | null>;
  for (const slot of BRANDING_SLOTS) {
    const value = raw.get(SLOT_TO_KEY[slot]);
    out[slot] = typeof value === 'number' && Number.isInteger(value) ? value : null;
  }
  return out;
}

export interface BrandingAssignment {
  slot: BrandingSlot;
  label: string;
  wired: boolean;
  mediaAssetId: number | null;
  asset: MediaRecord | null;
  /** True when a `mediaAssetId` is stored but the asset is missing or has since been soft-deleted from the Media Library — the slot silently falls back to no logo rather than erroring, but the admin UI should flag it. */
  stale: boolean;
}

export type BrandingView = Record<BrandingSlot, BrandingAssignment>;

export async function getBranding(env: Env): Promise<BrandingView> {
  const ids = await readSlotIds(env);

  const entries = await Promise.all(
    BRANDING_SLOTS.map(async (slot): Promise<[BrandingSlot, BrandingAssignment]> => {
      const mediaAssetId = ids[slot];
      let asset: MediaRecord | null = null;
      let stale = false;

      if (mediaAssetId !== null) {
        const found = await getMediaById(env, mediaAssetId);
        if (found && !found.deletedAt) {
          asset = found;
        } else {
          stale = true;
        }
      }

      return [slot, { slot, label: SLOT_LABELS[slot], wired: SLOT_IS_WIRED[slot], mediaAssetId, asset, stale }];
    })
  );

  return Object.fromEntries(entries) as BrandingView;
}

/** Public-facing shape — just enough for the frontend to render an `<img>`/`<link>`, nothing internal (ids, filenames). Stale or unset slots resolve to `null` so the frontend can fall back to the static default already in the HTML. */
export interface PublicBrandingAsset {
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
}

export type PublicBrandingView = Record<BrandingSlot, PublicBrandingAsset | null>;

export async function getPublicBranding(env: Env): Promise<PublicBrandingView> {
  const full = await getBranding(env);
  const out = {} as PublicBrandingView;
  for (const slot of BRANDING_SLOTS) {
    const a = full[slot].asset;
    out[slot] = a ? { url: a.publicUrl, altText: a.altText, width: a.width, height: a.height } : null;
  }
  return out;
}

export interface ActionContext {
  ip: string | null;
  userAgent: string | null;
}

export type BrandingValidationError = { slot: string; message: string };
export type UpdateBrandingResult = { ok: true } | { ok: false; errors: BrandingValidationError[] };

/**
 * One PATCH covers any subset of slots at once (matching
 * `settingsService.updateSettings`'s "one changed key at a time, each
 * independently validated" posture) — a value of `null` clears the
 * slot back to "unset" (the frontend's static fallback), a number
 * assigns that `media_assets.id`, and an absent key leaves that slot
 * untouched.
 */
export async function updateBranding(
  env: Env,
  logger: Logger,
  actorId: number,
  patch: Partial<Record<BrandingSlot, number | null>>,
  context: ActionContext
): Promise<UpdateBrandingResult> {
  const errors: BrandingValidationError[] = [];
  const validated: Partial<Record<BrandingSlot, number | null>> = {};

  for (const [slotRaw, value] of Object.entries(patch)) {
    if (!(BRANDING_SLOTS as readonly string[]).includes(slotRaw)) {
      errors.push({ slot: slotRaw, message: `Unrecognized branding slot: "${slotRaw}".` });
      continue;
    }
    const slot = slotRaw as BrandingSlot;

    if (value === null) {
      validated[slot] = null;
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push({ slot, message: 'Must be a media asset ID, or null to clear.' });
      continue;
    }

    const asset = await getMediaById(env, value);
    if (!asset || asset.deletedAt) {
      errors.push({ slot, message: 'That media item could not be found.' });
      continue;
    }
    if (asset.mediaType !== 'image') {
      errors.push({ slot, message: `"${SLOT_LABELS[slot]}" must be an image, not a document.` });
      continue;
    }

    validated[slot] = value;
  }

  if (errors.length > 0) return { ok: false, errors };
  if (Object.keys(validated).length === 0) return { ok: true };

  const before = await readSlotIds(env);

  for (const [slot, newValue] of Object.entries(validated) as [BrandingSlot, number | null][]) {
    const dbKey = SLOT_TO_KEY[slot];
    await env.DB.prepare(
      `INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    )
      .bind(dbKey, JSON.stringify(newValue), actorId)
      .run();

    await auditService.record(env, logger, {
      actorType: 'admin',
      actorId,
      action: 'branding.updated',
      entityType: 'site_settings',
      entityId: null,
      metadata: { slot, before: before[slot], after: newValue, ip: context.ip, userAgent: context.userAgent },
    });
  }

  logger.info('branding.updated', { actorId, slots: Object.keys(validated) });

  return { ok: true };
}
