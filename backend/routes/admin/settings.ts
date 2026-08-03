/**
 * /api/admin/settings/* — Version 2.1 Phase 5 (Settings). See
 * docs/v2.1-phase5-design.md. Thin HTTP layer only, per this
 * project's established routes/ convention — all real logic lives in
 * `services/admin/settingsService.ts`.
 *
 * Every route here requires `super_admin` — reads as well as writes,
 * the same posture Phase 4's Users module already established, for
 * the same reason: payment/email operational data and the ability to
 * flip maintenance mode are not general content `editor`/`support`
 * need visibility into.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { jsonError, jsonSuccess } from '../../utils/responses';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import { requireCsrf } from '../../middleware/csrf';
import * as settingsService from '../../services/admin/settingsService';
import { callAi, AiBudgetExceededError, AiPolicyViolationError } from '../../services/ai/aiGateway';
import * as auditService from '../../services/admin/auditService';

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

function validationErrorResponse(errors: settingsService.SettingsValidationError[]): Response {
  const body = { success: false, error: { code: 'VALIDATION_ERROR', message: errors[0]?.message ?? 'Validation failed.' }, fields: errors };
  return new Response(JSON.stringify(body), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

export async function handleGetSettings(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;

  const settings = await settingsService.getEditableSettings(env);
  return jsonSuccess(settings);
}

export async function handleUpdateSettings(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  const body = await readJsonBody(request);
  if (!body) return jsonError('VALIDATION_ERROR', 'Invalid request body.');

  const result = await settingsService.updateSettings(env, logger, auth.auth.adminId, body, actionContext(request));
  if (!result.ok) return validationErrorResponse(result.errors);

  return jsonSuccess({ updated: true });
}

export async function handleSettingsStatus(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;

  const status = await settingsService.getSettingsStatus(env, request);
  return jsonSuccess(status);
}

/**
 * Version 5.0 Milestone 1 — the one real way to verify the AI Gateway
 * works end-to-end against a live provider (see
 * docs/v5.0-implementation-roadmap.md's Milestone 1 "Verification
 * requirements": "a manual internal test call proves routing,
 * fallback, and usage-logging all work correctly"). Calls `callAi()`
 * exactly like any future real feature would — never OpenAI directly
 * — with a fixed, trivial, cheap prompt under the
 * 'internal.gateway-diagnostic' feature key (see
 * services/ai/routingConfig.ts). A real, small cost is incurred each
 * time this is invoked, so it is CSRF-protected and audit-logged like
 * any other deliberate admin action with a side effect, not exposed
 * as a free-standing GET.
 */
export async function handleAiGatewayTest(request: Request, env: Env, logger: Logger): Promise<Response> {
  const auth = await requireAuth(request, env, logger);
  if (!auth.ok) return auth.response;
  const roleFailure = await requireRole(request, env, logger, auth.auth, SUPER_ADMIN_ONLY);
  if (roleFailure) return roleFailure;
  const csrfFailure = await requireCsrf(request, env, logger, auth.auth);
  if (csrfFailure) return csrfFailure;

  try {
    // Version 5.0 Milestone 1.1 — uses the stored, versioned
    // 'internal.gateway-diagnostic' prompt (services/ai/aiGateway.ts's
    // promptKey resolution) rather than raw inline text. Version 5.0
    // Milestone 1.2 — `maxCostUsdMicros` is deliberately OMITTED here:
    // the Gateway itself now inherits the platform-configured default
    // cost cap automatically (Task 2's "mandatory default budgets"),
    // so this route no longer needs to look it up and pass it through
    // by hand. `classification: 'INTERNAL'` — this is an internal
    // operational health check, never customer or business data.
    const result = await callAi(env, logger, {
      feature: 'internal.gateway-diagnostic',
      actorType: 'admin',
      actorId: auth.auth.adminId,
      sessionId: auth.auth.sessionId,
      classification: 'INTERNAL',
      promptKey: 'internal.gateway-diagnostic',
      userPrompt: 'Respond now.',
    });

    await auditService.record(env, logger, {
      actorType: 'admin',
      actorId: auth.auth.adminId,
      action: 'ai_gateway.diagnostic_test_run',
      entityType: 'ai_usage_log',
      entityId: null,
      metadata: { ...actionContext(request), provider: result.provider, model: result.model, succeeded: true },
    });

    return jsonSuccess({
      succeeded: true,
      content: result.content,
      provider: result.provider,
      model: result.model,
      costUsdMicros: result.costUsdMicros,
      latencyMs: result.latencyMs,
      fallbackUsed: result.fallbackUsed,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown AI Gateway error';

    await auditService.record(env, logger, {
      actorType: 'admin',
      actorId: auth.auth.adminId,
      action: 'ai_gateway.diagnostic_test_run',
      entityType: 'ai_usage_log',
      entityId: null,
      metadata: { ...actionContext(request), succeeded: false, error: errorMessage },
    });

    // Version 5.0 Milestone 1.2 — a budget/policy refusal is a
    // distinct, expected outcome (governance working as designed), not
    // an upstream/config failure — surfaced with its own error code so
    // an admin (or a future caller) can tell "OpenAI is down" apart
    // from "the Gateway refused this on purpose."
    if (err instanceof AiBudgetExceededError) return jsonError('AI_GATEWAY_BUDGET_EXCEEDED', errorMessage);
    if (err instanceof AiPolicyViolationError) return jsonError('AI_GATEWAY_POLICY_VIOLATION', errorMessage);
    return jsonError('AI_GATEWAY_ERROR', errorMessage);
  }
}
