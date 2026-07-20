-- Flagship product repositioning: "Starting to Invest with GH₵100" -> "Small Cedis, Big Wealth"
-- Targeted content-only UPDATE. Does not touch id, product_id, slug, pricing, media
-- references, status, timestamps (except updated_at), or any other table.
-- Purchase history (purchase_sessions) is unaffected: that table snapshots
-- product_title/product_id at time of purchase and is never modified by this file.
--
-- PENDING APPROVAL: do not run until the new positioning is confirmed.
-- Run with: wrangler d1 execute robayer-wealthlab-db --remote --file=./database/migrations/flagship_reposition_2026-07-20.sql

UPDATE products
SET
  title = 'Small Cedis, Big Wealth',
  subtitle = 'How Ordinary Ghanaians Can Build Real Wealth Starting With GH₵1',
  short_description = 'Build real wealth in Ghana, starting with as little as GH₵1. A practical, honest guide to growing your money safely through legitimate, licensed Ghanaian institutions, and avoiding the investment scams targeting people who don''t yet know the warning signs.',
  description = '<p>Building real wealth in Ghana doesn''t require a big salary or insider connections. It requires the right knowledge, applied consistently. This guide shows you exactly how to turn whatever you have today, even GH₵1, into a real, growing habit of saving and investing, using legitimate institutions you can actually access from a Ghanaian MoMo wallet or bank account.</p>

<h2>Why this guide was written</h2>
<p>For years, investing felt like something reserved for people with money, connections, or financial schooling most Ghanaians don''t have. At the same time, too many hardworking people (market traders, civil servants, young professionals) have lost hard-earned savings to investment schemes promising impossible returns, simply because reliable financial education was never available to them.</p>
<p>Robayer WealthLab was built to close that gap: to separate real, regulated opportunities from hype, and to help ordinary Ghanaians make confident financial decisions instead of fearful or uninformed ones. This guide is the first step in that mission: practical, honest, and built entirely around legitimate wealth-building methods, never "get rich quick" promises.</p>
<p>That''s exactly what Chapter 8 exists for: a dedicated breakdown of the warning signs behind real investment scams operating in Ghana today, and a step-by-step checklist to protect your money before you invest a single cedi.</p>

<h2>What you''ll learn</h2>
<ul>
<li>How to turn Mobile Money into a real, automatic savings habit using Pesewa Susu, Yello Save, and EasySave, so it becomes more than just a spending wallet</li>
<li>How to buy your first Treasury Bill in Ghana, step by step, with no prior experience needed</li>
<li>How to grow your money through money market funds and mutual funds, without tracking markets yourself</li>
<li>How to start investing on the Ghana Stock Exchange, explained in plain language</li>
<li>How to tell a real, licensed Ghanaian investment platform from a scam wearing its name</li>
<li>A realistic 6-month plan for turning what you have today into a real, diversified portfolio</li>
</ul>

<h2>Who this guide is for</h2>
<p><strong>This guide is for you if</strong></p>
<ul>
<li>You''re starting with GH₵1 or GH₵100 and want a real, step-by-step plan</li>
<li>You''ve never bought a Treasury Bill or touched the GSE before</li>
<li>You want plain answers and real Ghanaian examples, not jargon</li>
</ul>
<p><strong>It''s probably not for you if</strong></p>
<ul>
<li>You''re looking for get-rich-quick tactics or guaranteed returns</li>
<li>You already actively trade on the GSE</li>
<li>You want one-on-one financial advice; this is education, not advice</li>
</ul>

<h2>Inside the guide</h2>
<ol>
<li>Introduction: Why Small Money Can Build Big Wealth in Ghana</li>
<li>Chapter 1: Mobile Money Susu &amp; Digital Savings Wallets</li>
<li>Chapter 2: Treasury Bills, Ghana''s Safest Real Investment</li>
<li>Chapter 3: Money Market Funds &amp; Mutual Funds</li>
<li>Chapter 4: IC Wealth and Other Licensed Wealth Platforms, and a Warning You Need to Read</li>
<li>Chapter 5: The Ghana Stock Exchange, Owning a Piece of Real Companies</li>
<li>Chapter 6: Traditional Bank Savings &amp; Fixed Deposits</li>
<li>Chapter 7: Petty Trading &amp; Skills, Your Highest-Return Asset Is You</li>
<li>Chapter 8: How to Spot and Avoid Investment Scams in Ghana</li>
<li>Chapter 9: Your 6-Month Action Plan</li>
</ol>
<h3>Bonus resources included</h3>
<ul>
<li>A complete Frequently Asked Questions section</li>
<li>Bonus Chapter: 10 Biggest Money Mistakes Ghanaians Make</li>
<li>The 30-Day Wealth Challenge: a daily, one-task-at-a-time action plan</li>
<li>The Investment Due-Diligence Checklist: a 9-point checklist to run before investing in anything new</li>
<li>The Financial Goal Worksheet, with a built-in net worth tracker</li>
<li>Official Resource Links to Bank of Ghana, SEC Ghana, the Ghana Stock Exchange, and other licensed institutions</li>
<li>A full Glossary and a side-by-side comparison of every option covered</li>
</ul>

<h2>Frequently asked questions</h2>
<h3>Can students invest with these small amounts?</h3>
<p>Yes. Every option in this book, from digital savings wallets to Treasury Bills, accepts amounts well within a student budget. Start with Chapter 1 and build up from there.</p>
<h3>Can I invest using only MoMo, without a bank account?</h3>
<p>For many products, yes: Pesewa Susu, EasySave, and mobile-money-based Treasury Bill routes like TBILL4ALL all work directly from a MoMo wallet. Some mutual funds and stockbroking accounts may still require linking a bank account eventually.</p>
<h3>Do I pay tax on these investments?</h3>
<p>As of mid-2026, Treasury Bill interest is not subject to withholding tax, while bank fixed deposits attract an 8% withholding tax. Fund and stock taxation depends on the product. Always confirm current rules with your provider, as tax treatment can change.</p>
<h3>Can I withdraw my money anytime?</h3>
<p>It depends on the product. Digital savings wallets and money market funds are generally flexible (often within one business day). Treasury Bills and fixed deposits are locked until maturity. Stocks can typically be sold within a few business days, but their value may be up or down when you do.</p>
<h3>How much should I start with?</h3>
<p>Start with whatever you can comfortably save without affecting your essential expenses. Even GH₵1–20 in a digital savings wallet is a valid starting point. Consistency matters more than the size of your first deposit.</p>
<h3>Is any of this guaranteed to make me rich?</h3>
<p>No, and be wary of anyone who tells you otherwise. This book is about steady, realistic, compounding growth using regulated products, not guaranteed riches.</p>',
  tags = 'ebook, beginners, treasury bills, mobile money, susu, ghana stock exchange, money market funds, savings',
  seo_title = 'Small Cedis, Big Wealth | Robayer WealthLab',
  seo_description = 'A practical Ghanaian wealth guide covering mobile money susu, Treasury Bills, money market funds, and the GSE, for anyone starting with as little as GH₵1.',
  updated_at = datetime('now')
WHERE slug = 'starting-to-invest-with-gh100'
  AND deleted_at IS NULL;
