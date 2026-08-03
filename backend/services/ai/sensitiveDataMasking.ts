/**
 * Sensitive-data masking — Version 5.0 Milestone 1.2 (AI Governance &
 * Safety), Task 6. Applied to a prompt/response ONLY at the moment
 * it's about to be written to `ai_usage_log` — never to the actual
 * text sent to or received from an AI provider. Masking the real
 * outbound request would silently corrupt it; this exists purely to
 * keep secrets out of stored logs.
 *
 * This is a best-effort, regex-based safety net, not a guarantee.
 * Regex pattern matching cannot catch every possible secret shape,
 * especially anything without a recognizable prefix/structure (a bare
 * high-entropy string with no "api_key=" style label, for instance).
 * See the Milestone 1.2 Security Report's "Task 6" section for this
 * limitation stated plainly to the founder — masking materially
 * reduces the chance of a recognizable secret sitting in a log, it
 * does not eliminate it.
 */

export interface MaskResult {
  masked: string | null;
  wasMasked: boolean;
}

interface SensitivePattern {
  name: string;
  pattern: RegExp;
}

const PATTERNS: SensitivePattern[] = [
  // Provider API keys with a recognizable prefix (OpenAI-style sk-/pk-, Anthropic-style sk-ant-, Stripe-style sk_live_/sk_test_).
  { name: 'provider_api_key', pattern: /\b(sk|pk)(-ant)?[-_](live|test)?[A-Za-z0-9]{16,}\b/g },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9\-_.=]{10,}/gi },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  // key/value style secrets: api_key=..., "authToken": "...", secret-key: '...'
  { name: 'labeled_secret', pattern: /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9\-_./+]{8,}['"]?/gi },
  { name: 'password', pattern: /\bpassword\s*[:=]\s*['"]?\S{4,}['"]?/gi },
  { name: 'session_id', pattern: /\b(session[_-]?id|sessionid)\s*[:=]\s*['"]?[A-Za-z0-9\-_.]{8,}['"]?/gi },
  { name: 'cookie_header', pattern: /\bCookie:\s*[^\n]+/gi },
  { name: 'credentialed_url', pattern: /https?:\/\/[^\s/:]+:[^\s/@]+@[^\s]+/gi },
  // Card-number-shaped digit runs (13-19 digits, optionally grouped) — deliberately broad; see the header comment's false-positive caveat.
  { name: 'payment_card_like', pattern: /\b(?:\d[ -]?){13,19}\b/g },
];

/**
 * Masks every recognizable secret pattern in `text`, replacing each
 * match with `[REDACTED:<pattern-name>]` so a reviewer can still see
 * roughly what kind of thing was there without seeing the value
 * itself. Returns `wasMasked: true` if anything was found, regardless
 * of whether the caller ends up actually storing the masked text (the
 * AI Operations Dashboard's "Sensitive Prompt Count" reflects this
 * flag even for calls whose retention policy is 'never').
 */
export function maskSensitiveData(text: string | null | undefined): MaskResult {
  if (text === null || text === undefined) return { masked: null, wasMasked: false };

  let matchCount = 0;
  let result = text;
  for (const { name, pattern } of PATTERNS) {
    result = result.replace(pattern, () => {
      matchCount++;
      return `[REDACTED:${name}]`;
    });
  }
  return { masked: result, wasMasked: matchCount > 0 };
}
