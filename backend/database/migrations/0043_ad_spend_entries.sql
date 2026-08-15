-- ============================================================
-- 0043_ad_spend_entries.sql — P0-B, first component of the Business
-- Intelligence backbone. Manual advertising-spend capture, hybrid-
-- ready: `source` lets a future Meta Ads Insights sync or CSV
-- importer write to this exact table later, with no redesign.
--
-- Deliberately campaign-level only, not ad-set/ad-level — the current
-- UTM/attribution chain (see the P0-B investigation) cannot yet
-- distinguish ad-set or ad-level performance, so finer columns today
-- would store nothing meaningful. `campaign_label` is free text, not
-- a foreign key — no Meta campaign-ID capture exists yet to key
-- against.
--
-- `amount_minor_units` + `currency`: stored exactly as entered, in
-- its original currency — this table NEVER converts currency. A
-- blended/normalized view, if ever needed, computes that at
-- query/display time with an explicit visible rate, never bakes a
-- conversion into a stored value.
--
-- Soft-delete only (deleted_at) — matches payment_transactions'
-- "financial records are never hard-deleted" convention. A spend
-- entry is corrected by editing or withdrawn by soft-delete, never
-- destroyed.
--
-- Rollback: `DROP TABLE ad_spend_entries;` — safe, nothing else
-- references this table yet.
-- ============================================================

CREATE TABLE ad_spend_entries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date          TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'meta' CHECK (source IN ('meta', 'google', 'linkedin', 'other')),
  campaign_label      TEXT NOT NULL,
  amount_minor_units  INTEGER NOT NULL CHECK (amount_minor_units >= 0),
  currency            TEXT NOT NULL,
  notes               TEXT,
  created_by          INTEGER NOT NULL REFERENCES admin_users(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at          TEXT
);

CREATE INDEX idx_ad_spend_entries_date ON ad_spend_entries(entry_date);
CREATE INDEX idx_ad_spend_entries_source ON ad_spend_entries(source);
CREATE INDEX idx_ad_spend_entries_campaign ON ad_spend_entries(campaign_label);
