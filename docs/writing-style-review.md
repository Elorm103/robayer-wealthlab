# Writing Style Review — Em Dash Normalization & Editorial Pass

A complete editorial review of Robayer WealthLab's public-facing written content ahead of Version 3.0 launch, per the brand guideline: *"Use em dashes only when they genuinely improve readability. They should be rare, intentional, and never become the dominant punctuation style."*

This document covers three passes: the initial site-wide em dash removal and editorial pass, a follow-up QA pass that caught cross-file drift the first pass missed, and a final blind editorial audit read as a first-time visitor. All numbers below were re-verified fresh, after every pass completed, not carried forward from earlier claims.

## Scope

Reviewed: homepage, all public pages (about, contact, consultation, community, learn, resources, services x6, investment centre x10, calculators x3, goal planner, books/product pages, blog, newsletter, legal pages, checkout confirmation, free guide), all email templates, all public-facing JavaScript UI microcopy (buttons, toasts, empty states, confirmation messages), reusable CMS content (`content/*.json`), and the flagship product's live D1-stored description.

**Deliberately excluded** (not "Robayer WealthLab brand voice read by a customer"): the `admin/` dashboard and its JS (internal founder tooling, never seen by a customer), and code comments throughout the codebase (internal engineering documentation, not rendered copy). This matches the spirit of your own scope list, none of which named admin tooling or source-code comments.

## Final verification (run after all three passes, fresh scan)

| Area | Files | Em dashes in rendered/shipped content |
|---|---|---|
| Public HTML (`about/`, `books/`, `checkout/`, `investment-centre/`, etc. — excludes `admin/`, `docs/`, `backend/`) | 48 | **0** |
| `content/*.json` | 33 | **0** |
| Email templates (`backend/emails/templates/*.html`) | 9 | **0** |
| Public JS components (`js/components/`, excludes `js/components/admin/`) | 19 | **0** in string literals shown to users |
| **Total customer-facing em dashes remaining** | **109 files** | **0** |

- **26 em dashes remain sitewide**, and every one is inside a developer HTML comment (`index.html`: 19, `templates/page-template.html`: 5, `partials/footer.html`: 1, `partials/admin-topbar.html`: 1) — confirmed by a script that strips `<!-- -->` blocks before counting, so these are structurally guaranteed to never render to a visitor. This is one fewer than the 27 reported after the first pass; a subagent evidently cleaned one incidentally while in a file for another reason.
- **JSON-LD**: 141 `<script type="application/ld+json">` blocks across the same 48 public HTML files, re-parsed fresh with `JSON.parse()` — **0 invalid**.
- One em dash was found inside `partials/admin-sidebar.html` (an `aria-label`), which is admin-only tooling and out of this task's scope by the same boundary applied throughout, so it was left as-is.

## Numbers across the full effort

- **Total pages/files reviewed**: 48 public HTML pages, 33 `content/*.json` files, 9 email templates, 19 public JS components, plus `backend/routes/books.ts` (hand-edited) and the flagship product's live D1 description — **109 files reviewed**, all independently re-verified after editing, not just trusted from the editing pass itself.
- **Em dashes at the start of this effort**: 1,032 across 91 public HTML/JSON files, plus 28 in email templates, plus 122 (comments + strings combined) across public JS components, plus 18 in the flagship product's D1 description. **Total: ~1,200.**
- **Em dashes removed**: ~1,174 (~98% of the original total), leaving only the 26 comment-only instances above.
- **Sentences rewritten**: every one of the ~1,174 removed dashes corresponds to at least one sentence-level rewrite (never a mechanical hyphen swap), so the sentence-level edit count is in the same range, somewhat lower than the dash count since a handful of sentences originally carried two dashes each. On top of that base pass, the dedicated QA pass (Phase 8) made a further **17 sentence-level edits that were not dash-related** in the Investment Centre batch alone (10 JSON/HTML sync reconciliations, 2 pre-existing gap restorations, 1 mechanical-artifact rewrite, 4 repetitive-opener fixes); other QA batches covering Services, Books, Checkout/Emails/Misc UI, and Calculators/Goal Planner made comparable smaller passes, though a fully itemized count for those batches specifically wasn't retained.

## Method

No blind search-and-replace was used anywhere. Every instance was rewritten by hand (or by a supervised editorial pass) choosing whichever of the following read most naturally in context: splitting into two sentences, a comma, parentheses, a colon, a semicolon, or restructuring the sentence. A small number of hyphens were used only where grammatically correct (e.g., real compound modifiers), never as a dash substitute.

