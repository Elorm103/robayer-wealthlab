/**
 * Customer Authentication Service — Version 3.0.2 Milestone M1. Mirrors
 * `services/admin/authService.ts`'s proven login/logout/password-reset
 * design (see that file's own header comment), adapted for customers.
 *
 * Deliberately NOT included, per the ratified architecture's own scope
 * (docs/v3.0.2-commerce-architecture-blueprint.md's Deliverable 3
 * `customers` entity has no `failed_login_attempts`/`locked_until`
 * columns): per-account lockout tracking. Rate limiting (IP-based,
 * `middleware/rateLimit.ts`, applied in `routes/customer/auth.ts`) is
 * the ratified Security Architecture's stated mechanism for this
 * milestone — adding account lockout now would be scope not present in
 * the ratified schema. See the M1 Implementation Report's
 * Recommendations for flagging this as a candidate for a future
 * security-hardening milestone, matching admin auth's own Version 2.1
 * Phase 3 precedent.
 *
 * The timing-attack mitigation (DUMMY_PASSWORD_HASH) IS kept — it's a
 * pure security property independent of lockout tracking, and omitting
 * it would be a real, avoidable regression relative to the proven admin
 * pattern for no reason the ratified architecture calls for.
 */

import type { Env } from '../../worker/env';
import type { Logger } from '../../utils/logger';
import { verifyPassword, hashPassword } from '../../utils/passwordHash';
import { generateCustomerPasswordToken } from '../../utils/customerToken';
import { validatePasswordStrength, type PasswordValidationError } from '../../utils/passwordPolicy';
import { isValidEmail } from '../../utils/validation';
import { sendEmail } from '../emailService';
import * as sessionService from './sessionService';

/** Same fixed, syntactically-valid dummy hash technique as admin authService.ts's DUMMY_PASSWORD_HASH — see that file's comment for the full timing-attack rationale. Iteration count must match utils/passwordHash.ts's PBKDF2_ITERATIONS. */
const DUMMY_PASSWORD_HASH = `${'0'.repeat(32)}:100000:${'0'.repeat(64)}`;

const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 256;

interface CustomerAuthRow {
  id: number;
  email: string;
  passwordHash: string | null;
}

export type LoginDenialReason = 'invalid_credentials' | 'password_not_set';

export type LoginResult =
  | { ok: true; customerId: number; email: string; sessionToken: string; csrfSecret: string; expiresAt: string }
  | { ok: false; reason: LoginDenialReason };

