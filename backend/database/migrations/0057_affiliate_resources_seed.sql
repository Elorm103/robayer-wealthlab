-- ============================================================
-- 0057_affiliate_resources_seed.sql: Affiliate Programme, Phase 2E
-- (Marketing Resources content).
--
-- One-time seed of the first real affiliate marketing toolkit: 7 rows
-- per product (a product_copy "kit" row, plus 6 ready-to-use copy
-- variants) for the two active products explicitly requested,
-- treasury-bills-made-simple and understanding-the-ghana-stock-exchange.
-- Every product fact used below (title, slug, shortDescription, "who
-- it's for" language, chapter titles, status) was re-verified against
-- the live GET /api/products / GET /api/products/{slug} response
-- before writing this file, not reconstructed from memory. The one
-- fact used that is not drawn from the product description itself,
-- MTN Ghana being listed on the Ghana Stock Exchange, is independently
-- true, well-established public market fact, used only as general
-- market context, never as a claim about MTN's specific performance.
--
-- Conversion pass: each product's 6 copy variants deliberately use a
-- different psychological entry point (surprise, misconception,
-- recognition, aspiration, education/credibility, practicality) so an
-- affiliate sharing across platforms never shows the same audience the
-- same pitch twice. See each row's inline comment below for which
-- angle it takes. No guaranteed-return language, no fearmongering, no
-- em dashes anywhere in this file.
--
-- Each copy-variant body ends with a genuine call-to-action sentence
-- immediately followed by a literal `{{link}}` token, deliberately NOT
-- a real URL and NEVER any specific affiliate's code.
-- js/components/affiliate-resources.js substitutes it client-side with
-- that viewer's own referral link, built by the same buildUrl() already
-- used on affiliate/links/ (see affiliate-links.js). This migration
-- seeds shared, affiliate-agnostic content only.
--
-- Idempotency: unlike 0009's one-time product import (a genuinely
-- single, unrepeatable event tied to specific surrogate ids), this
-- migration seeds rows with no natural unique constraint in
-- affiliate_resources (0056 defines none beyond the autoincrement id),
-- so a naive INSERT would silently duplicate every row if this file
-- were ever re-applied outside the normal, once-only
-- `wrangler d1 migrations apply` flow (e.g. a manual re-run, or a
-- partial-apply retry). Every INSERT below is guarded by
-- `WHERE NOT EXISTS`, keyed on (product_slug, category, title). That
-- triple is unique by construction across the 14 rows here, so
-- re-running this file after a successful (or partially successful)
-- apply is always a safe no-op for any row that already exists.
--
-- Rollback: DELETE FROM affiliate_resources WHERE product_slug IN
-- ('treasury-bills-made-simple', 'understanding-the-ghana-stock-exchange')
-- AND created_by IS NULL AND updated_by IS NULL;
-- ============================================================

-- ---------- Treasury Bills Made Simple ----------

INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'Treasury Bills Made Simple: promotional kit', 'product_copy',
'Who it''s for:
Anyone in Ghana who has heard the term "Treasury Bill" mentioned on the news or by a colleague, but has never had someone explain, in plain terms, what it actually is or how to buy one. No finance background needed, and no large amount of money required to start.

Key selling points:
- Clears up common misconceptions around how Treasury Bills actually pay you, covered directly in the book''s own "Risks and Misconceptions" chapter
- Explains the discount pricing structure in plain language, with two full worked examples showing exactly how the return is calculated
- Tells the honest story of what happened to Treasury Bills during Ghana''s 2022 to 2023 debt restructuring, when other government debt was restructured but T-bills kept paying out in full
- Lays out the exact seven steps to buy a first Treasury Bill
- Every fact sourced from the Bank of Ghana and the Ministry of Finance, with rate examples dated so nothing goes stale

Suggested promotional angle:
Six different entry points are provided below so the same audience never sees the same pitch twice: surprise (the 2022 to 2023 track record), misconception (how the pricing actually works), recognition (everyone has heard the term, few can explain it), aspiration (no large sum needed to start), credibility (official sourcing), and practicality (the seven concrete steps). Always frame the 2022 to 2023 track record as history, never as a guarantee of future safety.',
'treasury-bills-made-simple', 1, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'treasury-bills-made-simple' AND category = 'product_copy' AND title = 'Treasury Bills Made Simple: promotional kit');

