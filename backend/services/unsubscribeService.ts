/**
 * Newsletter Unsubscribe Service — docs/newsletter-unsubscribe-design.md.
 *
 * Mirrors entitlementService.ts's redemption pattern deliberately: the
 * security-critical decision ("may this token be consumed right now")
 * is one atomic UPDATE with the check in its own WHERE clause, so
 * there is no read-then-write race a concurrent request could exploit
 * — same pattern as `download_tokens`' consumeTokenAtomic().
 *
 * Idempotency, by design: a subscriber who is already unsubscribed
 * (whether this exact token did it, an earlier token did it, or they
 * unsubscribed some other way) always sees a success outcome, never
 * an error — the desired end-state ("not receiving emails") is what
 * matters, not which specific click achieved it. A token can only
 * ever move a subscriber from subscribed -> unsubscribed once; every
 * click after that is a no-op that still reports success.
 */

import type { Env } from '../worker/env';
import type { Logger } from '../utils/logger';
import { generateUnsubscribeToken } from '../utils/unsubscribeToken';

/** Long-lived deliberately: an unsubscribe link, unlike a download link, may sit unopened in an inbox for months and must still work then — this is not a short-TTL security-sensitive access grant, so a generous window is the right choice. See docs/newsletter-unsubscribe-design.md's "Why a 1-year expiry" for the full reasoning. */
const UNSUBSCRIBE_TOKEN_TTL_DAYS = 365;

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

interface SubscriberRow {
  id: number;
  email: string;
  status: string;
}

/**
 * Returns an existing, still-valid, unused token for this subscriber
 * if one exists; otherwise mints a fresh one. Called at the moment a
 * newsletter email is composed (today: on first subscribe) — never
 * pre-generated for every row, avoiding a backfill for existing
 * subscribers who have no outstanding token yet.
 */
