# Products Module — Implementation (Version 2.0 Phase 2)

**Status: implemented, adversarially reviewed twice, deployed to production, accepted.** This doc records what was actually built, which diverges in one important way from the original design docs (`v2-product-management-spec.md`, `product-platform-architecture.md`): those specced a **D1-mirrors-JSON** model where `content/products/*.json` stayed authoritative. During implementation that was replaced with **D1 as the sole source of truth** — a real `products` table (see `backend/database/migrations/0008_products_module.sql`), with `content/products/*.json` migrated into it once (`0009_migrate_json_products.sql`) and then retired as a live data source. The JSON-mirror design assumed a GitHub-API publish pipeline to keep static files in sync with admin edits; going straight to D1 removes that entire synchronization surface (and its failure modes) in favor of the same pattern already proven for the Media Library. The two older spec docs are left in place for their still-relevant workflow/UX thinking but no longer describe the real data flow — treat this doc as authoritative for architecture.

---

## Data model

`products` table (migration 0008) holds every field the public site and admin need: identity (`slug`, `title`, `topic`, `product_type`), commerce (`price_pesewas`, `sku`, `status`), content (`description` — sanitized HTML, `short_description`, `subtitle`), SEO (`seo_title`, `seo_description`, `seo_canonical_url`), and media references (`cover_media_id`, `og_media_id`) pointing at the Media Library's `media` table rather than duplicating file metadata. `backend/services/productService.ts` is the single read/write boundary — both the admin routes (`routes/admin/products.ts`) and the public routes (`routes/products.ts`, `routes/books.ts`) go through it, so there is exactly one place validation, sanitization, and status filtering live.

## Public site: the `/books/*` Workers Route

Existing product pages lived at static paths (`books/index.html`, `books/{slug}/index.html`) served by GitHub Pages. A D1-backed catalog needs pages that render current data — including for products created entirely through the admin, which have no static file at all. The fix extends the existing `/api/*` Workers Route pattern (see `docs/v2-same-origin-migration-audit.md`) with a second Route, `/books/*`, so the Worker now owns and fully renders that path space (`backend/routes/books.ts`: `handleBooksIndex`, `handleBookDetail`, `handleBookRedirect`).

**Design rejected: origin-proxy fallback.** An earlier option considered was the Worker rendering only *new* (D1-only) products and proxying everything else through to the original GitHub Pages origin. This was rejected after research surfaced a real risk: a Workers `fetch()` subrequest to a URL matching one of the zone's *own* Routes gets re-routed back through the same Worker rather than reaching the true origin (self-interception). This repo has no version-controlled DNS/CNAME record to confirm the origin topology precisely enough to rule that out safely (`docs/disaster-recovery.md` states DNS is "NOT in git"). Rather than ship a design whose failure mode is untestable, `/books/*` was made fully self-contained — the Worker renders every product page itself, old and new, from D1, and never proxies out. The static `books/` files remain in the repo untouched, unreachable in production once the Route is live, kept only as a historical reference for the exact SEO copy they need to match.

**SEO parity.** Because this replaces hand-authored HTML with generated HTML, every meta tag and JSON-LD block was diffed against the original static files during this phase's adversarial pass, not just spot-checked:
- Title, canonical, Open Graph, and meta description now match the originals exactly (a real bug was found and fixed here — see Defects below).
- JSON-LD block count/order/type now matches: `Organization + FAQPage` on the index page, `Organization + BreadcrumbList + Book + FAQPage` on detail pages — both were missing `BreadcrumbList`/`FAQPage` in the first implementation pass.

## Content-Security-Policy: content-type branching

`backend/middleware/securityHeaders.ts` previously sent a single blanket `default-src 'none'` on every response, correct when every response really was JSON/binary. The first `/books/*` HTML responses broke under that policy (CSS/JS/fonts are blocked by `'none'` too, not just XHR). Fixed by branching on the response's own `Content-Type`: HTML responses get a real, scoped policy (same-origin scripts/styles/images plus Google Fonts); every other response keeps the original strict `'none'`.

## Server-side rich-text sanitization

