/**
 * Model Routing Configuration — Version 5.0 Milestone 1. The one place
 * a `feature` key resolves to which provider(s)/model(s) may serve it,
 * in priority order — see docs/v5.0-ai-gateway.md §5 (Model routing
 * and fallback). No feature-level code ever names a provider or model
 * directly; it only ever names its own `feature` key, and this file
 * decides what that means. Upgrading a model (or reordering providers
 * once a second one exists) is a one-line change here, never a change
 * to any calling code — this is the concrete mechanism behind this
 * milestone's "keep provider configuration centralized" requirement.
 *
 * Milestone 1 ships with exactly one entry: the internal diagnostic
 * call used to verify the Gateway end-to-end (see
 * routes/admin/settings.ts's AI Gateway diagnostic section). No real
 * customer- or admin-facing AI feature exists yet — those are later
 * milestones (docs/v5.0-implementation-roadmap.md), and each one adds
 * its own `feature` key here when it ships, never before.
 */

export interface RoutingCandidate {
  provider: string;
  model: string;
}

const ROUTING_TABLE: Record<string, RoutingCandidate[]> = {
  'internal.gateway-diagnostic': [{ provider: 'openai', model: 'gpt-4o-mini' }],
};

export function getRoutingCandidates(feature: string): RoutingCandidate[] {
  const candidates = ROUTING_TABLE[feature];
  if (!candidates || candidates.length === 0) {
    throw new Error(`No routing configuration exists for AI feature: "${feature}"`);
  }
  return candidates;
}
