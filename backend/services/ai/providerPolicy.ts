/**
 * Provider Policy Engine — Version 5.0 Milestone 1.2 (AI Governance &
 * Safety), Task 3 + Task 4. Defines the sensitivity classification
 * every AI Gateway request must declare, and which providers are
 * approved to receive each classification. Enforced inside
 * services/ai/aiGateway.ts's `callAi()`, before EVERY candidate is
 * tried — a routing-table entry that names an unapproved provider for
 * a given call's classification is skipped exactly like an
 * over-budget or provider-error candidate, never silently allowed
 * through.
 *
 * Deliberately a CODE file, not an admin-editable `site_settings`
 * value like the budget config in aiGatewayConfig.ts. Provider/data
 * classification policy is a security control, not an operational
 * tuning knob — the same reasoning this codebase already applies to
 * RBAC role lists (`SUPER_ADMIN_ONLY` constants throughout routes/) or
 * services/ai/routingConfig.ts's own routing table: reviewed,
 * committed, deployed code, not a runtime toggle a compromised admin
 * session could silently flip. A future milestone could move this to
 * an admin-editable, audit-logged surface if that becomes genuinely
 * needed — this file's `getApprovedProviders()`/
 * `isProviderApprovedForClassification()` functions are the seam
 * where that would plug in without touching aiGateway.ts itself.
 *
 * `sensitivity_classification` (this file's concept) is entirely
 * separate from the pre-existing `data_classification` column
 * (PRODUCTION/INTERNAL/DEVELOPMENT/UNKNOWN — the Version 4.9
 * platform-wide "is this real traffic" convention). Same word,
 * different question: this one asks "what KIND of sensitive
 * information does this prompt touch," not "was this a real customer
 * action."
 */

export type AiSensitivityClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'FINANCIAL' | 'PERSONAL' | 'HIGHLY_SENSITIVE';

export const SENSITIVITY_CLASSIFICATIONS: readonly AiSensitivityClassification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'FINANCIAL', 'PERSONAL', 'HIGHLY_SENSITIVE'];

export function isValidSensitivityClassification(value: unknown): value is AiSensitivityClassification {
  return typeof value === 'string' && (SENSITIVITY_CLASSIFICATIONS as readonly string[]).includes(value);
}

/**
 * Bumped by hand whenever the policy table below changes meaning —
 * recorded on every ai_usage_log row (Task 8's "Policy Version") so a
 * future audit can tell which rules were in effect for a given call
 * without guessing from its timestamp.
 */
export const POLICY_VERSION = '1.0.0';

/**
 * Default-deny: a provider not listed for a classification is not
 * approved for it. Every classification is currently restricted to
 * `['openai']` because that is the only provider this project has
 * ever reviewed and integrated — NOT because every classification has
 * been individually risk-assessed against OpenAI's own data-handling
 * terms yet. See the Milestone 1.2 Governance Report's honest caveat
 * on this point before treating this table as a completed compliance
 * review rather than a structural placeholder.
 */
const PROVIDER_POLICY: Record<AiSensitivityClassification, readonly string[]> = {
  PUBLIC: ['openai'],
  INTERNAL: ['openai'],
  CONFIDENTIAL: ['openai'],
  FINANCIAL: ['openai'],
  PERSONAL: ['openai'],
  HIGHLY_SENSITIVE: ['openai'],
};

export function getApprovedProviders(classification: AiSensitivityClassification): readonly string[] {
  return PROVIDER_POLICY[classification];
}

export function isProviderApprovedForClassification(provider: string, classification: AiSensitivityClassification): boolean {
  return PROVIDER_POLICY[classification].includes(provider);
}