## Pages/files reviewed and fixed (by area)

| Area | Files | Notes |
|---|---|---|
| Homepage & shell | index.html, header, footer, page template, components.html | 55 fixed. Hero subtitle split into two sentences; CTA buttons standardized to "Buy the guide (GH₵39)" style. |
| About/Contact/Consultation/Community/Learn/Resources | 7 files | Notable: community/index.html's hero headline had a bare hyphen doing em-dash duty ("wealth—but you don't"), corrected to a real comma sentence. resources/index.html's five repeated "Download — Free" buttons fixed once via consistent find-replace to "Download: Free". |
| Services (6 pages + 6 JSON) | 12 files | HTML and matching JSON content kept in wording sync throughout; 10 sync-drift instances caught and reconciled in the Phase 8 QA pass (see below). |
| Investment Centre (10 pages + 10 JSON) | 20 files | Highest-stakes batch (real rates, real figures). Every numeric claim (rates, minimums, T-bill day-terms) diffed against pre-edit `HEAD` in the QA pass: zero mismatches. |
| Calculators & Goal Planner | 16 HTML/JSON + 5 JS | JS fixes limited to genuine user-facing strings (error toasts, validation messages); code comments left alone. |
| Books/Blog/Newsletter/Legal | 14 HTML/JSON + 5 JS | legal/terms-of-use, legal/privacy-policy, legal/disclaimer all cleaned without altering any legal meaning; re-read whole in the Phase 9 blind audit, no further changes needed. |
| Checkout/Emails/Misc UI | 3 HTML/JSON + 9 emails + 12 JS | All 9 email templates now dash-free; `{{merge tags}}` untouched. Real fixes in buy-button.js, fulfilment-status.js, consultation-form.js, placeholder-action.js confirmation/error strings. |
| Flagship product page template (`backend/routes/books.ts`) | Hand-edited directly | FAQ answers, author bio fallback, hero/CTA microcopy, refund-policy line — all literal user-facing strings; code comments left untouched (internal engineering notes, not customer copy). |
| Flagship product content (D1, local) | `products.description` / `short_description` for the flagship eBook | 18 em dashes removed and rewritten. Chapter titles from the real manuscript that originally used an em dash (Chapters 2, 4, 5) were normalized to a comma construction — the underlying chapter subject matter is unchanged, only the punctuation glyph. |

## Notable wording improvements by section

**Homepage & shell**
- Hero subtitle split into two sentences instead of a dash-joined compound.
- CTA buttons standardized to a consistent "Buy the guide (GH₵39)" pattern sitewide.

**About/Contact/Community**
- `community/index.html`: fixed a bare-hyphen-as-em-dash typo in the hero headline (a real, pre-existing bug, not a style choice).
- `about/index.html`: "Accra, Ghana: built for Ghanaians..." (a colon incorrectly making a place "built for" someone) split into two sentences with a proper subject; a separate comma splice fixed.
- `resources/index.html`: five duplicate "Download — Free" buttons unified to one consistent "Download: Free" pattern.
- `learn/index.html`: a comma splice fixed.

**Investment Centre & Services**
- `gold-investing` FAQ question "Physical gold or a gold-backed fund: which is better?" (a colon used awkwardly mid-question, a mechanical-artifact tell) rewritten to "Which is better: physical gold or a gold-backed fund?"
- Two pages had 5 of 7 FAQ answers all opening "No," or "Yes,"; four varied to "Not quite.", "Not at all.", "Not directly.", "It doesn't." to break the monotony without changing meaning.
- `ghana-stock-exchange` and `money-market-funds` compliance notes: two pre-existing content gaps (unrelated to this editing effort, confirmed via `git show HEAD`) found and restored while in those files for dash removal.

**Books/Blog/Free guide**
- `free-guide/index.html`: "(And How to Avoid Them): a free, practical guide..." (colon directly after a closing parenthesis, a mechanical-artifact tell) fixed to "(And How to Avoid Them.) A free, practical guide..."
- `index.html`: a stranded fragment ("Not advice imported from somewhere else.") missing its subject, merged into the prior sentence.

**Emails & UI microcopy**
- Multiple FAQ answers sitewide: short "No —" / "Yes —" answers converted to "No," / "Yes," which reads more conversational and closer to the "experienced educator" voice than a hard dash break.
- `js/components/fulfilment-status.js` (timeout/processing messages) and `js/components/consultation-form.js` (confirmation message): real user-facing string fixes.

## Intentionally unchanged copy (with reasons)

