-- ============================================================
-- 0048_coupon_classification_backfill.sql
--
-- Forensic-audit follow-up (2026-08-28): 0047 fixed
-- purchase_sessions/customers and their direct children, but left
-- coupons/coupon_redemptions unaddressed (couponService.ts's
-- createCoupon()/redeemCoupon() never wrote data_classification
-- either, same gap). These feed the Active/Expired coupon counters
-- in executiveDashboardService.ts (WHERE ... AND ${cls.sql}), so an
-- UNKNOWN coupon disappears from Production-mode dashboards exactly
-- like an UNKNOWN purchase_session did.
--
-- Same evidence standard as 0029/0047: self-labeled test codes, who
-- actually redeemed each coupon (cross-referenced against known
-- internal emails and already-classified purchase_sessions/
-- customers), and - new here - a coupon's real-world use confirmed
-- via a genuinely sent newsletter campaign to real subscribers.
--
-- Rollback: `UPDATE <table> SET data_classification = 'UNKNOWN'
-- WHERE id IN (...)`, using the id lists below - always safe, always
-- reversible, since nothing here deletes or moves a row.
-- ============================================================

-- ---------- coupons ----------
-- TEST1/TEST2/TEST3/TEST4: self-labeled test codes (same naming
-- family as 0029's TRIAL2/TRIAL3), created in a single Aug 8 batch,
-- every redemption traced to a known internal/founder email
-- (lohrobert11@gmail.com, rloh5014@gmail.com, ayerhnathalia@gmail.com
-- - customer id 12, itself already INTERNAL per 0029) - never a real
-- customer-facing promotion.
UPDATE coupons SET data_classification = 'DEVELOPMENT' WHERE code IN ('TEST1', 'TEST2', 'TEST3', 'TEST4');

-- ZVERIFYTEMP: self-labeled temporary verification code, 0
-- redemptions, disabled - a technical check, not a real promo.
UPDATE coupons SET data_classification = 'DEVELOPMENT' WHERE code = 'ZVERIFYTEMP';

-- LAUNCH4: despite the "LAUNCH"-family name, its one and only
-- redemption is the founder's own known-internal email
-- (lohrobert11@gmail.com, purchase_session id 104, already INTERNAL
-- per 0047) - same "created for, and only ever redeemed by, a
-- confirmed-internal transaction" pattern 0029 used for NALIA1.
UPDATE coupons SET data_classification = 'INTERNAL' WHERE code = 'LAUNCH4';

-- CHECKED50: the coupon embedded in newsletter_campaigns id 3
-- ("Before you apply for another remote job..."), confirmed genuinely
-- sent (status='sent', sent_by=5 the founder's own admin account) to
-- 26 real subscribers on 2026-08-26 - a real, live promotional
-- coupon, matching LAUNCH20/GODWIN1's PRODUCTION classification in
-- 0029 even though (like those two) it has few/no redemptions yet.
UPDATE coupons SET data_classification = 'PRODUCTION' WHERE code = 'CHECKED50';

-- ---------- coupon_redemptions ----------
-- Inherits the COUPON's own classification, not the linked
-- purchase_session's - matching 0029's own established precedent
-- (TRIAL2/TRIAL3's redemptions are DEVELOPMENT even though the
-- purchase_sessions that redeemed them are INTERNAL): a redemption
-- record's meaning is "this coupon was used," judged by what kind of
-- coupon it was.
UPDATE coupon_redemptions SET data_classification =
  (SELECT c.data_classification FROM coupons c WHERE c.id = coupon_redemptions.coupon_id)
  WHERE data_classification = 'UNKNOWN'
    AND coupon_id IN (SELECT id FROM coupons WHERE data_classification != 'UNKNOWN');

-- ---------- newsletter_campaigns / newsletter_campaign_recipients ----------
-- Direct supporting evidence for CHECKED50 above: campaign id 3 is
-- the real, live campaign that coupon was embedded in - genuinely
-- sent, not a test (status='sent', intended_recipient_count=26,
-- sent_by=5). Its 26 recipients inherit the same classification.
UPDATE newsletter_campaigns SET data_classification = 'PRODUCTION' WHERE id = 3;
UPDATE newsletter_campaign_recipients SET data_classification = 'PRODUCTION' WHERE campaign_id = 3;
