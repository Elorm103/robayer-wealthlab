# Version 2.0 — Media Library Specification

**Grounding:** the real R2 bucket (`robayer-wealthlab-storage`) exists, has exactly one confirmed real object (`ebooks/starting-to-invest-with-gh100.pdf`), and has never had an upload pipeline of any kind — every object in it today was placed manually via `wrangler r2 object put`. This spec is the first real upload capability this platform will have.

**Status: built (Version 2.0 Phase 1), deployed to production.** This
document is the original pre-build design. Three sections — "Serving
uploaded media," "Delete," and "Search" below — turned out to diverge
from what was actually implemented once real requirements (an explicit
"Copy URL" feature, no scheduled-task infrastructure existing in this
project, a `title`/`tags` search requirement) were in scope; each of
those sections now has an "As built" note explaining the real behavior
and why it changed. Everything else on this page (the upload pipeline
shape, folders-as-tags, replace-writes-a-new-key) matches what shipped.
Real schema: `backend/database/migrations/0007_media_library.sql`.
Real code: `backend/services/mediaService.ts`,
`backend/routes/admin/media.ts`, `backend/routes/media.ts`.

---

## Upload pipeline (every file, every module — Products, Blog, Resources all funnel through this one path)

```
1. Frontend: js/components/admin/upload.js — drag-drop or file-picker, client-side
   pre-check (file size, extension) purely for fast user feedback — NEVER the
   security boundary, which is entirely server-side (see below).
2. POST /api/admin/media (multipart/form-data), requireAuth + requireRole(editor+) + csrf.
3. Server-side validation, in this exact order, reject-fast:
   a. Size ceiling by type (images: 5MB, PDFs: 25MB, matching realistic real-world
      file sizes for this content — the real eBook PDF is 89KB, so 25MB is generous
      headroom, not a loophole).
   b. Content-type allowlist checked against the ACTUAL file bytes (magic number),
      never the client-supplied Content-Type header alone — a file claiming to be a
      JPEG is opened and its real signature checked (FFD8FF for JPEG, 89504E47 for
      PNG, %PDF for PDF) before anything is trusted.
   c. Filename sanitization: strip path separators, control characters, restrict to
      a safe charset — prevents path traversal into an unintended R2 prefix.
   d. Generate the real storage key following the established convention
      ({type}/{slug-or-uuid}.{ext}) — never trust a client-supplied key.
4. PUT to R2 (STORAGE binding) — the Worker is still, as it is today for downloads,
   the only code that ever touches this binding directly.
5. INSERT a media_assets row (filename, content_type, size, storage_key, folder,
   uploaded_by).
6. auditService.record('media.uploaded').
7. Return the real object's public-facing reference (for images: a URL the public
   site can render; for PDFs: never a direct public URL — see "Serving" below).
```

## Serving uploaded media

**Images (covers, thumbnails, blog featured images, brand assets):** genuinely public — served directly, the same way `assets/branding/` images already are today. No access control needed; these were always meant to be publicly visible.

**PDFs (paid product files, resource downloads):** **never served via a public/direct R2 URL** — continues to use the exact existing, proven `GET /api/download/:token` pattern (entitlement or resource-download-token gated). The Media Library's "preview" action for a PDF uses a short-lived admin-only signed fetch (reusing the same token-generation utility, just scoped to admin session validity rather than a purchase) — never a permanent public link to a paid asset, even for the admin's own preview.

**As built:** this section assumed every PDF a future admin uploads
would be *paid* content, matching the one real PDF in R2 at the time
this was written (the eBook). The actual Phase 1 brief asked for a
general-purpose CMS asset manager — free resource guides, downloadable
one-pagers, anything meant to be linked from the public site — with an
explicit "Copy public URL" feature as a stated requirement, not an
oversight. So Media Library PDFs (and images) are served through one
uniform, unauthenticated, public route: `GET /api/media/file/:key`
(`backend/routes/media.ts`), matching the images' trust model exactly,
not the paid-download token model. This is a **deliberate scope split**,
not a security regression: Media Library never handles *paid* product
files — those still exist entirely outside this system, in
`content/products/*.json` + `deliveries`/`download_tokens` +
`GET /api/download/:token`, completely untouched by this phase. The
public media route only ever serves a key it can find as a live,
non-deleted row in `media_assets`; the one real legacy paid key
(`ebooks/starting-to-invest-with-gh100.pdf`) was never inserted into
that table and was confirmed, by live adversarial test, to 404 through
this route. If a future phase ever wants to sell a Media-Library-
uploaded PDF, that item would need to be re-registered through the
existing paid-entitlement system, not exposed as-is.

