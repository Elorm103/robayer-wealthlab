# Robayer WealthLab — Version 1.0 Launch Readiness

**Status:** Finishing work only, per `docs/platform-review-v1.md`'s
Production Readiness Checklist. No new features. No redesign of
completed systems. This document is the concrete, executed follow-up
to that review — where the review said "verify X," this document
either verifies X for real (Task 3, Task 4) or produces the exact plan
to verify it on launch day (Task 5).

**Nothing in this pass was deployed, committed, or pushed.** Where
this document reports real infrastructure state, it was obtained via
read-only `wrangler` commands (`whoami`, `d1 list`, `r2 bucket list`,
`kv namespace list`, `deployments list`, `secret list`) — never
`deploy`, `d1 execute --remote`, or `secret put`.

---

## Task 1 — Legal & customer-facing documentation

**Reviewed:** Terms of Use, Privacy Policy, Disclaimer, Contact page.
No separate Refund Policy or Cookie Policy page exists — refunds are
covered within Terms of Use's "Purchases" section (renamed "Purchases
& refunds"); cookies are covered within Privacy Policy's own "Cookies"
section. Both were reviewed as part of their parent page.

**Changed:**

- `legal/terms-of-use/index.html` — "Purchases" → "Purchases &
  refunds." Replaced the "eBook purchases aren't yet available... when
  purchases open, they'll be processed through SkillsPad" language
  with an accurate description of the real, built checkout flow
  (Paystack by name, payment verification, email receipt + download
  instructions, per-product download limits shown before purchase) and
  an honest refund stance: final sale once downloaded, case-by-case
  exceptions for a defective file or billing error, no formal
  money-back guarantee invented. "Last updated" bumped to today.
- `legal/privacy-policy/index.html` — added a "Purchase information"
  bullet to "Information we collect" (email as confirmed by Paystack,
  product, amount, purchase reference) and a corresponding "How we use
  information" bullet. Added an explicit "we never see or store your
  card/mobile money details" statement. "Third-party services" now
  names Paystack and Resend as active (not hypothetical), keeps
  analytics correctly marked not-yet-active. "Last updated" bumped to
  today.

**Reviewed, no change needed:** `legal/disclaimer/index.html` (no
purchase/payment content at all — the "not financial advice"
disclaimer is unaffected by anything built this session). `contact/index.html`
(one consistent support address, `hello@robayerwealthlab.com`, already
matches every email template and the fulfilment page — no SkillsPad or
stale reference found).

