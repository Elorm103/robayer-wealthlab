-- ============================================================
-- 0029_data_classification_backfill.sql — Version 4.9
--
-- Populates data_classification (added in 0028) for every row that
-- could be classified with direct evidence during the Version 4.9
-- review: Paystack's own gateway_response.domain field (test vs
-- live), self-labeled test emails/coupon codes/form text, and the
-- founder's own confirmation of which real-money transactions were
-- internal business activity rather than customer sales.
--
-- Everything not explicitly touched here keeps migration 0028's
-- default of 'UNKNOWN' - this file only ever narrows that default
-- with direct evidence, never guesses. See
-- docs/v4.9-production-launch-baseline-report.md for the full
-- evidence trail behind every ID below.
--
-- Rollback: `UPDATE <table> SET data_classification = 'UNKNOWN';` per
-- table - always safe, always reversible, since nothing here deletes
-- or moves a row.
-- ============================================================

-- ---------- customers / customer_profiles ----------
-- checkout+rwl-2026-0000NN@robayerwealthlab.com - synthetic address
-- embedding its own purchase reference, Paystack domain:test.
UPDATE customers SET data_classification = 'DEVELOPMENT' WHERE id IN (2, 6);
UPDATE customer_profiles SET data_classification = 'DEVELOPMENT' WHERE customer_id IN (2, 6);

-- Founder + confirmed real staff (editor/support), all Paystack
-- domain:live, all confirmed internal business transactions by the
-- founder directly (2026-08-02).
UPDATE customers SET data_classification = 'INTERNAL' WHERE id IN (9, 10, 11, 12);
UPDATE customer_profiles SET data_classification = 'INTERNAL' WHERE customer_id IN (9, 10, 11, 12);

-- ---------- purchase_sessions ----------
-- Paystack gateway_response.domain = "test" - confirmed sandbox-key
-- transactions, never real money.
UPDATE purchase_sessions SET data_classification = 'DEVELOPMENT'
  WHERE id IN (2, 4, 6, 7, 9, 12, 15, 21, 22, 23, 24, 25, 26, 27, 28, 30, 35);

-- Abandoned/incomplete sessions from a known owner email (never
-- reached a completed transaction, so DEVELOPMENT rather than
-- INTERNAL, which is reserved for real completed transactions).
UPDATE purchase_sessions SET data_classification = 'DEVELOPMENT' WHERE id IN (49, 51, 53, 55);

-- Paystack domain = "live", confirmed internal business transactions
-- by the founder.
UPDATE purchase_sessions SET data_classification = 'INTERNAL' WHERE id IN (46, 50, 52, 54);

