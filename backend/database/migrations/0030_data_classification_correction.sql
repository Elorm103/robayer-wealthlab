-- ============================================================
-- 0030_data_classification_correction.sql — Version 4.9
--
-- 0029 assumed the single existing newsletter_campaigns row had
-- id = 1 without verifying it - it's actually id = 2 (an earlier
-- campaign row was evidently created and removed at some point,
-- consistent with the AUTOINCREMENT gaps already seen elsewhere in
-- this database, e.g. media_assets/coupons). Caught by verifying the
-- result of 0029 immediately after applying it, rather than assuming
-- the UPDATE landed. Same evidence as 0029: subject line literally
-- reads "Testing The Robayer WealthLab Newsletter Flow."
-- ============================================================

UPDATE newsletter_campaigns SET data_classification = 'DEVELOPMENT' WHERE id = 2;
UPDATE newsletter_campaign_recipients SET data_classification = 'DEVELOPMENT' WHERE campaign_id = 2;