export interface LoginContext {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Same no-enumeration discipline as admin login(): the DUMMY_PASSWORD_HASH
 * comparison always runs, whether the account doesn't exist, has no
 * password set yet (guest-only, never logged in), or the password is
 * simply wrong — every one of those returns the identical
 * `invalid_credentials` reason and takes the same time. `password_not_set`
 * exists as a DISTINCT reason only for the route layer's own UX copy
 * ("this account hasn't set a password yet — check your email for a
 * setup link") — it is never returned before the dummy-hash comparison
 * completes, so it carries no timing signal either.
 */
export async function login(env: Env, logger: Logger, emailInput: unknown, passwordInput: unknown, context: LoginContext): Promise<LoginResult> {
  if (
    typeof emailInput !== 'string' ||
    typeof passwordInput !== 'string' ||
    passwordInput.length === 0 ||
    emailInput.length > MAX_EMAIL_LENGTH ||
    passwordInput.length > MAX_PASSWORD_LENGTH
  ) {
    return { ok: false, reason: 'invalid_credentials' };
  }
  const email = emailInput.trim().toLowerCase();

  const row = await env.DB.prepare(
    `SELECT id, email, password_hash AS passwordHash FROM customers WHERE email = ? AND status = 'active' AND deleted_at IS NULL`
  )
    .bind(email)
    .first<CustomerAuthRow>();

  const hasPassword = !!row?.passwordHash;
  const passwordValid = await verifyPassword(passwordInput, hasPassword ? (row!.passwordHash as string) : DUMMY_PASSWORD_HASH);

  if (!row) {
    logger.info('customer.login_failed', { reason: 'not_found' });
    return { ok: false, reason: 'invalid_credentials' };
  }

  if (!hasPassword) {
    logger.info('customer.login_failed', { customerId: row.id, reason: 'password_not_set' });
    return { ok: false, reason: 'password_not_set' };
  }

  if (!passwordValid) {
    logger.info('customer.login_failed', { customerId: row.id, reason: 'wrong_password' });
    return { ok: false, reason: 'invalid_credentials' };
  }

  const session = await sessionService.createSession(env, row.id, context);
  logger.info('customer.login_succeeded', { customerId: row.id });

  return {
    ok: true,
    customerId: row.id,
    email: row.email,
    sessionToken: session.sessionToken,
    csrfSecret: session.csrfSecret,
    expiresAt: session.expiresAt,
  };
}

export async function logout(env: Env, logger: Logger, tokenInput: unknown): Promise<boolean> {
  const result = await sessionService.revokeSession(env, tokenInput);
  if (!result.revoked) return false;
  logger.info('customer.logout', { customerId: result.customerId });
  return true;
}

// ============================================================
// Password setup / reset — one shared mechanism
// (customer_password_tokens), two triggering contexts. See
// migration 0018_customer_identity.sql's own header comment.
// ============================================================

const PASSWORD_TOKEN_TTL_MINUTES = 30;

/**
 * Issues a `customer_password_tokens` row and sends the email. Called
 * from three places: `identityService.findOrCreateCustomer()`'s caller
 * (`commerceService.ts`, only for a newly-created customer — the
 * "welcome" framing), `forgotPassword()` below (the "reset" framing),
 * and, as of Version 3.3 Milestone M5C,
 * `reconciliationService.reconcilePurchases()` (the "historical
 * purchase claim" framing) — same mechanism, different email
 * template/copy, per the ratified Blueprint's Email Architecture
 * (Deliverable 7).
 */
export async function issuePasswordToken(
  env: Env,
  logger: Logger,
  customerId: number,
  email: string,
  siteBaseUrl: string,
  template: 'customer-welcome' | 'customer-password-reset' | 'customer-purchase-reconciliation'
): Promise<void> {
  const token = generateCustomerPasswordToken();
  const expiresAt = new Date(Date.now() + PASSWORD_TOKEN_TTL_MINUTES * 60_000).toISOString();

  await env.DB.prepare(`INSERT INTO customer_password_tokens (token, customer_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, customerId, expiresAt)
    .run();

  const setupUrl = `${siteBaseUrl}/checkout/set-password/?token=${token}`;

  if (template === 'customer-welcome') {
    await sendEmail(env, logger, {
      template: 'customer-welcome',
      to: email,
      data: { email, setupUrl },
      entityType: 'customer',
      entityId: customerId,
    });
  } else if (template === 'customer-purchase-reconciliation') {
    // Version 3.3 Milestone M5C — distinct copy from both 'customer-welcome'
    // (a fresh checkout, not a recovered historical one) and
    // 'customer-password-reset' (not a password the customer set and
    // forgot), so the email accurately explains why they're receiving
    // it: their past purchase(s) were just linked to a new account.
    await sendEmail(env, logger, {
      template: 'customer-purchase-reconciliation',
      to: email,
      data: { email, setupUrl },
      entityType: 'customer',
      entityId: customerId,
    });
  } else {
    // Distinct from the admin 'password-reset' template — that one's
    // copy/link path is admin-specific ("admin account", /admin/reset-
    // password/). Reusing it for a customer would show the wrong
    // audience and the wrong URL.
    await sendEmail(env, logger, {
      template: 'customer-password-reset',
      to: email,
      data: { email, resetUrl: setupUrl },
      entityType: 'customer',
      entityId: customerId,
    });
  }

  logger.info('customer.password_token_issued', { customerId, template });
}

export async function forgotPassword(env: Env, logger: Logger, emailInput: unknown, siteBaseUrl: string): Promise<void> {
  if (typeof emailInput !== 'string' || emailInput.length === 0 || emailInput.length > MAX_EMAIL_LENGTH) return;
  const email = emailInput.trim().toLowerCase();

  const row = await env.DB.prepare(`SELECT id FROM customers WHERE email = ? AND status = 'active' AND deleted_at IS NULL`)
    .bind(email)
    .first<{ id: number }>();
  if (!row) return; // No enumeration signal — same code path either way.

  await issuePasswordToken(env, logger, row.id, email, siteBaseUrl, 'customer-password-reset');
}

export type SetPasswordResult = { ok: true } | { ok: false; reason: 'invalid_or_expired_token' } | { ok: false; reason: 'validation'; errors: PasswordValidationError[] };

/**
 * Redeems a `customer_password_tokens` row and sets the password —
 * used both for the initial post-purchase setup and any later reset.
 * Mirrors admin `resetPassword()`'s atomic, race-safe token consumption
 * exactly (`used_at IS NULL`-gated UPDATE).
 */
export async function setPassword(env: Env, logger: Logger, tokenInput: unknown, newPasswordInput: unknown): Promise<SetPasswordResult> {
  if (typeof tokenInput !== 'string' || tokenInput.length === 0) return { ok: false, reason: 'invalid_or_expired_token' };

  const now = new Date().toISOString();
  const tokenRow = await env.DB.prepare(
    `SELECT t.id AS tokenId, t.customer_id AS customerId, c.email AS email
     FROM customer_password_tokens t
     JOIN customers c ON c.id = t.customer_id
     WHERE t.token = ? AND t.used_at IS NULL AND t.expires_at > ? AND c.status = 'active' AND c.deleted_at IS NULL`
  )
    .bind(tokenInput, now)
    .first<{ tokenId: number; customerId: number; email: string }>();

  if (!tokenRow) return { ok: false, reason: 'invalid_or_expired_token' };

  const strengthErrors = validatePasswordStrength(newPasswordInput, { email: tokenRow.email });
  if (strengthErrors.length > 0) return { ok: false, reason: 'validation', errors: strengthErrors };

  const newHash = await hashPassword(newPasswordInput as string);

  const consumed = await env.DB.prepare(`UPDATE customer_password_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL`)
    .bind(tokenRow.tokenId)
    .run();
  if (consumed.meta.changes !== 1) return { ok: false, reason: 'invalid_or_expired_token' };

  await env.DB.prepare(`UPDATE customers SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(newHash, tokenRow.customerId)
    .run();

  // Forced logout of any other existing sessions, mirroring admin
  // resetPassword()'s exact reasoning — there is no "current" session
  // to preserve during this flow (the customer isn't logged in yet).
  await sessionService.revokeAllSessions(env, tokenRow.customerId);

  logger.info('customer.password_set', { customerId: tokenRow.customerId });

  return { ok: true };
}

// ============================================================
// Change password (already logged in) — Version 3.1 Milestone M3
// (Checkout Auto-Provisioning & Dashboard MVP). See
// docs/v3.1-m3-api-gap-analysis.md's Gap 4.
//
// Distinct from setPassword() above: that flow redeems an emailed,
// single-use token (no prior session exists yet). This flow instead
// re-authenticates a specific irreversible action with the customer's
// CURRENT password, exactly as admin authService.ts's own
// changePassword() already established for admins — an already-logged-in
// customer changing their password should never need an email
// round-trip, but must still prove they are the account owner right
// now, not merely that a session cookie exists.
// ============================================================

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_current_password' }
  | { ok: false; reason: 'validation'; errors: PasswordValidationError[] };

/**
 * Verifies `currentPasswordInput` against the stored hash, then
 * applies `newPasswordInput` if it passes the same strength policy
 * every other password-set path already enforces. On success, revokes
 * every OTHER active session for this customer (mirroring setPassword()'s
 * "a password change invalidates prior logins" rule) while preserving
 * `currentSessionId` — the one call site that needs the "except"
 * variant, since here (unlike setPassword()) the customer IS actively
 * logged in during the flow and must not be signed out of the very
 * request that changed their own password.
 */
export async function changePassword(
  env: Env,
  logger: Logger,
  customerId: number,
  currentSessionId: number,
  currentPasswordInput: unknown,
  newPasswordInput: unknown
): Promise<ChangePasswordResult> {
  const row = await env.DB.prepare(`SELECT password_hash AS passwordHash, email FROM customers WHERE id = ? AND status = 'active' AND deleted_at IS NULL`)
    .bind(customerId)
    .first<{ passwordHash: string | null; email: string }>();

  const hasPassword = !!row?.passwordHash;
  const currentValid =
    typeof currentPasswordInput === 'string' &&
    currentPasswordInput.length > 0 &&
    (await verifyPassword(currentPasswordInput, hasPassword ? (row!.passwordHash as string) : DUMMY_PASSWORD_HASH));

  if (!row || !hasPassword || !currentValid) {
    logger.info('customer.change_password_failed', { customerId, reason: 'invalid_current_password' });
    return { ok: false, reason: 'invalid_current_password' };
  }

  const strengthErrors = validatePasswordStrength(newPasswordInput, { email: row.email });
  if (strengthErrors.length > 0) return { ok: false, reason: 'validation', errors: strengthErrors };

  const newHash = await hashPassword(newPasswordInput as string);

  await env.DB.prepare(`UPDATE customers SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(newHash, customerId)
    .run();

  await sessionService.revokeAllSessionsExcept(env, customerId, currentSessionId);

  logger.info('customer.password_changed', { customerId });

  return { ok: true };
}

// ============================================================
// Free account registration — Affiliate Programme 2.0.
//
// A deliberate, additive exception to ADR-006's "purchase-triggered
// provisioning only" (see this file's own and identityService.ts's
// header comments for the full history of that decision): the
// Affiliate Programme's own public copy already promises "create a
// free account," and there is currently no path that honors it. This
// does not touch or weaken ADR-006's actual protection for the
// purchase path — findOrCreateCustomer() is completely untouched, a
// purchase still never requires a password, and a self-registered
// account behaves identically to a purchase-provisioned one everywhere
// else in the app (same `customers` row shape, same login, same
// session/CSRF, same password-reset flow) once it exists.
//
// email_verified_at is intentionally left NULL at registration
// (unlike identityService.ts's purchase path, where a successful
// payment is itself treated as a stronger identity signal) — a
// registration with no payment behind it has no equivalent signal, so
// a real verification email is sent and must be clicked. The account
// IS immediately usable (a session is created, matching how most
// production registration flows avoid blocking on email round-trips)
// - `email_verified_at` is available for any FUTURE feature that wants
// to gate on it, but nothing in this pass hard-requires it, per the
// task's own "email verification if existing infra supports it"
// framing rather than a hard gate.
// ============================================================

const REGISTRATION_MAX_NAME_LENGTH = 200;
const EMAIL_VERIFICATION_TOKEN_TTL_HOURS = 48;

export interface RegistrationValidationError {
  field: 'name' | 'email' | 'passwordConfirmation' | 'termsAccepted' | 'newPassword';
  message: string;
}

export type RegisterResult =
  | { ok: true; customerId: number; email: string; sessionToken: string; csrfSecret: string; expiresAt: string }
  | { ok: false; reason: 'duplicate_email' }
  | { ok: false; reason: 'validation'; errors: RegistrationValidationError[] };

export async function registerCustomer(
  env: Env,
  logger: Logger,
  input: { name: unknown; email: unknown; password: unknown; passwordConfirmation: unknown; termsAccepted: unknown },
  siteBaseUrl: string,
  context: LoginContext
): Promise<RegisterResult> {
  const errors: RegistrationValidationError[] = [];

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) {
    errors.push({ field: 'name', message: 'Please tell us your name.' });
  } else if (name.length > REGISTRATION_MAX_NAME_LENGTH) {
    errors.push({ field: 'name', message: 'That name is too long.' });
  }

  const emailInput = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!isValidEmail(emailInput)) {
    errors.push({ field: 'email', message: 'Please enter a valid email address.' });
  }

  if (input.password !== input.passwordConfirmation) {
    errors.push({ field: 'passwordConfirmation', message: "Passwords don't match." });
  }

  if (input.termsAccepted !== true) {
    errors.push({ field: 'termsAccepted', message: 'Please accept the Terms of Service to continue.' });
  }

  const strengthErrors = validatePasswordStrength(input.password, { email: emailInput || undefined });
  errors.push(...strengthErrors);

  if (errors.length > 0) {
    return { ok: false, reason: 'validation', errors };
  }

  const existing = await env.DB.prepare(`SELECT id FROM customers WHERE email = ? AND deleted_at IS NULL`).bind(emailInput).first<{ id: number }>();
  if (existing) {
    return { ok: false, reason: 'duplicate_email' };
  }

  const passwordHash = await hashPassword(input.password as string);

  let customerId: number;
  try {
    const insert = await env.DB.prepare(
      `INSERT INTO customers (email, password_hash, email_verified_at, status, data_classification) VALUES (?, ?, NULL, 'active', 'PRODUCTION')`
    )
      .bind(emailInput, passwordHash)
      .run();
    customerId = Number(insert.meta.last_row_id);
  } catch {
    // Race: a concurrent registration/purchase created the same email
    // between the SELECT above and this INSERT — the UNIQUE constraint
    // is the real serialization point, same pattern as
    // identityService.ts's findOrCreateCustomer().
    return { ok: false, reason: 'duplicate_email' };
  }

  await env.DB.prepare(`INSERT INTO customer_profiles (customer_id, display_name, data_classification) VALUES (?, ?, 'PRODUCTION')`)
    .bind(customerId, name)
    .run();

  await issueEmailVerificationToken(env, logger, customerId, emailInput, siteBaseUrl);

  const session = await sessionService.createSession(env, customerId, context);
  logger.info('customer.registered', { customerId });

  return {
    ok: true,
    customerId,
    email: emailInput,
    sessionToken: session.sessionToken,
    csrfSecret: session.csrfSecret,
    expiresAt: session.expiresAt,
  };
}

/**
 * A dedicated token/table (customer_email_verification_tokens), not a
 * reuse of customer_password_tokens — that table's own redemption path
 * (setPassword() above) sets a new password hash, the wrong side
 * effect for "confirm this address is real." Same single-use/expiring
 * shape, different assertion.
 */
async function issueEmailVerificationToken(env: Env, logger: Logger, customerId: number, email: string, siteBaseUrl: string): Promise<void> {
  const token = generateCustomerPasswordToken(); // generic 256-bit hex generator, not password-specific — see utils/customerToken.ts's own header comment.
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_HOURS * 60 * 60_000).toISOString();

  await env.DB.prepare(`INSERT INTO customer_email_verification_tokens (token, customer_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, customerId, expiresAt)
    .run();

  const verifyUrl = `${siteBaseUrl}/checkout/verify-email/?token=${token}`;

  // Best-effort, same swallow-and-log discipline as every other
  // sendEmail() caller in this codebase (see emailService.ts's own
  // header comment) — a failed verification email must never fail
  // registration itself; the account is already usable regardless.
  await sendEmail(env, logger, {
    template: 'customer-email-verification',
    to: email,
    data: { verifyUrl },
    entityType: 'customer',
    entityId: customerId,
  });
}

export type VerifyEmailResult = { ok: true } | { ok: false; reason: 'invalid_or_expired_token' };

export async function verifyEmail(env: Env, tokenInput: unknown): Promise<VerifyEmailResult> {
  if (typeof tokenInput !== 'string' || tokenInput.length === 0) return { ok: false, reason: 'invalid_or_expired_token' };

  const now = new Date().toISOString();
  const tokenRow = await env.DB.prepare(
    `SELECT id, customer_id AS customerId FROM customer_email_verification_tokens WHERE token = ? AND used_at IS NULL AND expires_at > ?`
  )
    .bind(tokenInput, now)
    .first<{ id: number; customerId: number }>();

  if (!tokenRow) return { ok: false, reason: 'invalid_or_expired_token' };

  const consumed = await env.DB.prepare(`UPDATE customer_email_verification_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL`)
    .bind(tokenRow.id)
    .run();
  if (consumed.meta.changes !== 1) return { ok: false, reason: 'invalid_or_expired_token' };

  await env.DB.prepare(`UPDATE customers SET email_verified_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND email_verified_at IS NULL`)
    .bind(tokenRow.customerId)
    .run();

  return { ok: true };
}