-- The remaining 18 abandoned/failed sessions have no email captured
-- and no other identifying signal - left as UNKNOWN (migration
-- 0028's default), not touched by this file at all.

-- ---------- payment_transactions ----------
UPDATE payment_transactions SET data_classification = 'DEVELOPMENT'
  WHERE purchase_session_id IN (2, 4, 6, 7, 9, 12, 15, 21, 22, 23, 24, 25, 26, 27, 28, 30, 35);
UPDATE payment_transactions SET data_classification = 'INTERNAL'
  WHERE purchase_session_id IN (46, 50, 52, 54);

-- ---------- order_items / licenses / receipts / deliveries ----------
UPDATE order_items SET data_classification = 'DEVELOPMENT' WHERE purchase_session_id = 35;
UPDATE order_items SET data_classification = 'INTERNAL' WHERE purchase_session_id IN (46, 50, 52, 54);

UPDATE licenses SET data_classification = 'DEVELOPMENT' WHERE purchase_session_id = 35;
UPDATE licenses SET data_classification = 'INTERNAL' WHERE purchase_session_id IN (46, 50, 52, 54);

UPDATE receipts SET data_classification = 'DEVELOPMENT' WHERE purchase_session_id = 35;
UPDATE receipts SET data_classification = 'INTERNAL' WHERE purchase_session_id IN (46, 50, 52, 54);

UPDATE deliveries SET data_classification = 'DEVELOPMENT'
  WHERE purchase_session_id IN (6, 7, 9, 12, 15, 21, 22, 23, 24, 25, 26, 27, 28, 30, 35);
UPDATE deliveries SET data_classification = 'INTERNAL' WHERE purchase_session_id IN (46, 50, 52, 54);

-- ---------- coupons / coupon_redemptions ----------
-- LAUNCH20: real, unused launch promo. GODWIN1: real, unused personal
-- gift code, prepared the same way as LAUNCH20 (not yet redeemed, no
-- founder note distinguishing it from a normal promotional tool).
UPDATE coupons SET data_classification = 'PRODUCTION' WHERE code IN ('LAUNCH20', 'GODWIN1');

-- TRIAL2 / TRIAL3: self-named test coupons, redeemed only by the
-- founder's own confirmed-test purchases.
UPDATE coupons SET data_classification = 'DEVELOPMENT' WHERE code IN ('TRIAL2', 'TRIAL3');

-- NALIA1: single-use coupon the founder created specifically for, and
-- only ever redeemed by, the confirmed-internal ayerhnathalia
-- transaction. GODWIN2: founder-confirmed as the same kind of
-- internal-transaction tool as NALIA1 (2026-08-02), even though not
-- yet redeemed.
UPDATE coupons SET data_classification = 'INTERNAL' WHERE code IN ('NALIA1', 'GODWIN2');

UPDATE coupon_redemptions SET data_classification = 'DEVELOPMENT'
  WHERE coupon_id IN (SELECT id FROM coupons WHERE code IN ('TRIAL2', 'TRIAL3'));
UPDATE coupon_redemptions SET data_classification = 'INTERNAL'
  WHERE coupon_id IN (SELECT id FROM coupons WHERE code = 'NALIA1');

-- ---------- admin_users ----------
-- Real business/team accounts.
UPDATE admin_users SET data_classification = 'PRODUCTION' WHERE id IN (5, 17, 18, 23);
-- lohrobert11+m62admin@gmail.com - explicit milestone-tagged test
-- admin account.
UPDATE admin_users SET data_classification = 'DEVELOPMENT' WHERE id = 25;

-- ---------- contact_messages / consultation_requests / consultation_notes ----------
-- Both self-labeled "Stability Gate Test" with explicit
-- "please disregard" body text.
UPDATE contact_messages SET data_classification = 'DEVELOPMENT' WHERE id IN (6, 7);

-- Founder's own name/email, description field literally "asd".
UPDATE consultation_requests SET data_classification = 'DEVELOPMENT' WHERE id = 2;
UPDATE consultation_notes SET data_classification = 'DEVELOPMENT'
  WHERE consultation_request_id IN (SELECT id FROM consultation_requests WHERE id = 2);

-- ---------- product_reviews ----------
-- Self-labeled "M6.3 verification" text, never left pending.
UPDATE product_reviews SET data_classification = 'DEVELOPMENT' WHERE id = 2;
-- Genuine testimonial text, but authored by a confirmed real
-- staff/editor account (rloh5014@gmail.com) - internal, not a
-- customer review.
UPDATE product_reviews SET data_classification = 'INTERNAL' WHERE id = 3;

-- ---------- newsletter_subscribers / campaigns / recipients ----------
UPDATE newsletter_subscribers SET data_classification = 'INTERNAL'
  WHERE email IN ('lohrobert11@gmail.com', 'rloh5014@gmail.com');

UPDATE newsletter_subscribers SET data_classification = 'DEVELOPMENT'
  WHERE email LIKE '%@example.com'
     OR email LIKE '%@robayer-internal-test.example'
     OR source IN ('manual-test', 'post-verification-test', 'placeholder-fix-verification')
     OR email LIKE 'diag-insert-%'
     OR email LIKE 'freeguide-live-test-%';

-- ajuik7449@gmail.com, robertloh727@gmail.com, thewatchmansv@gmail.com
-- have no test marker of any kind and no independent identity
-- confirmation - left as UNKNOWN, not touched by this file.

-- The one newsletter campaign is self-labeled "Testing The Robayer
-- WealthLab Newsletter Flow." - and every recipient of it inherits
-- that classification (there is only one campaign in the system).
UPDATE newsletter_campaigns SET data_classification = 'DEVELOPMENT' WHERE id = 1;
UPDATE newsletter_campaign_recipients SET data_classification = 'DEVELOPMENT' WHERE campaign_id = 1;

-- ---------- media_assets ----------
-- The real product's complete, deliberately-organized asset kit
-- (ebook file, cover, spine, mockups, thumbnails, social/OG images)
-- and the real resource's PDF.
UPDATE media_assets SET data_classification = 'PRODUCTION'
  WHERE id IN (13, 14, 15, 16, 17, 18, 19, 20, 21);

-- The current live cover and its earlier design iterations from the
-- V4.2.x cover-redesign work - real, deliberate design output, not
-- fabricated test data, even though most of these are no longer the
-- active cover.
UPDATE media_assets SET data_classification = 'PRODUCTION'
  WHERE id IN (23, 24, 25, 26, 27);

-- A Cloudflare Analytics dashboard screenshot uploaded twice, and a
-- WhatsApp screenshot uploaded three times - incidental Media Library
-- feature-testing duplicates, not real business content.
UPDATE media_assets SET data_classification = 'DEVELOPMENT' WHERE id IN (3, 12, 4, 8, 11);

-- id 9 ("Financial education for building wealth.png"), id 10
-- ("loan-shark-escape-starter-guide_1.pdf"), id 5 (a WhatsApp-sourced
-- image filed in the books folder) don't match any current live
-- product/resource and aren't self-evidently test uploads either -
-- left as UNKNOWN, not touched by this file.

-- ---------- blog_posts ----------
UPDATE blog_posts SET data_classification = 'PRODUCTION' WHERE id = 1;
-- slug "abc"/title "abcd", and a literal "(Copy)" duplicate of post 1.
UPDATE blog_posts SET data_classification = 'DEVELOPMENT' WHERE id IN (2, 3);

-- ---------- products / resources ----------
-- The real, live, purchasable catalog and the real, published free
-- guide - no ambiguity, no test signal anywhere in this engagement's
-- entire history for either.
UPDATE products SET data_classification = 'PRODUCTION';
UPDATE resources SET data_classification = 'PRODUCTION';
