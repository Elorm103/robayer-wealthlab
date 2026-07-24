/**
 * /api/admin/branding — Homepage Modernization, Part 4 (CMS Logo
 * Management). Thin HTTP layer only, per this project's established
 * routes/ convention — all real logic lives in
 * services/admin/brandingService.ts.
 *
 * Role gating mirrors routes/admin/media.ts exactly: viewing is open to
 * every authenticated role, every mutation requires `editor` or
 * `super_admin` — a logo swap is a content action, not an
 * operational/security one, so it doesn't need settings.ts's
 * `super_admin`-only bar.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import * as brandingService from '../../services/admin/brandingService';
import type { BrandingAssignment } from '../../services/admin/brandingService';

const EDITOR_ROLES = ['super_admin', 'editor'] as const;

function actionContext(request: Request) {
  return { ip: request.headers.get('CF-Connecting-IP'), userAgent: request.headers.get('User-Agent') };
}

function toApiShape(a: BrandingAssignment) {
  return {
    slot: a.slot,
    label: a.label,
    wired: a.wired,
    mediaAssetId: a.mediaAssetId,
    stale: a.stale,
    asset: a.asset
      ? {
          id: a.asset.id,
          publicUrl: a.asset.publicUrl,
          thumbnailPublicUrl: a.asset.thumbnailPublicUrl,
          altText: a.asset.altText,
          title: a.asset.title,
          width: a.asset.width,
          height: a.asset.height,
          mimeType: a.asset.mimeType,
          originalFilename: a.asset.originalFilename,
        }
      : null,
  };
}

export async function handleGetBranding(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;

  const branding = await brandingService.getBranding(env);
  const shaped = Object.fromEntries(brandingService.BRANDING_SLOTS.map((slot) => [slot, toApiShape(branding[slot])]));
  return jsonSuccess(shaped);
}

export async function handleUpdateBranding(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('VALIDATION_ERROR', 'Invalid request body.');
  }
  const patch = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  const normalized: Partial<Record<brandingService.BrandingSlot, number | null>> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || typeof value === 'number') {
      normalized[key as brandingService.BrandingSlot] = value;
    }
  }

  const result = await brandingService.updateBranding(env, logger, auth.auth.adminId, normalized, actionContext(request));
  if (!result.ok) {
    const body = { success: false, error: { code: 'VALIDATION_ERROR', message: result.errors[0]?.message ?? 'Validation failed.' }, fields: result.errors };
    return new Response(JSON.stringify(body), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const branding = await brandingService.getBranding(env);
  const shaped = Object.fromEntries(brandingService.BRANDING_SLOTS.map((slot) => [slot, toApiShape(branding[slot])]));
  return jsonSuccess(shaped);
}
