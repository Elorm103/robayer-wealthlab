# Media Library Asset Replacement Procedure

Internal maintenance doc. Follow this whenever a real file backing a `media_assets` row needs to be swapped out directly (bypassing the admin Media Library upload UI, e.g. for a bulk/scripted content update like a manuscript revision) — not needed for a normal admin-panel upload, since `mediaService.uploadMedia()` already keeps R2 and D1 in sync automatically.

## Why this exists

On 2026-07-24, a flagship eBook manuscript was replaced by writing directly to R2 via `wrangler r2 object put`, bypassing `mediaService.uploadMedia()`. The R2 object itself updated correctly, but the corresponding `media_assets` row's `size_bytes`, `content_hash`, and `updated_at` columns were never touched, since raw R2 CLI writes have no knowledge of that table. The row sat silently stale (pointing at the *old* file's metadata) until caught by manual inspection.

Separately, that same investigation surfaced a real, if narrower, lesson: verifying an R2 write by immediately re-reading it with `wrangler r2 object get` is not equivalent to verifying it through the path that actually matters. The CLI and the Worker's own `env.STORAGE` binding are two different clients against the same bucket; a rapid sequence of CLI calls can be rate-limited by Cloudflare's API in ways that don't always surface as a clean error on every call, which cost significant time chasing what looked like a bucket-level bug but wasn't one. **The Worker binding is the only verification that actually matters** — it's what real customer downloads use.

## The procedure

1. **Upload the new object to its existing storage key** via `wrangler r2 object put {bucket}/{key} --file={path} --content-type={type} --remote`. Never invent a new key for a replacement; the existing key is already referenced by `media_assets.storage_key` and, transitively, by every `product_files`/`resources` row pointing at it.
2. **Verify through the Worker binding, not the CLI.** A CLI `object get` immediately after a CLI `object put` proves the CLI can talk to the bucket; it does not prove the live site sees the new file. Confirm via an actual Worker code path that calls `env.STORAGE.get()`, ideally one already used in production (e.g. temporarily instrumenting the real download route, or a dedicated, removed-after-use diagnostic endpoint). Check the real, meaningful signals: size, a content fingerprint (e.g. the file's first bytes / header), and freshness (`uploaded` timestamp on the R2 object).
3. **Only after step 2 passes**, update the `media_assets` row's `size_bytes`, `content_hash` (SHA-256 of the exact bytes uploaded), and `updated_at`. Do this with a targeted `UPDATE ... WHERE storage_key = ?`, never a broader statement, and never before the storage-side write is independently confirmed, updating the database first and the storage second (or not at all) leaves the metadata lying about a file that was never actually delivered.
4. **Confirm the real customer path**, not just the binding in isolation, end to end through the actual entitlement/download-token flow a purchaser uses (`POST /api/purchases/:reference/downloads` → `GET /api/download/:token`), using an existing verified purchase if one is available rather than manufacturing new test data. Compare the downloaded bytes against the source file directly (`cmp`/hash), not just a status code.
5. **Remove any temporary diagnostic code** added for step 2, and redeploy, before considering the task done. A diagnostic route that writes to storage should never be left reachable, even briefly, longer than the investigation needs it.

## The one governing rule

**R2 and D1 must never be updated independently of each other for the same asset.** If you touch one, verify it, then touch the other, in that order, every time. A `media_assets` row that doesn't match its real R2 object is worse than no row at all: every part of this codebase (the admin UI, the public product page, the download system) trusts that row's metadata without re-checking it against storage.
