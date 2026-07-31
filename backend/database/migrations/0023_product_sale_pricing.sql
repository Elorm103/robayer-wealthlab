-- ============================================================
-- 0023_product_sale_pricing.sql — Version 3.4.2 Milestone M6.2
-- (Product CMS Repair & Dynamic Pricing Enhancement)
--
-- Adds a genuine scheduled-sale model on top of the existing
-- `price_pesewas` (the product's regular price, unchanged meaning).
-- Deliberately does not repurpose the existing `compare_at_price_pesewas`
-- column: that field's own validation ("compare-at must be higher than
-- price") already models a different, static "was/now" display with no
-- schedule, and reversing its meaning here would silently invert what
-- any future code reading it assumes. Four new, purpose-named columns
-- avoid that ambiguity entirely.
--
-- sale_price_pesewas — the discounted price while the sale is active.
--   Nullable: a product with no sale simply never sets this.
-- sale_enabled — the admin's own on/off switch. A sale with a real
--   price and valid dates does nothing unless this is also true —
--   matches this project's existing "explicit, not inferred" posture
--   for anything that changes what a customer pays (see
--   docs/commerce-foundation.md's pricing section).
-- sale_starts_at — nullable. NULL means "active immediately once
--   enabled," not "never starts" — see productService.ts's
--   computeSaleState() for the exact evaluation order.
-- sale_ends_at — nullable. NULL means "runs indefinitely until
--   disabled," not "never active." When set, this is also what the
--   storefront countdown counts down to, and what a Cron sweep (added
--   in this same milestone) uses to know when to flip sale_enabled
--   back to 0 automatically.
--
-- The actual price a customer pays is never read directly from either
-- column by checkout — services/productService.ts's computeSaleState()
-- is the one place "is the sale currently active" is decided, and
-- services/commerceService.ts calls it at checkout time, matching
-- routes/checkout.ts's existing "never trust a client-supplied price"
-- rule (this is the same rule, just extended to a second, schedule-
-- dependent price rather than only the static one).
--
-- Rollback: `ALTER TABLE products DROP COLUMN sale_price_pesewas;`
-- (repeat for the other three). Safe at any time — no other table
-- references these columns, and every read of them in
-- productService.ts's computeSaleState() treats a missing/null value
-- as "no sale," the same as this migration's own default state.
-- ============================================================

ALTER TABLE products ADD COLUMN sale_price_pesewas INTEGER;
ALTER TABLE products ADD COLUMN sale_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN sale_starts_at TEXT;
ALTER TABLE products ADD COLUMN sale_ends_at TEXT;
