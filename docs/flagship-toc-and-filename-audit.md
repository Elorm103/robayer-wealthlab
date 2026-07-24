# Flagship eBook: TOC & Download Filename — Audit and Fix

Publishing-quality audit and correction for "Small Cedis, Big Wealth" (product slug `starting-to-invest-with-gh100`, unchanged). Two issues: the PDF's Table of Contents was not production quality, and downloaded files still carried the pre-rename filename. This document is the deliverable both fixes were scoped against.

**Scope discipline:** this was explicitly not a redesign. Only the TOC page and PDF-level metadata were touched — the other 36 pages of the book, the product ID, the download token system, and download security are all untouched and verified byte-identical/behaviourally unchanged (see Verification below).

---

## 1. Root cause: the Table of Contents

The current production PDF (37 pages, downloaded from `ebooks/starting-to-invest-with-gh100.pdf` for audit) had a TOC on page 6 with the following confirmed defects, found by direct inspection of the PDF's text, metadata, and rendered pixels (not guessed):

| Issue | Finding |
|---|---|
| No page numbers | The TOC's 25 entries had zero page-number column at all. |
| No leader dots | Entries were separated only by a plain horizontal divider line, no dot leaders connecting title to page. |
| No hierarchy | Front matter, the introduction, all 9 chapters, 6 supplementary items, and 4 back-matter items were rendered as one flat, undifferentiated list — same font weight/size/indent throughout. |
| Duplicate entry | The TOC listed itself ("Table of Contents" as its own 6th entry) — a self-reference no real published TOC includes. |
| Phantom entry | "A Personal Note" was listed but does not correspond to any page in the actual document (confirmed: no page's heading matches this text anywhere in the 37-page PDF). |
| Missing entry | "Other Books by Robayer WealthLab" is a real section (in fact it exists twice — see below) but was never listed in the TOC at all. |
| No PDF bookmarks | `pdf-lib` inspection of the catalog found no `/Outlines` entry — the PDF had zero bookmark/outline structure, so PDF-reader sidebar navigation was empty. |
| No clickable links | Direct inspection of every page's `/Annots` found **zero** link annotations anywhere in the entire 37-page document — the TOC's entries were plain styled text, not links. |
| Wrong PDF title metadata | The `/Info` dictionary's `Title` field was `"book.html"` — a generic default left over from whatever HTML source produced the PDF (via Chrome/Puppeteer print-to-PDF), never overridden with the real book title. |

**A related, independent content bug found during the audit (not a TOC defect, left unfixed as out of scope):** the heading "Other Books by Robayer WealthLab" appears on **two** physical pages — page 7 (immediately after the TOC, nearly blank) and page 37 (the legitimate closing section, "COMING SOON"). Page 7 also reuses the same internal footer page-counter value ("Page 5") that the TOC page's own slot would occupy, consistent with it being an accidental duplicate insertion rather than intentional content. The new TOC points at the legitimate instance (page 37) and does not reference page 7. This is flagged here for a future content-only fix; it was not touched, since editing book body content was outside this task's scope.

**Why this happened, structurally:** the original HTML/CSS source and generation script that produced the PDF no longer exist anywhere in this repository (confirmed: no `puppeteer`, `book.html`, or PDF-generation references anywhere outside `node_modules`). The book was last regenerated and pushed directly to R2 via the CLI in an earlier session (see [`docs/media-library-asset-replacement-procedure.md`](media-library-asset-replacement-procedure.md), written after that incident). Whatever produced the TOC did so as flat text with no layout system for numbering, leaders, hierarchy, or PDF-level navigation features — those were simply never built.

## 2. Root cause: the legacy download filename

Every purchaser's download was served with `Content-Disposition: attachment; filename="starting-to-invest-with-gh100.pdf"`, regardless of the fact that the product's title in D1 had already been changed to "Small Cedis, Big Wealth".

Traced the full pipeline:

1. [`backend/routes/downloads.ts`](../backend/routes/downloads.ts) built the header from `result.asset.filename`.
2. That `filename` field ([`backend/services/productCatalogService.ts`](../backend/services/productCatalogService.ts)) is populated from `media_assets.original_filename` — a D1 column captured **once, at upload time**, via a join through `product_files`.
3. `media_assets.original_filename` has no mechanism to stay in sync with `products.title`. When the product was renamed, nothing re-derived the filename — it just kept returning the literal string captured back when the file was first uploaded.
4. Confirmed directly in D1: `media_assets.original_filename = 'starting-to-invest-with-gh100.pdf'` while `products.title = 'Small Cedis, Big Wealth'` — the two had drifted apart exactly as suspected.

Critically, [`productCatalogService.ts`](../backend/services/productCatalogService.ts)'s own doc comment already stated that `filename`/`storageKey` are **not** part of the security/entitlement identity — only `assetId` is what `deliveries`/`download_tokens` rows reference. This confirmed changing filename derivation was safe and would never touch entitlement or token logic.

## 3. Files modified

**Filename fix:**
- [`backend/utils/downloadFilename.ts`](../backend/utils/downloadFilename.ts) — new. Slugifies a product title into a filename (`"Small Cedis, Big Wealth"` → `Small-Cedis-Big-Wealth.pdf`), built fresh from the live title every request.
- [`backend/services/entitlementService.ts`](../backend/services/entitlementService.ts) — `redeemDownloadToken()`'s success result now also returns `productTitle`, sourced from the `fetchCatalogProduct()` call that already ran on every redemption (no new query added).
- [`backend/routes/downloads.ts`](../backend/routes/downloads.ts) — `Content-Disposition` now built via `buildDownloadFilename(result.productTitle, result.asset.fileType)` instead of `result.asset.filename`.

**TOC fix (all new files, `backend/scripts/`):**
- `book-toc-sections.mjs` — the canonical list of TOC sections and groups, with regex heading-matchers (no hardcoded page numbers) and `resolvePageMap()`, which finds every section's true page by scanning the actual PDF.
- `render-toc-page.mjs` — renders the redesigned TOC as a standalone page via headless Chrome, returning both the PDF bytes and every entry's exact bounding box.
- `pdf-links.mjs` — adds real `/Subtype /Link` clickable annotations via `pdf-lib`'s low-level object API (pdf-lib has no high-level bookmark/link helper).
- `pdf-outline.mjs` — builds a real PDF outline/bookmark tree, same low-level approach.
- `rebuild-book-toc.mjs` — orchestrates all of the above: splices the new TOC into the existing PDF in place of the old page 6, adds links, adds the outline, fixes `/Info` Title/Author. Every other page is copied through untouched.
- `backend/package.json` — added `pdf-lib`, `pdf-parse`, `puppeteer-core` as devDependencies (build-time tooling only; nothing added to the deployed Worker bundle).

## 4. Before vs after

**Download filename:**
| | Before | After |
|---|---|---|
| Saved filename | `starting-to-invest-with-gh100.pdf` | `Small-Cedis-Big-Wealth.pdf` |
| Source | `media_assets.original_filename` (static, upload-time snapshot) | `products.title`, read fresh on every download |

**Table of Contents (page 6):**
| | Before | After |
|---|---|---|
| Page numbers | None | Every entry, computed by scanning the real PDF |
| Leader dots | None | CSS dot leaders, title to page number |
| Hierarchy | Flat 25-item list | Grouped: Front Matter / Introduction / Chapters (numbered) / Additional Resources / Back Matter |
| Duplicate/phantom entries | "Table of Contents" (self) and "A Personal Note" (doesn't exist) both listed | Both removed |
| Missing entry | "Other Books by Robayer WealthLab" absent | Added, pointing at the correct (page 37) instance |
| PDF bookmarks | None (`/Outlines` absent) | 13 top-level bookmarks, 3 with nested children, mirroring the visual grouping |
| Clickable links | None (0 annotations in the whole document) | 24 real link annotations on the TOC, each verified to resolve to the correct page |
| `/Info` Title | `"book.html"` | `"Small Cedis, Big Wealth — A Practical Ghanaian Wealth Guide"` |

## 5. Verification

**TOC:**
- Page count preserved: 37 → 37.
- All 36 non-TOC pages confirmed **byte-identical** (SHA-256 of each page's content stream, before vs after) — zero content regression anywhere outside the TOC page itself.
- All 24 link annotations individually resolved and checked against the expected page map — every one points to the correct physical page.
- Outline tree confirmed present via `pdf-lib` catalog inspection: 13 top-level items (Front Matter, Introduction, Chapters 1–9, Additional Resources, Back Matter), 3 with nested children, matching the visual TOC's own grouping.
- `/Info` `Title`/`Author` confirmed corrected via direct metadata read.
- New TOC page visually inspected via rendered screenshot (both standalone and spliced into the final 37-page document) — matches the book's existing navy (`#16233d`) / gold (`#d4a017`) identity, sampled directly from the original PDF's own pixels, and reuses the site's actual production font stack (Newsreader / Work Sans / IBM Plex Mono, confirmed from `index.html`'s Google Fonts link) rather than a guess.
- Page numbers are **not hardcoded**: `resolvePageMap()` derives every number by scanning the actual PDF's page text at build time. Re-running `rebuild-book-toc.mjs` against a future edition recomputes everything automatically, or fails loudly if a section's heading can't be found.

**Download filename:**
- Verified against a real request/response cycle on a local `wrangler dev` instance backed by real local D1 data (a synthetic-but-structurally-real verified purchase, since no real local purchase existed to reuse) and a real object placed in local R2 at the asset's actual storage key.
- `POST /api/purchases/:reference/downloads` → `GET /api/download/:token` returned `Content-Disposition: attachment; filename="Small-Cedis-Big-Wealth.pdf"` — confirmed correct, end to end, through the real entitlement/token code path.
- **No regression to existing purchases confirmed:** a second `GET` on the same (now-used) token correctly returned `409`; `deliveries.downloads_used` incremented to 1; `download_tokens.used_at` was set — the token/entitlement system's behavior is completely unchanged, only the filename it hands back changed.
- Product ID, slug, download tokens, and download security were not touched anywhere in this fix, consistent with the task's explicit constraints.

**Not yet done (deliberately, pending explicit confirmation):**
- The corrected PDF has **not** been uploaded to production R2. It exists locally, fully verified, ready to replace `ebooks/starting-to-invest-with-gh100.pdf` via [`docs/media-library-asset-replacement-procedure.md`](media-library-asset-replacement-procedure.md)'s established procedure.
- The filename-fix code has **not** been deployed. It's committed to the branch but `wrangler deploy` has not been run.

Both are real, production-facing, hard-to-reverse-in-spirit actions (one replaces the live paid product's actual deliverable file; the other changes what every future customer downloads) — held for explicit go-ahead before executing, per this session's own operating rules.
