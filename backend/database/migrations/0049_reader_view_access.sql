-- ============================================================
-- 0049_reader_view_access.sql — Digital Library Phase 7A (Personal
-- Learning Library, Reader Foundation). Establishes "view" as a
-- second, non-consuming purpose for the EXISTING download_tokens/
-- deliveries mechanism, rather than a second download mechanism —
-- per the Phase 7 architecture: Read must never increment
-- deliveries.downloads_used, but must reuse the exact same
-- token-mint -> atomic-redeem pipeline entitlementService.ts already
-- uses for real downloads, not a parallel one.
--
-- download_tokens.purpose: which grant a given single-use token was
-- minted for. 'download' is the default so every pre-existing row
-- (and every row inserted by unmodified download-request code) reads
-- correctly with zero backfill needed. redeemDownloadToken() branches
-- on this column at redemption time: 'download' still calls the
-- unchanged incrementDownloadUsageAtomic(); 'view' calls a new,
-- separate, non-incrementing check instead.
--
-- deliveries.last_viewed_at: mirrors last_download_at, but for reader
-- opens specifically. Kept as its own column rather than overloading
-- last_download_at, since a "last opened to read" timestamp and a
-- "last downloaded" timestamp are genuinely different facts once Read
-- stops being a download.
--
-- Both additive and nullable/defaulted — no backfill required, no
-- existing query's meaning changes.
--
-- Rollback: `ALTER TABLE download_tokens DROP COLUMN purpose;` and
-- `ALTER TABLE deliveries DROP COLUMN last_viewed_at;` — safe, nothing
-- else in the schema depends on either column.
-- ============================================================

ALTER TABLE download_tokens ADD COLUMN purpose TEXT NOT NULL DEFAULT 'download' CHECK (purpose IN ('download', 'view'));

ALTER TABLE deliveries ADD COLUMN last_viewed_at TEXT;
