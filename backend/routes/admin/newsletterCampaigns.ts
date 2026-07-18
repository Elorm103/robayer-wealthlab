/**
 * /api/admin/newsletter/campaigns/* — Version 2.1 Phase 6 (Newsletter
 * Campaigns). See docs/v2.1-phase6-design.md. Thin HTTP layer only —
 * all real logic lives in services/campaignService.ts.
 *
 * Role gating, per the approved design's Decision 2: viewing, drafting,
 * editing, and test-sending are open to `editor`/`super_admin` (matching
 * Products/Resources/Blog's content-management convention). Send and
 * Resume — the two actions that reach real subscribers — are
 * `super_admin`-only, given the blast radius.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import type { RouteParams } from '../../worker/index';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import * as campaignService from '../../services/campaignService';
import type { CampaignInput } from '../../services/campaignService';

const EDITOR_ROLES = ['super_admin', 'editor'] as const;
const SUPER_ADMIN_ONLY = ['super_admin'] as const;

function actionContext(request: Request) {
  return { ip: request.headers.get('CF-Connecting-IP'), userAgent: request.headers.get('User-Agent') };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

function parseCampaignInput(body: Record<string, unknown>): CampaignInput {
  return {
    subject: typeof body.subject === 'string' ? body.subject : '',
    body: typeof body.body === 'string' ? body.body : '',
  };
}

function validationErrorResponse(errors: campaignService.CampaignValidationError[]): Response {
  const responseBody = { success: false, error: { code: 'VALIDATION_ERROR', message: errors[0]?.message ?? 'Validation failed.' }, fields: errors };
  return new Response(JSON.stringify(responseBody), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

function idFromParams(params: RouteParams): number | null {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function handleListCampaigns(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;

  return jsonSuccess(await campaignService.listCampaigns(env));
}

export async function handleGetCampaign(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;

  const id = idFromParams(params);
  if (!id) return jsonError('NOT_FOUND', 'This campaign could not be found.');

  const campaign = await campaignService.getCampaignById(env, id);
  if (!campaign) return jsonError('NOT_FOUND', 'This campaign could not be found.');
  return jsonSuccess(campaign);
}

export async function handleSubscribedCount(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;

  return jsonSuccess({ subscribedCount: await campaignService.getSubscribedCount(env) });
}

export async function handleCreateCampaign(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');
  const input = parseCampaignInput(body);

  const errors = campaignService.validateCampaignInput(input);
  if (errors.length > 0) return validationErrorResponse(errors);

  const campaign = await campaignService.createCampaign(env, logger, auth.auth.adminId, input);
  return jsonSuccess(campaign, 201);
}

export async function handleUpdateCampaign(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = idFromParams(params);
  if (!id) return jsonError('NOT_FOUND', 'This campaign could not be found.');

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');
  const input = parseCampaignInput(body);

  const errors = campaignService.validateCampaignInput(input);
  if (errors.length > 0) return validationErrorResponse(errors);

  const result = await campaignService.updateCampaign(env, logger, auth.auth.adminId, id, input);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This campaign could not be found.');
    return jsonError('CAMPAIGN_NOT_DRAFT', 'Only a draft campaign can be edited.');
  }
  return jsonSuccess(result.campaign);
}

export async function handleDeleteCampaign(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = idFromParams(params);
  if (!id) return jsonError('NOT_FOUND', 'This campaign could not be found.');

  const result = await campaignService.deleteCampaign(env, logger, auth.auth.adminId, id);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This campaign could not be found.');
    return jsonError('CAMPAIGN_NOT_DRAFT', 'Only a draft campaign can be deleted.');
  }
  return jsonSuccess({ deleted: true });
}

export async function handleTestCampaign(request: Request, env: Env, logger: Logger, params: RouteParams): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, EDITOR_ROLES);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = idFromParams(params);
  if (!id) return jsonError('NOT_FOUND', 'This campaign could not be found.');

  const body = await readJsonBody(request);
  const testEmails = body && Array.isArray(body.testEmails) ? body.testEmails.filter((e): e is string => typeof e === 'string') : [];

  const result = await campaignService.sendTestEmail(env, logger, auth.auth.adminId, id, testEmails);
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This campaign could not be found.');
    return jsonError('VALIDATION_ERROR', 'Provide at least one valid test email address.');
  }
  return jsonSuccess(result);
}

export async function handleSendCampaign(request: Request, env: Env, logger: Logger, params: RouteParams, ctx: ExecutionContext): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = idFromParams(params);
  if (!id) return jsonError('NOT_FOUND', 'This campaign could not be found.');

  const result = await campaignService.sendCampaign(env, logger, auth.auth.adminId, id, ctx, actionContext(request));
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return jsonError('NOT_FOUND', 'This campaign could not be found.');
      case 'not_draft':
        return jsonError('CAMPAIGN_ALREADY_SENDING', 'This campaign has already been sent or is currently sending.');
      case 'test_required':
        return jsonError('TEST_REQUIRED', 'Send a test email before sending this campaign to subscribers.');
      case 'no_recipients':
        return jsonError('NO_RECIPIENTS', 'There are no subscribed recipients to send to.');
      case 'cap_exceeded':
        return jsonError(
          'RECIPIENT_CAP_EXCEEDED',
          `This campaign would reach ${result.subscribedCount} subscribers, above the configured safety cap of ${result.cap}. Raise the cap in Settings, or contact your developer about moving to queue-based sending — see docs/v2.1-phase6-design.md.`
        );
    }
  }
  return jsonSuccess(result);
}

export async function handleResumeCampaign(request: Request, env: Env, logger: Logger, params: RouteParams, ctx: ExecutionContext): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const id = idFromParams(params);
  if (!id) return jsonError('NOT_FOUND', 'This campaign could not be found.');

  const result = await campaignService.resumeCampaign(env, logger, auth.auth.adminId, id, ctx, actionContext(request));
  if (!result.ok) {
    if (result.reason === 'not_found') return jsonError('NOT_FOUND', 'This campaign could not be found.');
    return jsonError('CAMPAIGN_NOT_SENDING', 'Only a campaign currently sending can be resumed.');
  }
  return jsonSuccess(result);
}