## Folders

**A logical tag on `media_assets.folder`, not a real nested R2 prefix hierarchy.** R2 (like all S3-compatible object storage) has no true folder concept — prefixes only simulate one. Building a real drag-between-folders nested tree UI would be solving a problem that doesn't structurally exist, for a media library that (realistically, at this platform's scale) will hold dozens to low hundreds of objects, not tens of thousands. A flat list with a filterable "folder" tag (Books, Blog, Resources, Icons, Brand) gives the organizational benefit without the complexity of building and maintaining a real hierarchical file-tree UI component this project has no other use for.

## Search

Filename substring match (client-debounced, server-executed against `media_assets.filename`) — no need for anything more sophisticated (no full-text/fuzzy search) at this realistic scale.

**As built:** the Phase 1 brief explicitly asked for "search by
filename/title/tag/folder/type," so the implemented query
(`mediaService.ts`'s `listMedia()`) matches against `filename`,
`original_filename`, `title`, and `tags` together (one `LIKE ...ESCAPE
'\'` per column, OR'd) rather than filename alone — still a plain
substring match, no full-text/fuzzy search added, just a wider set of
columns than this section originally scoped.

## Replace

Uploads a new object, updates the *existing* `media_assets` row's `storage_key` to point at it (a new R2 key is generated, not an overwrite-in-place — R2 objects are treated as immutable once referenced, avoiding any risk of a CDN/browser cache serving a stale cached version of the "same" URL with different content, a real class of bug this deliberately avoids by construction). The **old** R2 object is not immediately deleted — see Delete/retention below.

## Delete

**Soft delete only, with a real usage check first.** Before allowing delete, the Worker checks whether the asset's `storage_key` is still referenced by any `content/products/*.json` file, any `blog_posts` row, or any `resources` row. If it is, the delete is blocked with a specific message ("This image is used on 2 products — remove it from them first") rather than silently breaking a live page. If genuinely unused, `media_assets.deleted_at` is set (hidden from the library UI) but **the real R2 object is retained for 30 days** before a scheduled cleanup task actually removes it — a real, cheap safety margin against an accidental delete, matching this project's established disaster-recovery discipline (`docs/disaster-recovery.md`'s existing "the real eBook PDF exists only in R2 with no backup" finding is exactly the kind of risk this retention window exists to soften).

**As built — two real gaps against this section, both known and
deliberate, not overlooked:**

1. **No usage check before delete.** At the time Phase 1 shipped,
   nothing in this codebase (Products, Blog, Resources) actually
   *consumes* a Media Library asset yet — the Products module is a
   later, not-yet-built phase (see `docs/v2-product-management-spec.md`),
   and there is no `blog_posts`/`resources` table in the schema today.
   A usage check against tables that don't exist would be dead code
   pretending to be a safety feature. `softDeleteMedia()` deletes
   unconditionally; this section's usage-check behavior needs to be
   revisited *when* Products actually starts referencing
   `media_assets.storage_key`, not before.
2. **No scheduled R2 cleanup, no 30-day retention window.** This
   project has no scheduled-task (Cron Trigger) infrastructure at all
   today — building one for a single cleanup job would be new
   platform surface for a problem that costs nothing to defer: a
   soft-deleted, unreferenced R2 object sitting in the bucket
   indefinitely has no user-facing effect (it's already hidden from
   the library UI and un-servable through the public route, which
   only serves keys with a live, non-deleted `media_assets` row) and a
   real R2 storage cost low enough at this project's realistic upload
   volume not to justify the added complexity yet. `replaceMedia()`
   has the identical accepted gap: the pre-replace R2 object is never
   deleted either. Both are tracked as the same future-phase item, not
   two separate ones.

## Preview

Images: inline, actual rendered preview at the real dimensions. PDFs: a "View" action opens the file via the same short-lived admin-signed link described above — no separate PDF-rendering component needed, the browser's own native PDF viewer handles it.

---

## What the Media Library does NOT do

- No image editing/cropping/filters (upload the file already sized correctly — a real, deliberate scope cut; if resizing tools are ever needed, that's Cloudflare Images, a genuinely separate product decision, not silently bolted onto this bucket).
- No video hosting (nothing in this platform's real content today uses video — building for it now would be speculative).
- No CDN cache-purge UI (Cloudflare's own cache behavior for R2-served assets is already adequate for this content's actual update frequency; a manual purge button is unnecessary complexity for a real problem that hasn't occurred).