The admin's rich-text `description` field is rendered as raw HTML on public product pages, reaching every visitor. The admin editor already sanitizes client-side, but per this project's standing "never trust frontend input" posture, `backend/utils/richTextSanitizer.ts` re-sanitizes server-side at write time (`productService.createProduct`/`updateProduct`), using `HTMLRewriter` (the native Workers HTML-transform API — no DOM exists in the Workers runtime, and no sanitizer dependency was added, matching this project's zero-dependency stance). Allowlists tags and, for `<a>`/`<img>`, allowlists `href`/`src` schemes (http(s) or relative only — blocks `javascript:`/`data:`).

## Cache-Control on `/books/*`

HTML responses from `/books/*` now set `Cache-Control: no-store` explicitly (`htmlResponse()` helper in `routes/books.ts`), rather than relying on Cloudflare's/the browser's implicit default. These pages are now admin-editable (price, availability, copy), so an edit needs to appear immediately — the same instinct this codebase already applies to checkout/purchase responses. This is the deliberate opposite of the Media Library's own `routes/media.ts`, which caches file responses `immutable` for a year — correct there because a UUID-keyed file's bytes genuinely never change.

## Adversarial review — defects found and fixed this phase

1. **HTMLRewriter "attributes modified during iteration" crash.** A live multi-attribute XSS payload (`<script>`, `onerror`, `javascript:` href, inline `onclick`, `<iframe>`, nested `data:` script) sent to `POST /api/admin/products` 500'd. Root cause: `element.attributes` is a live iterator; `removeAttribute()` inside a `for...of` over it throws. Fixed by snapshotting attribute names into a plain array before removing any of them. Re-verified with the same payload: all five vectors neutralized in both the stored value and the rendered public page.
2. **Missing `Cache-Control` on `/books/*` HTML.** No caching header at all was being sent (see above) — fixed with the `htmlResponse()` helper, applied to all three response paths (index, detail, 404).
3. **Missing SEO metadata (`BreadcrumbList`, `FAQPage`).** The first-pass renderer emitted only `Organization` + a conditional `Book` block, dropping two block types the original static pages had. Fixed by adding both, matching the originals' exact question/answer copy.
4. **Stale/incomplete page-level description on `/books/`.** The index page's hardcoded `<meta name="description">`/`og:description` had drifted from the original static file's copy (dropped "starting with Starting to Invest with GH₵100" and the "from GH₵39" price anchor) — a real, if narrow, content-parity regression, not just a missing field. Fixed by restoring the exact original copy.
5. **Twitter card reused the OG description everywhere.** The original static pages carried distinct, shorter Twitter-specific copy on both `/books/` and the detail page; the generated shell defaulted `twitter:description` to the same value as `og:description`. Added an optional `twitterDescription` field to `renderShell()`'s options, populated with the original copy on the (page-level, hardcoded) index page. The detail page intentionally still defaults to the SEO description — it is now data-driven per-product and there is no admin-editable Twitter-specific field in the schema; inventing one for a single cosmetic string was judged out of scope for this pass.

All five were confirmed via live requests against a local `wrangler dev` instance backed by real local D1 data, not from code review alone.

## Verification performed this phase

- Both real public product URLs (`starting-to-invest-with-gh100` — active, `momo-savings-playbook` — coming-soon) return 200, with SEO metadata now diffed byte-for-byte against the original static files.
- Bare `/books` (no trailing slash) was confirmed to fall through to the pre-existing static-file behavior unchanged — the `/books/*` Route pattern only matches paths with the trailing slash, so this path never reaches the Worker in production; a direct-to-Worker curl during testing showed a 404 that does not occur through the real Route-matching layer (confirmed via a local proxy mirroring Cloudflare's own Route semantics).
- Every CSS/JS/icon asset referenced by the rendered detail page resolves 200.
- Homepage featured/coming-soon sections (`product-loader.js`, client-side) render live D1 data correctly in a real browser — no console errors, correct price, correct badges.
- Media Library, admin product list, admin session/CSRF, and checkout session creation (resolves the D1 product correctly, fails only at the external Paystack call — a known local-sandbox network limitation, not a catalog regression) all still function post-change.
- Mobile viewport and dark mode both verified visually on the product detail page — no layout regressions.

## Final acceptance audit — second adversarial pass

A second, independent adversarial pass (fresh re-read of every file, not a re-run of the first pass's checklist) was run before accepting this phase as done, per the standing project discipline of not trusting a single review. It found one real, production-live defect and one class of stale documentation, both fixed and redeployed.

### Defect found and fixed: status changes silently dropped on update

`productService.updateProduct()`'s SQL `UPDATE` statement never included `status` in its `SET` clause — a straightforward transcription gap between it and `createProduct()`'s column list (which does set `status`). Effect: the admin edit page's own "Set status" dropdown (`admin/products/edit/index.html`'s `data-pe-status` select, directly above the "Save changes" button — the only status control on that page) had **no effect at all**. An admin selecting "Active" and clicking Save would see a success response, but the database status never changed; the only path that actually worked was the list page's bulk-action bar (`publish`/`unpublish`/`archive`/`unarchive`), which calls `transitionProductStatus()` directly and was unaffected.

Fixed in `backend/services/productService.ts`: `status` added to the `UPDATE` SET clause, preserving the existing status when the caller doesn't send one (matches `ProductInput.status` being optional), re-validating the same "active needs a price" rule `transitionProductStatus` enforces. Verified against both local `wrangler dev` and, after redeploying, against a throwaway test product created and destroyed in production D1 (never touching either of the two real, live products) — confirmed via a fresh `GET` (not just the `PATCH` response) that the status change genuinely persisted.

### Stale documentation found and fixed

Six source comments (`backend/database/migrations/0008_products_module.sql`, `backend/database/schema.sql`, `backend/routes/admin/products.ts`, `backend/services/productCatalogService.ts`, `backend/services/productService.ts`, `backend/worker/index.ts`) pointed at `docs/v2-products-module-spec.md` — a filename that was never actually written. Corrected to point at this document.

### Known limitation (not fixed, judged out of scope)

The list page's bulk "Unarchive"/"Restore" buttons are gated behind the `showDeleted` toggle (soft-deleted view), not behind the "Archived" status filter — an admin filtering the list to `status=archived` (not soft-deleted, just archived) has no *bulk* unarchive action, only the now-fixed per-product edit page. This is a UX completeness gap, not a correctness or security defect — logged here rather than fixed in this pass since it's cosmetic and the underlying capability (unarchiving one product at a time via its edit page) now genuinely works.

## Deployment report

**Production URLs verified 200 post-deploy:** `https://robayerwealthlab.com/` (homepage, live featured/coming-soon data), `https://robayerwealthlab.com/books/` (index), `https://robayerwealthlab.com/books/starting-to-invest-with-gh100/` (active product), `https://robayerwealthlab.com/books/momo-savings-playbook/` (coming-soon product), `https://robayerwealthlab.com/api/health`, `https://robayerwealthlab.com/admin/`.

**D1 migration version:** `0009_migrate_json_products.sql` (latest applied; `wrangler d1 migrations list --remote` reports "No migrations to apply"). Full chain: 0001 → 0009, all applied.

**Production row counts (post-deploy, post-cleanup):** `products`: 2 (0 soft-deleted) · `product_files`: 1 · `product_gallery`: 0 · `product_relations`: 0 · `media_assets`: 9 (7 soft-deleted, 2 active — one is the migrated ebook PDF, one is unrelated pre-existing Media Library content not touched by this phase) · `admin_users`: 1 · `purchase_sessions`: 11 (pre-existing historical rows from earlier commerce-testing phases, untouched by this audit) · `deliveries`: 4 · `download_tokens`: 5.

**Known limitations:**
1. Bulk "Unarchive" only surfaces under the soft-delete list filter, not the "Archived" status filter (see above) — per-product unarchive via the edit page works.
2. The `/books/*` detail page's `twitter:description` always mirrors the SEO description — no per-product Twitter-specific copy field exists in the schema (the original static pages had one, hand-authored); judged not worth a schema addition for one cosmetic string.
3. Checkout against a live product could not be fully exercised end-to-end through Paystack from this environment (network egress to `api.paystack.co` is unavailable in the local sandbox) — verified up to "D1 product resolved correctly, Paystack session request sent" in both local and production; the full payment→webhook→fulfilment path was previously verified in earlier commerce-foundation phases and is architecturally unchanged by this one.
4. The pre-existing, never-populated `products`/`customers`/`orders`/`downloads` table cluster from Version 1.2 Sprint 1 planning was dropped by migration 0008 (verified 0 rows, no live code references, before dropping) — irreversible without a backup restore if that judgment was ever wrong; documented in the migration's own header comment.

**Rollback procedure:**
1. **Worker code:** `cd backend && npx wrangler rollback` (reverts to the previous deployed Version ID) or `npx wrangler deploy` against the prior git commit (`60500df` before this audit's fix, `111730d` before Phase 2 entirely).
2. **Database:** D1 migrations are forward-only by convention in this project (no `.down.sql` files exist for any migration, matching migrations 0001–0007's own precedent) — a schema rollback of 0008/0009 would require a hand-written reverse migration (recreate the dropped `products`/`customers`/`orders`/`downloads` tables, drop the new `products`/`product_files`/`product_gallery`/`product_relations` tables) and is **not** a routine operation; do not attempt it without first confirming no post-migration writes (new products, purchases against them) would be lost, since none of this data exists in the old schema's shape.
3. **DNS/Routes:** the `/books/*` Workers Route can be removed from `backend/wrangler.jsonc`'s `routes` array and redeployed to fall back to GitHub Pages serving the (untouched, still-present) static `books/` files — a safe, fast, code-only rollback for the public-facing surface specifically, independent of the D1/Worker rollback above.

**Recommended next phase:** Version 2.0 Phase 3 per the existing roadmap (`docs/v2-development-roadmap.md`) — the CMS/rich-content phase, now that Products has proven the D1-as-source-of-truth + admin-CRUD + server-rendered-public-page pattern this phase established. Before starting it, consider a small standalone fix for the bulk-unarchive gap noted above, since it's now the only known rough edge in an otherwise-accepted module.
