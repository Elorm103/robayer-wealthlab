# Products Module — Implementation (Version 2.0 Phase 2)

**Status: implemented, adversarially reviewed, pending production deploy.** This doc records what was actually built, which diverges in one important way from the original design docs (`v2-product-management-spec.md`, `product-platform-architecture.md`): those specced a **D1-mirrors-JSON** model where `content/products/*.json` stayed authoritative. During implementation that was replaced with **D1 as the sole source of truth** — a real `products` table (see `backend/database/migrations/0008_products_module.sql`), with `content/products/*.json` migrated into it once (`0009_migrate_json_products.sql`) and then retired as a live data source. The JSON-mirror design assumed a GitHub-API publish pipeline to keep static files in sync with admin edits; going straight to D1 removes that entire synchronization surface (and its failure modes) in favor of the same pattern already proven for the Media Library. The two older spec docs are left in place for their still-relevant workflow/UX thinking but no longer describe the real data flow — treat this doc as authoritative for architecture.

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