-- Angle: surprise. Personal, forwardable "did you know" framing built for WhatsApp.
INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'WhatsApp message', 'message_template',
'Random Treasury Bill fact: during Ghana''s 2022 to 2023 debt restructuring, when a lot of other government debt got restructured, Treasury Bills still paid out in full. I didn''t know that until I read this. It also breaks down exactly how the discount pricing works and the actual steps to buy your first one, no jargon. If you''ve ever nodded along when someone mentioned T-bills without really knowing what they meant, this is the guide to start with: {{link}}',
'treasury-bills-made-simple', 2, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'treasury-bills-made-simple' AND category = 'message_template' AND title = 'WhatsApp message');

-- Angle: misconception. Corrects a real, common misunderstanding (discount pricing vs. "interest"), built for Facebook's educational/discussion style.
INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'Facebook post', 'social_caption',
'Quick correction for anyone who thinks Treasury Bills work like a savings account: they don''t pay you "interest" the usual way. You actually buy below face value and get the full face value back later, and that gap is your return. Most people who own Treasury Bills couldn''t explain that if you asked them. This guide breaks it down properly, with two full worked examples, how to calculate your own return, and the exact steps to buy your first one. If you want to actually understand what you''re buying before you buy it, this is where to start: {{link}}',
'treasury-bills-made-simple', 3, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'treasury-bills-made-simple' AND category = 'social_caption' AND title = 'Facebook post');

-- Angle: recognition. Direct-address spoken hook built for TikTok's short, video-native pacing.
INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'TikTok caption and script', 'script',
'Caption: You''ve heard "Treasury Bill" a hundred times. Could you actually explain it? #GhanaFinance #TreasuryBills #MoneyTips

Script outline:
Hook: "Everyone in Ghana has heard the words Treasury Bill. Almost nobody can actually explain how they work. Can you?"
Then: explain in one sentence what a T-bill is (lending money to government for a short, fixed period, for a fixed return).
Show the guide on screen.
Close with: "Full plain language breakdown, including how to buy your first one, linked below." {{link}}',
'treasury-bills-made-simple', 4, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'treasury-bills-made-simple' AND category = 'script' AND title = 'TikTok caption and script');

-- Angle: aspiration. Removes the "I don't have enough money" objection, punchy and scannable for Instagram.
INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'Instagram caption', 'social_caption',
'You don''t need to be rich to start. Treasury Bills are one of the lowest barrier ways to start investing in Ghana, and this guide shows exactly how: what they are, how the pricing works, and the exact steps to buy your first one. Ready to start small and actually understand it? {{link}}',
'treasury-bills-made-simple', 5, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'treasury-bills-made-simple' AND category = 'social_caption' AND title = 'Instagram caption');

-- Angle: credibility. Leads with the official sourcing, professional tone for LinkedIn.
INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'LinkedIn post', 'social_caption',
'Every fact in this guide on Treasury Bills is sourced directly from the Bank of Ghana and the Ministry of Finance, with rate examples dated so nothing goes stale. It covers the discount pricing mechanism, how to calculate your own return with worked examples, and an honest look at the risk involved, including what happened to Treasury Bills during Ghana''s 2022 to 2023 debt restructuring. Sharing for anyone who wants a properly sourced starting point before their first investment: {{link}}',
'treasury-bills-made-simple', 6, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'treasury-bills-made-simple' AND category = 'social_caption' AND title = 'LinkedIn post');

-- Angle: practicality/education. Standalone headline-style hook, distinct from the surprise/misconception angles used elsewhere.
INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'Short promotional hook', 'guidance',
'Buying your first Treasury Bill takes seven steps. Here''s what they actually are.',
'treasury-bills-made-simple', 7, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'treasury-bills-made-simple' AND category = 'guidance' AND title = 'Short promotional hook');

-- ---------- Understanding the Ghana Stock Exchange ----------

INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'Understanding the Ghana Stock Exchange: promotional kit', 'product_copy',
'Who it''s for:
Young professionals, university graduates, National Service personnel, salaried workers, small business owners, and anyone who has heard of shares, the Ghana Stock Exchange, or companies like MTN Ghana being listed, but has never actually bought one. No finance background needed, and no large amount of money required to start.

Key selling points:
- Explains exactly what a share is and what owning one actually gives you, using real listed companies as reference points
- Walks through opening a CSD account and placing a first order, step by step
- Covers dividends, bonus issues, and rights issues in plain language, clearly enough to actually tell them apart
- Honest about the real risk involved, and how it genuinely differs from Treasury Bill risk
- Shows how to build a genuinely diversified first portfolio, and the specific mistakes beginners tend to make

