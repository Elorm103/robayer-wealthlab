/**
 * Admin password strength policy — Version 2.1 Phase 3 (Identity &
 * Security). One shared `validatePasswordStrength()`, applied
 * identically at change-password and reset-password (and, in a future
 * phase, admin creation) — not three separately-maintained copies of
 * the same rule.
 *
 * Minimum length over composition rules: NIST 800-63B now recommends
 * length as the primary strength signal over "must contain 1
 * uppercase/number/symbol" box-ticking, which mostly produces
 * predictable substitutions (`Password1!`) rather than real entropy.
 * 12 characters matches the real strength worth defending given this
 * project's PBKDF2-100k-iteration hashing (see passwordHash.ts).
 */

const MIN_LENGTH = 12;
const MAX_LENGTH = 256; // matches authService.ts's MAX_PASSWORD_LENGTH bound

/** A small deny-list of the most common weak patterns — not exhaustive, just the obvious, high-frequency ones a length-only rule would otherwise let through. */
const WEAK_PATTERNS = [/^password/i, /^12345678/, /^qwerty/i, /^letmein/i, /^admin/i, /^robayer/i, /^wealthlab/i];

export interface PasswordStrengthContext {
  /** Rejects a password matching the account's own email local-part (case-insensitive) — a common, easily-guessed choice. */
  email?: string;
}

export interface PasswordValidationError {
  field: 'newPassword';
  message: string;
}

export function validatePasswordStrength(password: unknown, context: PasswordStrengthContext = {}): PasswordValidationError[] {
  const errors: PasswordValidationError[] = [];

  if (typeof password !== 'string' || password.length === 0) {
    return [{ field: 'newPassword', message: 'A new password is required.' }];
  }

  if (password.length < MIN_LENGTH) {
    errors.push({ field: 'newPassword', message: `Password must be at least ${MIN_LENGTH} characters.` });
  }
  if (password.length > MAX_LENGTH) {
    errors.push({ field: 'newPassword', message: `Password must be ${MAX_LENGTH} characters or fewer.` });
  }

  if (WEAK_PATTERNS.some((pattern) => pattern.test(password))) {
    errors.push({ field: 'newPassword', message: 'This password is too easy to guess. Please choose something less common.' });
  }

  if (context.email) {
    const localPart = context.email.split('@')[0]?.toLowerCase();
    if (localPart && localPart.length >= 3 && password.toLowerCase().includes(localPart)) {
      errors.push({ field: 'newPassword', message: 'Password must not contain your email address.' });
    }
  }

  return errors;
}
