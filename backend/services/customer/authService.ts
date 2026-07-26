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