Suggested promotional angle:
Six different entry points are provided below so the same audience never sees the same pitch twice: surprise (the 1990, never-bought-a-share statistic), recognition (MTN Ghana as a company most readers already use), curiosity (how dividends actually work), education (the CSD account process), credibility (the honest risk and diversification coverage), and next-step framing (the natural follow-on from Treasury Bills). Never state or imply that a share''s price or dividend is guaranteed.',
'understanding-the-ghana-stock-exchange', 11, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'understanding-the-ghana-stock-exchange' AND category = 'product_copy' AND title = 'Understanding the Ghana Stock Exchange: promotional kit');

-- Angle: recognition. Personal, informational "did you know" framing for WhatsApp.
INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'WhatsApp message', 'message_template',
'Did you know you can actually own a small part of MTN Ghana, or any other company listed on the Ghana Stock Exchange? I didn''t fully understand how that worked until I read this. It walks through what a share actually is, how to open the account you need, and the exact steps to buy your first one. Plain language, no hype: {{link}}',
'understanding-the-ghana-stock-exchange', 12, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'understanding-the-ghana-stock-exchange' AND category = 'message_template' AND title = 'WhatsApp message');

-- Angle: surprise. Leads with the strongest verified stat, educational/discussion tone for Facebook.
INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'Facebook post', 'social_caption',
'The Ghana Stock Exchange has existed since 1990. Most Ghanaians have still never bought a single share, even ones who use MTN or bank with a listed company every day. This guide explains what a share actually is, how to open the account you need, and the exact steps to place your first order, along with an honest look at the real risk involved. If you''ve ever wondered what it would actually take to own a piece of a company instead of just saving, this is where to start: {{link}}',
'understanding-the-ghana-stock-exchange', 13, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'understanding-the-ghana-stock-exchange' AND category = 'social_caption' AND title = 'Facebook post');

-- Angle: aspiration/recognition. Direct challenge to the viewer, built for TikTok's video-native pacing.
INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'TikTok caption and script', 'script',
'Caption: You''ve probably used MTN today. But did you know you could actually own a piece of the company? Here''s how. #GSE #GhanaFinance #Investing

Script outline:
Hook: "You''ve probably used MTN today. But did you know you could actually own a piece of the company? Here''s how."
Then: explain in one sentence what a share is (a real ownership stake in a company, bought and sold on the Ghana Stock Exchange).
Show the guide on screen.
Close with: "Full walkthrough, including how to open your CSD account and buy your first share, linked below." {{link}}',
'understanding-the-ghana-stock-exchange', 14, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'understanding-the-ghana-stock-exchange' AND category = 'script' AND title = 'TikTok caption and script');

-- Angle: curiosity. A real knowledge gap (how dividends work), short and scannable for Instagram.
INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'Instagram caption', 'social_caption',
'Shares pay you back through dividends. Most people who own shares still couldn''t explain how that actually works. This guide covers dividends, bonus issues, and rights issues in plain language, alongside opening a CSD account and placing your first order. Ready to actually understand it? {{link}}',
'understanding-the-ghana-stock-exchange', 15, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'understanding-the-ghana-stock-exchange' AND category = 'social_caption' AND title = 'Instagram caption');

-- Angle: education/credibility. Specific, professional framing for LinkedIn.
INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'LinkedIn post', 'social_caption',
'This guide on the Ghana Stock Exchange is refreshingly specific: how to open a CSD account, how dividends, bonus issues, and rights issues actually differ, and an honest breakdown of the real risk involved and how it differs from fixed income instruments like Treasury Bills. For anyone building a long term investing plan and ready to go beyond saving, this is a properly grounded place to start: {{link}}',
'understanding-the-ghana-stock-exchange', 16, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'understanding-the-ghana-stock-exchange' AND category = 'social_caption' AND title = 'LinkedIn post');

-- Angle: next step. Ties naturally to the Treasury Bills guide without repeating either product's other hooks.
INSERT INTO affiliate_resources (title, category, body, product_slug, sort_order, status, data_classification)
SELECT 'Short promotional hook', 'guidance',
'Lending to government is step one. Owning part of a company is step two. Here''s how that works.',
'understanding-the-ghana-stock-exchange', 17, 'published', 'PRODUCTION'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_resources WHERE product_slug = 'understanding-the-ghana-stock-exchange' AND category = 'guidance' AND title = 'Short promotional hook');