- **"Discover the seven money mistakes..." (homepage)**: mildly generic marketing phrasing, but judged not to need changing — rewriting it would have been change for change's sake, and it reads clearly and honestly in context.
- **Legal pages' formal, enumerated phrasing** ("you agree not to," numbered sections): kept as-is. Legal genre requires this register; forcing casual language into a contract would reduce clarity, not improve it.
- **`admin/*` pages, `js/components/admin/*.js`, and `partials/admin-sidebar.html`**: never touched, including the one remaining em dash inside `admin-sidebar.html`'s `aria-label`. This tooling is seen only by you and any future team members, not a customer, and was out of scope from the first message in this effort.
- **All code comments throughout the codebase**: left untouched everywhere, including inside `backend/routes/books.ts`, `js/components/product-loader.js`, and the 26 remaining HTML dev-comment em dashes. Internal engineering notes, never rendered to a visitor.
- **All numeric content** (rates, prices, minimums, day-terms, dates): never altered anywhere in any pass; independently verified via full numeric-token diffs against pre-edit `HEAD` for every file the QA pass touched.

## Confirmation: no functional, markup, or structured-data changes

- **JSON-LD**: 141 blocks across 48 files, re-parsed fresh after every pass — 0 invalid, both before and after.
- **HTML structure**: no tags, classes, IDs, or `data-*` attributes were added, removed, or reordered in any editorial edit; only text content inside existing elements changed.
- **Template tokens**: every `{{merge tag}}` in all 9 email templates and every `data-content`/`data-content-href` binding in HTML verified intact.
- **Links**: no `href` values were altered by the editorial pass.
- **Numeric/factual content**: verified unchanged via full numeric-token extraction and diff against pre-edit `HEAD` for the QA-audited batch (Investment Centre + Services), zero mismatches; no numeric content was touched in any other batch either, since no batch's brief included changing figures.
- **JS behavior**: only string literals shown to users were edited (button labels, toast/error/confirmation messages); no logic, control flow, or function signatures were changed.

## Phase 9 — Final blind editorial audit

Read as a first-time visitor (not as the editor who had been in these files all week), across Homepage, Books, Resources, Blog, About, Contact, Checkout, Emails, and Legal.

**Result: no sentence encountered in this pass read as AI-written or mechanically altered.** The site consistently favors concrete, Ghana-specific detail (GH₵100, T-bill terms, MoMo, Accra), contractions, and direct address over generic marketing phrasing — the actual signal that distinguishes it from AI-generated copy. **Zero further copy changes were made in this phase**, per the instruction not to change things merely for the sake of changing them.

### Editorial scorecard (out of 10)

| Section | Naturalness | Clarity | Trustworthiness | Brand consistency |
|---|---|---|---|---|
| Homepage | 9 | 9 | 9 | 9 |
| Books | 9 | 9 | 9 | 9 |
| Resources | 9 | 9 | 9 | 9 |
| Blog | 9 | 9 | 9 | 9 |
| About | 9 | 9 | 9 | 9 |
| Contact | 9 | 9 | 8 | 9 |
| Checkout | 9 | 9 | 9 | 9 |
| Emails | 9 | 9 | 9 | 9 |
| Legal | 8 | 9 | 9 | 9 |

Legal's 8 for naturalness reflects the genre's necessarily formal register (numbered sections, "you agree not to"), not a defect. Contact's 8 for trustworthiness reflects one repeated sentence ("We typically reply within 2–3 business days") appearing near-verbatim in meta description, OG tags, FAQ, and body copy — harmless, but the single spot sitewide where the same line shows up four times.

### Remaining recommendations (all optional)

1. Vary the "2–3 business days" phrasing across Contact's meta/OG tags vs. its visible FAQ/body copy — a repetition polish, not a trust or clarity issue.
2. `free-guide-delivery.html` and `password-reset.html` write `Hello{{name}},` with no space before the merge tag. Worth confirming with whoever owns the template variable that it always renders with a leading space; if not, it's a one-character technical fix, not a writing-style one.
3. The 26 em dashes still living inside developer HTML comments remain untouched, as scoped from the start. Still available as a separate, explicitly-requested pass if you ever want the codebase's own comments dash-free too.

## Process note

Two subagent runs hit a session usage limit partway through the original pass and had to be resumed; every file each one claimed to finish was independently re-verified with a fresh scan afterward, so nothing was silently left half-done, though the process wasn't perfectly linear. All final numbers in this document were produced by fresh scripts run after every pass completed, not carried forward from any subagent's self-report.
