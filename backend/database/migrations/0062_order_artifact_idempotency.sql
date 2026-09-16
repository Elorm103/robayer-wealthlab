-- ============================================================
-- 0062_order_artifact_idempotency.sql
--
-- Security remediation (High Finding H2, security audit 2026-09-15):
-- defense-in-depth against duplicate order_items/receipts/licenses
-- rows. Today, correctness depends entirely on createOrderArtifacts()
-- having exactly one caller (completeVerifiedPurchase()), itself
-- protected by the atomic purchase_sessions status transition
-- (verifySessionAtomic()) — see docs/payment-verification.md. That
-- remains the primary control and is untouched by this migration.
-- This adds the same database-level backstop `payment_transactions`,
-- `deliveries`, `coupon_redemptions` and `affiliate_commissions`
-- already independently have, so a future code path that re-invokes
-- createOrderArtifacts() for an already-processed session fails loudly
-- at the database layer instead of silently duplicating financial
-- records.
--
-- Verified against production data before writing this migration:
-- zero existing purchase_session_id appears more than once in either
-- order_items or receipts (createOrderArtifacts() has only ever
-- created exactly one row per purchase — see that function's own
-- comment, "single-product-per-order today"), so both UNIQUE indexes
-- below apply cleanly with no pre-migration cleanup needed.
--
-- licenses is structurally different: ADR-009 deliberately creates one
-- row per seat for a quantity > 1 purchase (ORDER_ITEMS itself never
-- has more than one row, but its own `quantity` column can exceed 1 —
-- the licenses loop in orderService.ts creates that many rows). A bare
-- UNIQUE(purchase_session_id) would incorrectly reject the second,
-- legitimate seat of any such purchase. seat_index (0-based, matching
-- the existing loop's own `seat` variable) makes each seat's row
-- distinct while still closing the same duplicate-insert gap:
-- inserting seat 0 twice for one purchase is now rejected, exactly as
-- inserting the same order_items/receipts row twice now is. Existing
-- rows default to seat_index = 0, safe because production has zero
-- purchase_session_id with more than one licenses row today (the same
-- check run above covers this table too) — every existing purchase so
-- far had quantity = 1.
-- ============================================================

CREATE UNIQUE INDEX idx_order_items_purchase_session_unique ON order_items(purchase_session_id);

-- Named _unique to avoid colliding with migration 0019's pre-existing
-- plain (non-unique) idx_receipts_purchase_session, created for lookup
-- performance on the same column — left untouched, now redundant but
-- harmless alongside this one.
CREATE UNIQUE INDEX idx_receipts_purchase_session_unique ON receipts(purchase_session_id);

ALTER TABLE licenses ADD COLUMN seat_index INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_licenses_purchase_session_seat ON licenses(purchase_session_id, seat_index);
