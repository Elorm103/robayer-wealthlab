-- ============================================================
-- 0047_data_classification_backfill_v2.sql
--
-- Forensic-audit backfill (2026-08-28). Migration 0029 was a
-- one-time pass dated 2026-08-02 and, by its own text, covered
-- purchase_sessions up to id 55 - before the real sales campaign's
-- genuine customer traffic existed. Every purchase_session/customer
-- created since then defaulted to migration 0028's 'UNKNOWN' and
-- was never revisited, because no code path was ever written to
-- classify a new real transaction going forward (see the companion
-- code fix in commerceService.ts/identityService.ts in this same
-- release). Result: the Executive Dashboard's "Production Only"
-- Analytics Mode (the default) filtered out every single genuine
-- sale, showing GH0.00/0 orders despite real revenue.
--
-- Same evidence standard as 0029: exact known-internal-email match,
-- self-labeled test/synthetic addresses, or - new to this pass -
-- inheriting an already-classified customer's own classification
-- (customers.email = purchase_sessions.customer_email), since a
-- customer's classification is itself real evidence about every
-- transaction tied to that same person. Nothing here is guessed:
-- every UNKNOWN row with no such evidence is left UNKNOWN.
--
-- Rollback: `UPDATE <table> SET data_classification = 'UNKNOWN'
-- WHERE id IN (...)` per table, using the same id lists below -
-- always safe, always reversible, since nothing here deletes or
-- moves a row.
-- ============================================================

-- ---------- customers / customer_profiles ----------
-- 19 customers created since the 0029 review, one real distinct
-- email each, none matching a known-internal address and none
-- carrying any test/synthetic marker.
UPDATE customers SET data_classification = 'PRODUCTION'
  WHERE id IN (13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
UPDATE customer_profiles SET data_classification = 'PRODUCTION'
  WHERE customer_id IN (13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);

-- ---------- purchase_sessions ----------
-- lohrobert11@gmail.com / rloh5014@gmail.com (0029's own known
-- founder/staff addresses) and ayerhnathalia@gmail.com (customer id
-- 12, already confirmed INTERNAL by 0029 itself on 2026-08-02) -
-- every session tied to these three inherits the same real-money
-- internal-business classification as the person, not a fresh guess.
UPDATE purchase_sessions SET data_classification = 'INTERNAL'
  WHERE id IN (56, 57, 58, 59, 61, 62, 63, 64, 65, 68, 69, 70, 74, 75, 79, 100, 101, 102, 103, 104);

-- Self-labeled test/synthetic addresses: lohrobert11+checkouttest@
-- and lohrobert11+couponverify@ are the founder's own plus-tagged
-- feature-verification addresses (never real orders); audit-
-- verification-test@example.com is a literal synthetic test address.
-- None of these three reached 'verified', so DEVELOPMENT rather than
-- INTERNAL, matching 0029's own distinction for incomplete sessions.
UPDATE purchase_sessions SET data_classification = 'DEVELOPMENT'
  WHERE id IN (60, 95, 105);

-- Genuine, distinct customer emails with no internal/test signal and
-- no link to an already-classified internal customer - real
-- checkout-session traffic from the actual sales campaign.
UPDATE purchase_sessions SET data_classification = 'PRODUCTION'
  WHERE id IN (66, 67, 71, 72, 73, 76, 77, 78, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92,
               93, 94, 96, 97, 98, 99, 106, 107, 108);

-- 18 abandoned/failed sessions with no email ever captured (checkout
-- never reached that step) and no other identifying signal - and
-- since Pending Orders only counts unexpired sessions
-- (executiveDashboardService.ts's ordersPending query), these
-- long-expired rows do not affect any dashboard figure either way.
-- Left as UNKNOWN, not touched by this file:
-- 1, 3, 5, 8, 10, 16, 17, 18, 19, 20, 38, 39, 40, 41, 43, 44, 47, 48.

-- ---------- payment_transactions / order_items / licenses /
--            receipts / deliveries ----------
-- All five carry purchase_session_id as a direct foreign key, so
-- each row inherits the classification of the transaction it
-- belongs to rather than being judged independently - the same
-- transaction cannot be PRODUCTION in one table and UNKNOWN in
-- another. Deliveries includes rows the 0029 pass already resolved
-- (e.g. resends), so this only ever narrows an existing UNKNOWN.
UPDATE payment_transactions SET data_classification =
  (SELECT ps.data_classification FROM purchase_sessions ps WHERE ps.id = payment_transactions.purchase_session_id)
  WHERE data_classification = 'UNKNOWN'
    AND purchase_session_id IN (SELECT id FROM purchase_sessions WHERE data_classification != 'UNKNOWN');

UPDATE order_items SET data_classification =
  (SELECT ps.data_classification FROM purchase_sessions ps WHERE ps.id = order_items.purchase_session_id)
  WHERE data_classification = 'UNKNOWN'
    AND purchase_session_id IN (SELECT id FROM purchase_sessions WHERE data_classification != 'UNKNOWN');

UPDATE licenses SET data_classification =
  (SELECT ps.data_classification FROM purchase_sessions ps WHERE ps.id = licenses.purchase_session_id)
  WHERE data_classification = 'UNKNOWN'
    AND purchase_session_id IN (SELECT id FROM purchase_sessions WHERE data_classification != 'UNKNOWN');

UPDATE receipts SET data_classification =
  (SELECT ps.data_classification FROM purchase_sessions ps WHERE ps.id = receipts.purchase_session_id)
  WHERE data_classification = 'UNKNOWN'
    AND purchase_session_id IN (SELECT id FROM purchase_sessions WHERE data_classification != 'UNKNOWN');

UPDATE deliveries SET data_classification =
  (SELECT ps.data_classification FROM purchase_sessions ps WHERE ps.id = deliveries.purchase_session_id)
  WHERE data_classification = 'UNKNOWN'
    AND purchase_session_id IN (SELECT id FROM purchase_sessions WHERE data_classification != 'UNKNOWN');
