/**
 * Customer Identity Service — Version 3.0.2 Milestone M1 (Customer
 * Identity & Guest Checkout). See
 * docs/v3.0.2-commerce-architecture-blueprint.md's Deliverable 1
 * stage 14 ("Account Creation") and Deliverable 4 (Checkout
 * Architecture, step 5).
 *
 * Per docs/v3.0.2-architecture-decision-register.md's ADR-006
 * ("Purchase-triggered account provisioning only"), there is still no
 * public registration endpoint anywhere in this project —
 * `findOrCreateCustomer` is only ever reached from a verified purchase,
 * never a free-form email with no purchase behind it. As of Version
 * 3.3 Milestone M5C it has two call sites, not one: the original,
 * contemporaneous path (`commerceService.handlePaymentWebhook()`,
 * immediately after payment verification succeeds and before
 * fulfilment) and a second, historical path
 * (`reconciliationService.reconcilePurchases()`, for a `purchase_sessions`
 * row that was verified before a customer row ever existed to link it
 * to). Both are purchase-triggered, one contemporaneous, one
 * retroactive — ADR-006's actual protection (no account without a real
 * payment behind it) holds either way.
 */

import type { Env } from '../../worker/env';

export interface FindOrCreateResult {
  customerId: number;
  /** True only if this call genuinely inserted a new `customers` row — false means an existing customer (by email) was found and reused. Callers use this to decide whether to send the welcome/password-setup email (Deliverable 7: sent once, only for a newly-created account). */
  isNewCustomer: boolean;
}

/**
 * Finds an existing `customers` row by email, or creates one. Email is
 * the durable join key across purchases (ratified Blueprint,
 * Deliverable 1 stage 15) — always the provider-confirmed email from
 * Paystack's own verification (`verifyResult.customerEmail` in
 * `commerceService.ts`), never a client-supplied value, matching the
 * exact trust discipline `purchase_sessions.customer_email` already
 * established.
 *
 * A new customer's `email_verified_at` is set immediately at creation:
 * a successful payment is itself a stronger identity signal than a
 * typical email-verification-link click (see the ratified Blueprint's
 * Deliverable 1 stage 5 security note) — no separate verification loop
 * is needed for this path.
 *
 * `password_hash` is left NULL on creation — an account with no
 * password set cannot be logged into by anyone (ADR-002/ADR-006).
 *
 * A matching `customer_profiles` row (empty, all-NULL beyond
 * `customer_id`/`marketing_opt_in`) is created in the same call, seeded
 * from the purchase's own `marketing_opt_in` consent — never populated
 * from any other source.
 */
export async function findOrCreateCustomer(env: Env, email: string, marketingOptIn: boolean): Promise<FindOrCreateResult> {
  const normalizedEmail = email.trim().toLowerCase();

  const existing = await env.DB.prepare(`SELECT id FROM customers WHERE email = ? AND deleted_at IS NULL`)
    .bind(normalizedEmail)
    .first<{ id: number }>();

  if (existing) {
    return { customerId: existing.id, isNewCustomer: false };
  }

  // A concurrent webhook redelivery (or a genuinely simultaneous second
  // purchase under the same email) could race here between the SELECT
  // above and this INSERT — `email UNIQUE` is the real serialization
  // point, mirroring authService.ts's acceptInvite() exactly: whichever
  // INSERT loses the race gets a clean constraint failure, caught below
  // and resolved by re-reading the row the winner just created.
  try {
    const insert = await env.DB.prepare(
      `INSERT INTO customers (email, password_hash, email_verified_at, status) VALUES (?, NULL, datetime('now'), 'active')`
    )
      .bind(normalizedEmail)
      .run();
    const customerId = Number(insert.meta.last_row_id);

    await env.DB.prepare(`INSERT INTO customer_profiles (customer_id, marketing_opt_in) VALUES (?, ?)`)
      .bind(customerId, marketingOptIn ? 1 : 0)
      .run();

    return { customerId, isNewCustomer: true };
  } catch {
    const row = await env.DB.prepare(`SELECT id FROM customers WHERE email = ? AND deleted_at IS NULL`)
      .bind(normalizedEmail)
      .first<{ id: number }>();
    if (!row) throw new Error('customer provisioning race: insert failed but no existing row found');
    return { customerId: row.id, isNewCustomer: false };
  }
}

export interface CustomerRow {
  id: number;
  email: string;
  status: string;
}

/** Read-only lookup used by session validation and password-setup token validation — never used to grant anything on its own. */
export async function getCustomerById(env: Env, customerId: number): Promise<CustomerRow | null> {
  const row = await env.DB.prepare(`SELECT id, email, status FROM customers WHERE id = ? AND status = 'active' AND deleted_at IS NULL`)
    .bind(customerId)
    .first<CustomerRow>();
  return row ?? null;
}
