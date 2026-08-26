-- ============================================================
-- 0041_purchase_conversion_matching.sql — Version 5.0 (Customer
-- Acquisition Phase 1, Event Match Quality improvement).
--
-- Adds 4 nullable columns to purchase_sessions, captured ONLY at
-- checkout-session creation (routes/checkout.ts /
-- commerceService.ts's createCheckoutSession()) — the one point in
-- the whole purchase flow with a real, direct request from the
-- customer's own browser. The Paystack webhook that later completes
-- the purchase (commerceService.ts's handlePaymentWebhook()) is a
-- server-to-server call from Paystack, not the customer, so it is
-- never a legitimate source for these fields — reading them here and
-- forwarding them to Meta's Conversions API at verification time is
-- the closest honest capture point, not a fabrication.
--
-- client_ip_address / client_user_agent: read from the real request's
-- CF-Connecting-IP / User-Agent headers (see middleware/rateLimit.ts
-- for this codebase's existing CF-Connecting-IP convention).
--
-- fbc / fbp: Meta's own first-party click-ID/browser-ID cookies,
-- already set automatically by fbevents.js (js/components/meta-pixel.js)
-- on every page load — read here from the Cookie header of the same
-- same-origin checkout request, never generated or guessed.
--
-- All 4 are optional (a visitor with an ad-blocker, or who arrived
-- with no fbclid, legitimately has none of these) — NULL means
-- "not available," never an empty string, so downstream code can
-- distinguish "we don't have it" from "we have an empty value."
--
-- Rollback: `ALTER TABLE purchase_sessions DROP COLUMN client_ip_address;`
-- (and the other 3) — safe, additive-only, nothing else in the schema
-- depends on these columns.
-- ============================================================

ALTER TABLE purchase_sessions ADD COLUMN client_ip_address TEXT;
ALTER TABLE purchase_sessions ADD COLUMN client_user_agent TEXT;
ALTER TABLE purchase_sessions ADD COLUMN fbc TEXT;
ALTER TABLE purchase_sessions ADD COLUMN fbp TEXT;