export async function getOrCreateUnsubscribeToken(env: Env, subscriberId: number): Promise<string> {
  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    `SELECT token FROM unsubscribe_tokens WHERE subscriber_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1`
  )
    .bind(subscriberId, now)
    .first<{ token: string }>();
  if (existing) return existing.token;

  const token = generateUnsubscribeToken();
  const expiresAt = new Date(Date.now() + UNSUBSCRIBE_TOKEN_TTL_DAYS * 24 * 60 * 60_000).toISOString();

  await env.DB.prepare(`INSERT INTO unsubscribe_tokens (token, subscriber_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, subscriberId, expiresAt)
    .run();

  return token;
}

export type TokenLookupReason = 'token_not_found' | 'token_expired';

export type UnsubscribeStatusResult =
  | { ok: true; email: string; alreadyUnsubscribed: boolean }
  | { ok: false; reason: TokenLookupReason };

/**
 * Read-only status check — GET /api/newsletter/unsubscribe/:token.
 * Never mutates anything, so it is safe for an email-client link
 * scanner or prefetcher to request this without side effects (the
 * real, well-known reason single-click unsubscribe flows separate a
 * safe GET status check from a POST that actually acts).
 */
export async function getUnsubscribeStatus(env: Env, tokenInput: unknown): Promise<UnsubscribeStatusResult> {
  if (typeof tokenInput !== 'string' || !TOKEN_PATTERN.test(tokenInput)) {
    return { ok: false, reason: 'token_not_found' };
  }
  const token = tokenInput;

  const row = await env.DB.prepare(
    `SELECT s.id AS id, s.email AS email, s.status AS status
     FROM unsubscribe_tokens t JOIN newsletter_subscribers s ON s.id = t.subscriber_id
     WHERE t.token = ?`
  )
    .bind(token)
    .first<SubscriberRow>();

  if (!row) return { ok: false, reason: 'token_not_found' };

  // Already unsubscribed (via this token, an earlier one, or any other
  // route) — idempotent success regardless of this token's own
  // used/expired state, since the outcome the visitor wants is already true.
  if (row.status === 'unsubscribed') {
    return { ok: true, email: row.email, alreadyUnsubscribed: true };
  }

  const tokenRow = await env.DB.prepare(`SELECT used_at AS usedAt, expires_at AS expiresAt FROM unsubscribe_tokens WHERE token = ?`)
    .bind(token)
    .first<{ usedAt: string | null; expiresAt: string }>();
  if (!tokenRow) return { ok: false, reason: 'token_not_found' };

  const now = new Date();
  const stillSubscribed = row.status !== 'unsubscribed';
  if (stillSubscribed && new Date(tokenRow.expiresAt) <= now) {
    return { ok: false, reason: 'token_expired' };
  }

  // Valid, unexpired, and (per the status === 'unsubscribed' check
  // above) not yet actually used to unsubscribe anyone — ready to show
  // the confirmation screen.
  return { ok: true, email: row.email, alreadyUnsubscribed: false };
}

/**
 * A used/expired token whose subscriber is currently subscribed again
 * (they resubscribed after this exact token was used to unsubscribe
 * them) is a distinct outcome from a genuine replay — the token can
 * never legitimately unsubscribe anyone again, but reporting success
 * would be false, since this click did not (and structurally cannot)
 * unsubscribe them. See the production readiness audit's "Re-subscribe
 * Behaviour" finding.
 */
export type ConfirmUnsubscribeReason = TokenLookupReason | 'token_stale';

export type ConfirmUnsubscribeResult =
  | { ok: true; email: string; alreadyUnsubscribed: boolean }
  | { ok: false; reason: ConfirmUnsubscribeReason };

/**
 * The mutating action — POST /api/newsletter/unsubscribe/:token.
 * Consumes the token atomically (single-use, replay-safe), then sets
 * the subscriber's status. If the atomic consume fails (already used,
 * expired, or never existed), falls back to getUnsubscribeStatus's
 * already-correct read of the subscriber's real current state — it
 * must never be assumed the visitor achieved their goal, only reported
 * when that's actually true.
 */
export async function confirmUnsubscribe(env: Env, logger: Logger, tokenInput: unknown): Promise<ConfirmUnsubscribeResult> {
  if (typeof tokenInput !== 'string' || !TOKEN_PATTERN.test(tokenInput)) {
    return { ok: false, reason: 'token_not_found' };
  }
  const token = tokenInput;

  const consumed = await consumeTokenAtomic(env, token);
  if (consumed.ok) {
    await env.DB.prepare(
      `UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    )
      .bind(consumed.subscriberId)
      .run();

    const subscriber = await env.DB.prepare(`SELECT email FROM newsletter_subscribers WHERE id = ?`)
      .bind(consumed.subscriberId)
      .first<{ email: string }>();

    logger.info('newsletter.unsubscribed', { subscriberId: consumed.subscriberId });
    return { ok: true, email: subscriber?.email ?? '', alreadyUnsubscribed: false };
  }

  // The atomic consume didn't apply — either this token was already
  // used, has expired, or never existed. Re-check via the same
  // read-only status logic used by the GET endpoint, and — this is the
  // fix — trust what it actually found instead of assuming success.
  logger.warn('newsletter.unsubscribe_token_rejected', { tokenPrefix: token.slice(0, 8), reason: consumed.reason });
  const status = await getUnsubscribeStatus(env, token);
  if (!status.ok) return { ok: false, reason: status.reason };

  if (status.alreadyUnsubscribed) {
    // Genuine idempotent replay (or a double-click race with another
    // request that consumed the token a moment earlier) — the
    // subscriber really is unsubscribed, verified fresh just now.
    return { ok: true, email: status.email, alreadyUnsubscribed: true };
  }

  // The token exists and belongs to a real subscriber, but it's used
  // or expired AND that subscriber is currently subscribed — meaning
  // they resubscribed since this token was last used. This click did
  // not unsubscribe them; saying otherwise would be false.
  return { ok: false, reason: 'token_stale' };
}

interface ConsumeTokenResult {
  ok: true;
  subscriberId: number;
}
type ConsumeTokenOutcome = ConsumeTokenResult | { ok: false; reason: TokenLookupReason };

async function consumeTokenAtomic(env: Env, token: string): Promise<ConsumeTokenOutcome> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE unsubscribe_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at > ?`
  )
    .bind(now, token, now)
    .run();

  if (result.meta.changes === 1) {
    const row = await env.DB.prepare(`SELECT subscriber_id AS subscriberId FROM unsubscribe_tokens WHERE token = ?`)
      .bind(token)
      .first<{ subscriberId: number }>();
    return row ? { ok: true, subscriberId: row.subscriberId } : { ok: false, reason: 'token_not_found' };
  }

  const existing = await env.DB.prepare(`SELECT used_at AS usedAt FROM unsubscribe_tokens WHERE token = ?`)
    .bind(token)
    .first<{ usedAt: string | null }>();
  if (!existing) return { ok: false, reason: 'token_not_found' };
  // Both "already used" and "expired" surface as token_expired to the
  // caller — unlike download tokens (where TOKEN_ALREADY_USED is a
  // distinct, meaningful error), confirmUnsubscribe() immediately
  // re-derives the real outcome via getUnsubscribeStatus() regardless
  // of which of these two this was, so the distinction only matters
  // for this function's own log line, not for anything downstream.
  return { ok: false, reason: 'token_expired' };
}