**Deliberately not invented:** no specific refund window (e.g. "14
days"), no formal SLA, no compliance certification claim (e.g. PCI-DSS)
on Paystack's behalf. Everything added describes only what this
platform's own code actually does.

**Not in scope for this pass (internal docs, not customer-facing):**
`docs/commerce-architecture.md`'s own summary table still contains a
stale "Documented only" cell for the resolved SkillsPad finding — this
was flagged in `docs/platform-review-v1.md`'s technical debt register
(#9) and remains open; it's a developer-facing document inconsistency,
not a customer-facing legal accuracy issue, so it wasn't pulled into
this pass's explicit scope. Recommended for the next documentation
sweep.

---

## Task 2 — Security headers

**Implemented:** `backend/middleware/securityHeaders.ts` (new file,
`cors.ts` untouched) — applied in `worker/index.ts` to every response,
including the CORS preflight short-circuit.

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` | This Worker never serves HTML/CSS/JS to execute — every real response is a JSON envelope or a binary file. `'none'` is the *correct* value, not merely cautious. |
| `X-Frame-Options` | `DENY` | Belt-and-braces with the CSP `frame-ancestors` directive above, for browsers that only honor the older header. |
| `X-Content-Type-Options` | `nosniff` | Prevents content-type sniffing on `GET /api/download/:token`'s file response, whose type is set explicitly from `asset.fileType`. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Defense-in-depth — this API returns no outbound links itself, but a purchase reference should never leak into a third party's logs via a Referer header regardless. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` | Explicitly disclaims browser features this API has no reason to ever request. |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Workers are HTTPS-only by construction, so this only reinforces an existing guarantee — real value, no downside. `preload` deliberately omitted: that's a harder-to-reverse, domain-owner-level decision, not something this Worker should default into. |

**Deliberately out of scope for this task:** headers on the *static
site* itself. GitHub Pages cannot set custom response headers at all;
Cloudflare (which sits in front of the domain) could inject them via
Transform Rules, but that's a dashboard/DNS-layer configuration
outside this repository's code, not a Worker change. Recommended as a
manual follow-up in the Cloudflare dashboard — see "Remaining launch
blockers" below.

**Validation:** `tsc --noEmit` passes cleanly (see "Validation
performed").

---

## Task 3 — Database validation (executed, not simulated)

A completely fresh local D1 database was created and all four
migrations were run against it, in order, using `wrangler d1 migrations
apply robayer-wealthlab-db --local` — the same command a real
deployment would use.

```
Migrations to be applied:
0001_initial.sql
0002_purchase_sessions.sql
0003_payment_verification.sql
0004_digital_fulfilment.sql

🚣 32 commands executed successfully.  (0001)
🚣 5 commands executed successfully.   (0002)
🚣 3 commands executed successfully.   (0003)
🚣 10 commands executed successfully.  (0004)

0001_initial.sql              ✅
0002_purchase_sessions.sql    ✅
0003_payment_verification.sql ✅
0004_digital_fulfilment.sql   ✅
```

**Result: a brand-new installation succeeds from start to finish**,
with no manual intervention beyond the standard confirmation prompt.

### What was verified, and how

| Check | Method | Result |
|---|---|---|
| Migration order | `wrangler d1 migrations list` before applying | Correctly ordered 0001 → 0004, no gaps |
| Table count/names | `SELECT name FROM sqlite_master WHERE type='table'` | 14 tables, matching `schema.sql` exactly |
| Indexes | Same query, `type='index'` | Every index in `schema.sql` present, including the two `UNIQUE` indexes |
| `idx_deliveries_session_asset` is genuinely `UNIQUE` | `SELECT sql FROM sqlite_master WHERE name=...` | Confirmed `CREATE UNIQUE INDEX`, not a plain index |
| Foreign keys | `PRAGMA foreign_key_list(...)` on `deliveries`, `download_tokens`, `payment_transactions` | All three correctly reference their intended parent table/column; `purchase_sessions` correctly has none |
| `purchase_sessions.status` CHECK constraint | Attempted `INSERT ... status='bogus_status'` | **Rejected**: `CHECK constraint failed: status IN ('pending', 'verified', 'failed', 'expired', 'cancelled', 'refunded')` |
| `deliveries` idempotency (`UNIQUE(purchase_session_id, asset_id)`) | Inserted one row, then `INSERT OR IGNORE` the identical pair again, counted rows | Exactly 1 row after both attempts — the constraint that `fulfilmentService.ts`'s idempotent-fulfilment guarantee depends on was proven under real SQLite execution, not just read as correct |
| `payment_transactions` idempotency (`paystack_reference UNIQUE`) | Same pattern | Exactly 1 row after both attempts — the same proof for `commerceService.ts`'s webhook-idempotency guarantee |

All test rows were deleted afterward; the local database was left
empty and clean.

**This directly resolves `docs/platform-review-v1.md`'s technical debt
item #5** ("four migrations never run as a real sequential chain") —
they now have.

---

## Task 4 — Production infrastructure checklist

Obtained via live, read-only `wrangler` commands against the real
Cloudflare account (`lohrobert11@gmail.com`, account ID
`55cbec84f217e0c1bdc05d7aad7ea01f`) — this is **verified current
state**, not a repeat of what earlier docs claimed.

| Item | Status | Evidence / notes |
|---|---|---|
| Cloudflare account | ✅ Ready | Authenticated, real account, correct token scopes (`d1`, `workers`, `workers_kv`, `zone:read`, etc.) |
| D1 database | ⚠️ Needs configuration | `robayer-wealthlab-db` exists (created 2026-07-06), but **`num_tables: 0` on the remote instance** — no migration has ever been applied to it outside this session's local testing. Must run `wrangler d1 migrations apply robayer-wealthlab-db --remote` before launch. |
| R2 bucket | ⚠️ Needs configuration | `robayer-wealthlab-storage` exists (created 2026-07-06). No object-listing command was available to directly confirm contents, but no prior sprint ever uploaded a real file — presumed empty. At least one real asset must be uploaded (e.g. to `ebooks/starting-to-invest-with-gh100.pdf`, matching `content/products/starting-to-invest-with-gh100.json`'s `storageKey`) before a real purchase could ever successfully download anything. |
| KV namespace | ✅ Ready | `RATE_LIMIT_KV` exists and is bound. |
| Worker deployment | ⚠️ Needs configuration | **The Worker is already deployed** — 10 deployments between 2026-07-06 and 2026-07-07 — but this predates Sprint 2.3 (Commerce Foundation) entirely. The live Worker today only has the original newsletter/contact/consultation endpoints; none of the checkout/verification/fulfilment code built across this session has ever been deployed. This corrects `docs/platform-review-v1.md`'s slightly-too-broad "nothing has ever been deployed" — the *original* Worker has been; the commerce stack hasn't. |
| Resend | ✅ Mostly ready | `RESEND_API_KEY` **is genuinely set as a secret** on the deployed Worker (confirmed via `wrangler secret list` — name only, value never seen). Matches the project's earlier newsletter-wiring work. Should be re-confirmed as a valid, non-expired key before launch, but the mechanism is real, not a placeholder. |
| Paystack | ❌ Missing | No `PAYSTACK_SECRET_KEY` secret exists on the Worker at all (`wrangler secret list` shows only `RESEND_API_KEY`). No real Paystack account has been created for this project at any point in this project's history. This is the single largest infrastructure gap before launch. |
| GitHub Pages | ✅ Presumed ready | The static site has a real deployment history (commits pushed across every prior sprint) and a real production domain referenced throughout the codebase's own content (canonical URLs, structured data). Not independently re-verified live in this pass — no read-only tool was available to confirm current GitHub Pages build status from within this session. |
| DNS / domain configuration | ⚠️ Needs verification | `robayerwealthlab.com` is referenced everywhere as the live production domain and Cloudflare is understood to sit in front of it, but no read-only `wrangler` command in this session's available command set could directly list DNS zone records to confirm current state. Recommend the domain owner confirm directly in the Cloudflare dashboard before launch, specifically that the Worker route (once deployed) and the Pages/DNS root don't conflict. |
| Environment variables (non-secret) | ✅ Ready in code | `SITE_BASE_URL`, `PAYMENT_PROVIDER`, `PAYSTACK_BASE_URL`, `ALLOWED_ORIGIN` are all correctly set in `wrangler.jsonc`'s `vars` — but only take effect on the *next* deploy, since the currently-live Worker predates them. |
| Secrets (production) | ❌ Missing (Paystack) / ✅ Ready (Resend) | See Resend/Paystack rows above. |

**Summary:** Cloudflare's storage primitives (D1, R2, KV) all exist as
empty/ready containers. The Worker exists but is running old code. The
one real, external blocking dependency is **a Paystack account** —
nothing else on this list can meaningfully proceed to a real
transaction without it.

---

## Task 5 — End-to-end launch day test plan

**Do not perform a live payment as part of this plan.** Paystack
supports a test mode (test-mode secret key, test card numbers) —
every step below should be run against test-mode credentials first,
and only repeated against live-mode credentials once every test-mode
step has passed. This plan is written to be followed literally on
launch day, by whoever is doing the deployment, not just read once.

### Pre-flight (before any traffic)

| Step | Expected result | Success criteria |
|---|---|---|
| Run `wrangler d1 migrations apply robayer-wealthlab-db --remote` | All 4 migrations apply, matching this document's local dry-run exactly | `wrangler d1 migrations list --remote` shows all 4 as applied |
| Upload the real eBook PDF to R2 at `ebooks/starting-to-invest-with-gh100.pdf` | Object exists in the bucket | `wrangler r2 object get` on that key returns the file |
| Set `PAYSTACK_SECRET_KEY` (test mode) via `wrangler secret put` | Secret accepted | `wrangler secret list` shows the new name |
| Deploy the Worker (`wrangler deploy`) | New version live | `wrangler deployments list` shows a fresh deployment; `GET` any existing endpoint (e.g. a malformed request to `/api/newsletter`) returns the standard JSON envelope, not a 5xx |
| Confirm security headers are present | Every response carries the Task 2 header set | `curl -I` any endpoint, check for `Content-Security-Policy`, `X-Content-Type-Options`, etc. |

### The full purchase pipeline

| Stage | Action | Expected result | Success criteria | Rollback if this fails |
|---|---|---|---|---|
| **1. Visitor** | Load `/books/starting-to-invest-with-gh100/` | Page renders, price and Buy button visible | No console errors; price matches `content/products/starting-to-invest-with-gh100.json` | Not a backend issue — fix/redeploy the static site independently; doesn't block the pipeline below |
| **2. Purchase** | Click Buy | Redirected to a real Paystack (test-mode) checkout page | The checkout page shows the correct amount and currency | If the redirect fails or shows a Paystack error: check `PAYSTACK_SECRET_KEY` is set and valid; check Worker logs (`wrangler tail`) for the `checkout.provider_error` log line |
| **3. Paystack** | Complete payment with a Paystack test card | Paystack shows its own success page | Paystack's dashboard shows a successful test transaction | Not this platform's failure mode — a test-card decline is expected/normal Paystack behavior, retry with a different test card |
| **4. Webhook** | (Automatic) Paystack sends `charge.success` to `/api/webhooks/paystack` | Worker receives and returns `200` | `wrangler tail` shows `verification.started` then `verification.passed` for the correct reference | If no webhook arrives within ~1 minute: confirm the webhook URL is registered in the Paystack dashboard and points at the deployed Worker's real URL, not a placeholder |
| **5. Verification** | (Automatic, same webhook) | `purchase_sessions.status` becomes `'verified'` | Query D1 directly: `SELECT status FROM purchase_sessions WHERE purchase_reference = '...'` returns `verified` | If verification fails: check the specific `verification.failed` log reason (amount/currency/metadata mismatch, product invalid) — each is designed to be individually diagnosable from the log line alone |
| **6. Fulfilment** | (Automatic, same webhook, immediately after verification) | A `deliveries` row is created for the eBook asset | `SELECT * FROM deliveries WHERE purchase_session_id = ...` returns one row, `status = 'delivered'` | If fulfilment fails but verification succeeded (check `fulfilment.error` in logs): the purchase is still safely `verified` — re-running the exact same webhook delivery (Paystack's own retry, or a manual redelivery from the Paystack dashboard) safely re-attempts fulfilment with no risk of duplicate entitlement, per Task 3's proven idempotency guarantee |
| **7. Download** | Visit `/checkout/callback/?ref={reference}`, click Download | File downloads | The downloaded PDF opens and matches the real content | If the download 404s specifically at the R2 fetch step (`download.object_not_found_in_storage` in logs): confirm the R2 object was actually uploaded to the exact `storageKey` in the product JSON |
| **8. Email** | (Automatic, part of fulfilment) | Two emails arrive: purchase receipt, download instructions | Both emails arrive at the test purchase's email address (the one entered on Paystack's checkout page) within a few minutes | If no email arrives: check `email_log` for the two `purchase-receipt`/`secure-download` rows and their `status` — a `permanently_failed` row with a real error body (matching the exact pattern already validated for newsletter emails in Sprint 3) tells you why without needing Resend's own dashboard |
| **9. Customer success** | Re-visit `/checkout/callback/?ref={reference}` later, click Download again | A second, fresh download succeeds (assuming within the product's download policy — 5 downloads/30 days for the current eBook) | `deliveries.downloads_used` increments each time; a 6th attempt returns `DOWNLOAD_LIMIT_REACHED` with a friendly message, not an error page | This is the policy working as designed, not a failure — confirms the limit enforcement from Task 3's atomic-constraint testing holds under a real request too |

### After test-mode passes completely

Only then: repeat stages 2–9 once, against live-mode Paystack
credentials, with a real small purchase (the actual product price).
This is the one step in this entire plan that should **not** be
automated or rushed — it's the first real transaction this platform
will ever process, and it should be watched end-to-end by a human, not
just triggered and checked later.

---

## Launch checklist

- [ ] All pre-flight steps above completed against test-mode Paystack
- [ ] Full pipeline (stages 1–9) passes against test-mode Paystack
- [ ] Real Paystack account created, live-mode keys obtained
- [ ] `PAYSTACK_SECRET_KEY` (live mode) set via `wrangler secret put`
- [ ] Paystack webhook URL registered in the Paystack dashboard, pointing at the real deployed Worker
- [ ] One real, live-mode purchase completed and watched end-to-end by a human
- [ ] Legal pages (this pass) confirmed live on the deployed static site
- [ ] Security headers (this pass) confirmed present on the deployed Worker's real responses

## Deployment checklist

Exact order — see "Exact deployment order" in the Final Report below
for the authoritative sequence and why it's ordered this way.

## Production validation checklist

- [ ] `wrangler d1 migrations list --remote` shows all 4 migrations applied
- [ ] `wrangler r2 object get ebooks/starting-to-invest-with-gh100.pdf` confirms the real file exists in R2
- [ ] `wrangler secret list` shows both `RESEND_API_KEY` and `PAYSTACK_SECRET_KEY`
- [ ] A `curl -I` against any deployed endpoint shows the full Task 2 header set
- [ ] `wrangler tail` is open and watched during the first real test-mode transaction

## Rollback checklist

- [ ] If a bad Worker deploy is discovered: `wrangler rollback [previous-version-id]` (Cloudflare's own one-click Worker version rollback, listed via `wrangler deployments list`) — not a code revert, a live traffic rollback
- [ ] If a migration needs reversing: no automatic down-migration exists (SQLite/D1 convention in this project is forward-only recreate migrations) — a bad migration would need a new, corrective forward migration, not a rollback; this is a real gap worth being aware of (see "Known limitations")
- [ ] If Paystack webhooks need to be paused (e.g. a suspected issue): disable the webhook in the Paystack dashboard rather than un-deploying the Worker — this stops new events without breaking already-working checkout/status pages
- [ ] If a specific purchase needs manual intervention: `purchase_sessions`/`deliveries`/`payment_transactions` are all directly queryable via `wrangler d1 execute --remote` — no admin dashboard exists yet, so direct D1 queries are the only recourse; document the exact query in the incident notes, don't improvise against production data

## Post-launch monitoring checklist

- [ ] Watch `wrangler tail` for the first real hour of traffic
- [ ] Check `email_log` daily for the first week for any `permanently_failed` rows
- [ ] Check for any `verification.expired_but_paid_needs_review` log lines — these mean money moved but a purchase wasn't fulfilled, and need manual reconciliation every time they occur (see `docs/payment-verification.md`)
- [ ] Check for any `fulfilment.error` log lines — these are safely retryable (Task 3's idempotency proof) but should not be left unretried indefinitely
- [ ] Weekly: spot-check `payment_transactions` against Paystack's own dashboard transaction list to confirm they agree

---

## Validation performed

- **Typecheck:** `cd backend && npm run typecheck` (`tsc --noEmit`) —
  passes cleanly after the security-headers middleware addition, zero
  errors.
- **Documentation review:** every claim in this document was either
  directly executed (Task 3's migrations, Task 4's infrastructure
  checks) or cross-checked against the actual shipped code
  (`entitlementService.ts`, `fulfilmentService.ts`,
  `commerceService.ts`) rather than restated from earlier sprint
  summaries.
- **Migration validation:** see Task 3 in full above — executed, not
  simulated.
- **Cross-reference review:** this document's references to
  `docs/platform-review-v1.md`'s technical debt register items (#5,
  #9) were checked against that document's actual numbering, not
  assumed.

No code was deployed. No `wrangler secret put`, `d1 execute --remote`,
or `deploy` command was run at any point in this pass — every
Cloudflare command used was read-only (`list`/`whoami`).
