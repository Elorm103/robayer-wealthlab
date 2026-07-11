# Robayer WealthLab — Operations Runbook

**Status:** every claim in the audit below was checked directly against
the real code (`backend/services/`, `backend/routes/`, `backend/utils/logger.ts`,
`backend/database/schema.sql`) and the real deployed Worker's
`wrangler.jsonc` (`observability.enabled: true`), not assumed. No code
was changed to produce this document.

---

## 1. Operational visibility audit

For each item: what exists today, and exactly where to find it.

| # | Item | Available today? | Where |
|---|---|---|---|
| 1 | Homepage traffic | ⚠️ Partial | The domain is Cloudflare-proxied (confirmed via `Cf-Cache-Status`/`CF-RAY` response headers on every page), so basic edge-level request volume likely exists in the Cloudflare dashboard's zone analytics — **not independently verifiable from this session's tools** (no `wrangler zone` read command exists). No app-level page-view tracking exists at all — no analytics script is loaded (confirmed: Privacy Policy correctly states analytics is "not yet active"). |
| 2 | Product page visits | ❌ None | Same as above — no app-level tracking on `/books/starting-to-invest-with-gh100/` or any page. |
| 3 | Newsletter sign-ups | ✅ Full | `newsletter_subscribers` D1 table, one row per subscriber. Cross-check: `email_log` has one `newsletter-welcome` row per successful signup. |
| 4 | Buy button clicks | ❌ None | The click itself fires no telemetry — visibility only begins once the click's `fetch()` actually reaches the Worker (item 5). A visitor who clicks Buy but whose request fails before reaching the Worker (offline, ad-blocker, etc.) leaves no trace anywhere. |
| 5 | Checkout session creation | ✅ Full | Every click that reaches the Worker creates a `purchase_sessions` row (`status: 'pending'`), regardless of whether payment ever completes. Also logged: `checkout.session_created` (structured JSON, visible in `wrangler tail` and Cloudflare's Workers Logs). |
| 6 | Successful payments | ✅ Full | `purchase_sessions.status = 'verified'` + a `payment_transactions` row (`event_type: 'charge.success'`, full real Paystack `gateway_response` JSON stored). Logged: `verification.started` → `verification.passed`. |
| 7 | Failed payments | ✅ Full, two distinct paths | **(a)** Checkout never reached Paystack (network/API error at session creation) → `purchase_sessions.status = 'failed'`, no `payment_transactions` row, logged `checkout.provider_error`. **(b)** Paystack processed the charge and it failed (declined card, etc.) → `purchase_sessions.status = 'failed'` *and* a real `payment_transactions` row, logged `verification.failed` with `reason: 'provider_reported_charge_failed'`. These are genuinely different failure modes and the database correctly distinguishes them. |
| 8 | Webhook failures | ⚠️ Logged, not aggregated | Invalid signatures, malformed payloads, and expired-session webhooks are all logged (`webhook.malformed_payload`, `verification.expired`, `verification.expired_but_paid_needs_review` at `error` severity for the one case that needs manual reconciliation). Visible live via `wrangler tail` or Cloudflare's Workers Logs dashboard — **not persisted anywhere queryable after the fact** unless Cloudflare Logpush is configured (it isn't). |
| 9 | Fulfilment failures | ⚠️ Logged, not aggregated | `fulfilment.no_published_assets`, `fulfilment.error`, `fulfilment.no_customer_email` all logged at `error` severity — this is exactly how this session's own forensic trace found the stale-Product-JSON defect. Same caveat as #8: live-only unless someone's watching, or Logpush is added. |
| 10 | Download activity | ✅ Full | `deliveries.downloads_used` / `last_download_at` (aggregate per purchase) and `download_tokens.used_at` (per individual download event) — both queried directly in this session's own forensic trace and proven accurate. |
| 11 | Email delivery | ✅ Full | `email_log` table: `template`, `recipient`, `status`, `attempt_count`, `last_error`, and the real Resend `provider_id` for every send attempt — proven in this session's trace (both purchase-receipt and secure-download rows had real Resend UUIDs). |
| 12 | Customer support visibility | ❌ None (no tooling) | Every data point above is real and queryable — but only via direct `wrangler d1 execute` SQL, which is exactly how support has been done throughout this entire engagement. **No admin dashboard exists.** `admin_users` and `audit_logs` tables exist in the schema but are never written to by any code — confirmed no `auditService.ts` or equivalent exists; they're reserved for a future admin-dashboard sprint, not functional today. A non-technical person cannot currently look up "what happened to purchase RWL-2026-000006" without CLI access and a raw SQL query. |

### Summary

Everything that happens **after** a checkout request reaches the Worker is genuinely well-instrumented — this project's own database *is* its analytics for the commerce funnel. What's missing is entirely on the **traffic/discovery side** (nobody knows how many people even see the homepage or click Buy without completing checkout) and the **support tooling side** (the data exists, but only a developer with CLI access can read it).

---

## 2. Recommended analytics stack

Three real options, evaluated for a small Ghana-based education/commerce site with no dedicated ops team:

| Option | Fit | Trade-off |
|---|---|---|
| **Cloudflare Web Analytics** | **Recommended.** Free, zero extra script (or a tiny one-line beacon), no cookies, no consent banner needed since it's not tracking individuals — and the site is *already* on Cloudflare, so there's no new vendor relationship to manage. Gives page views, top pages, referrers, countries, Core Web Vitals. | Doesn't do custom events out of the box (e.g., "buy button clicked") — would need manual `fetch()` beacon calls added to `buy-button.js` for that, a real (small) code change. |
| **Plausible** | Good second choice — privacy-friendly, no cookie banner needed, supports custom events more naturally than Cloudflare's version, reasonably priced for a small site. | It's a new paid vendor and a new script tag to load and maintain — more moving parts than reusing infrastructure already in place. |
| **Google Analytics 4** | Most powerful, free, huge ecosystem/documentation. | Requires a cookie-consent banner to stay compliant (the current Privacy Policy explicitly says no consent flow exists yet — adding GA4 without one would create the exact stale-legal-page problem already fixed twice this engagement); heavier script; sends data to Google, a real privacy trade-off for a financial-education brand whose whole positioning is "no hype, plain answers, we're not selling your data." |

**Recommendation: Cloudflare Web Analytics first.** It answers items 1-2 from the audit with the least new surface area, no compliance rework, and no new vendor. If buy-button-click-level funnel detail becomes genuinely needed later, add a handful of custom event beacons to the existing `buy-button.js`/`newsletter-form.js` files rather than reaching for a heavier tool. **Not implemented in this pass** — this is a recommendation, and the task explicitly said not to deploy analytics unless required; nothing here rose to "required."

---

## 3. Daily / Weekly / Monthly operational checklists

### Daily
- [ ] Skim `wrangler tail` (or Cloudflare's Workers Logs dashboard) for any `error`-level lines — specifically `verification.expired_but_paid_needs_review` (money moved, no fulfilment — needs manual action every time it appears) and `fulfilment.error`.
- [ ] If any purchase completed that day, spot-check its `email_log` rows show `status: 'sent'`, not `permanently_failed`.

### Weekly
- [ ] Query `SELECT status, COUNT(*) FROM purchase_sessions WHERE created_at > datetime('now','-7 days') GROUP BY status` — look for an unusual spike in `failed`/`expired` relative to `verified`.
- [ ] Query `email_log` for any `permanently_failed` rows in the last 7 days — these are silent unless someone looks.
- [ ] Re-run the weekly backup checklist from `docs/disaster-recovery.md` (git sync, secrets present).

### Monthly
- [ ] Full read-through of `purchase_sessions` for any `pending` rows older than their `expires_at` that were never swept — a known, previously-documented gap (nothing currently marks these `expired` automatically).
- [ ] Re-run the disaster-recovery fresh-migration test (`docs/disaster-recovery.md` §12).
- [ ] Review whether Cloudflare Web Analytics (or whichever was adopted) shows a traffic pattern worth acting on.

---

## 4. Workflows

### Customer support workflow

1. Customer emails `hello@robayerwealthlab.com` with a purchase reference (every receipt/download email includes one — confirmed in `emailService.ts`'s templates).
2. Look it up: `wrangler d1 execute robayer-wealthlab-db --remote --command "SELECT * FROM purchase_sessions WHERE purchase_reference = '<ref>'"`.
3. If `status = 'verified'` but the customer says they can't download: check `deliveries` for that session's `purchase_session_id` — if empty, fulfilment never ran (see the failed-fulfilment workflow below).
4. If `status = 'pending'` or `'failed'` and the customer insists they paid: check `payment_transactions` for that reference — if a `charge.success` row exists there but the session never transitioned, that's the `verification.expired_but_paid_needs_review` scenario — manual reconciliation required, not a self-resolving state.

### Failed payment workflow

1. Confirm which failure mode (see audit item 7): checkout-creation failure (no `payment_transactions` row) vs. Paystack-reported decline (`payment_transactions.status` reflects it).
2. For a checkout-creation failure: this is almost always transient (Paystack API hiccup) — ask the customer to simply try again; nothing to fix on this end unless it's happening repeatedly (check `wrangler tail` for a pattern of `checkout.provider_error`).
3. For a genuine decline: this is between the customer and their card/mobile money provider — direct them to retry with a different payment method on Paystack's own checkout page.

### Failed fulfilment workflow

*(This is the exact scenario this engagement's own forensic trace discovered and fixed once already — the process below is what should have existed to catch it sooner.)*

1. `payment_transactions` shows `charge.success` and `purchase_sessions.status = 'verified'`, but `deliveries` has no row for that `purchase_session_id`.
2. Check the live log for that reference's `fulfilment.*` line — `fulfilment.no_published_assets` means the live Product JSON's `downloadFiles` entry is malformed or missing (verify: `curl https://robayerwealthlab.com/content/products/<slug>.json` and check for `assetId`/`storageKey`/`status: "published"`). `fulfilment.error` means something else threw — read the logged error message.
3. Fix the underlying cause (content JSON, R2 object, etc.).
4. **Fulfilment does not automatically retry.** The safe, idempotent way to re-trigger it: have Paystack redeliver the original webhook (from the Paystack dashboard's event log), which re-enters the exact same, already-proven-idempotent code path (`INSERT OR IGNORE` on `deliveries`, confirmed safe to call twice in this engagement's D1 testing).

### Download troubleshooting workflow

1. Customer says their download link doesn't work — check `download_tokens` for the token (or `deliveries` for the purchase if the token's already gone from memory): `used_at` populated means it was already redeemed (single-use, expected — direct them to request a fresh one from the callback page); `expires_at` in the past with `used_at` still null means it simply expired (15-minute TTL) — same fix, request a fresh one.
2. If `deliveries.downloads_used >= max_downloads`, they've hit their purchase's download limit (default 5) — this is enforced by design, not a bug; a manual limit increase would be a direct `UPDATE deliveries SET max_downloads = ... WHERE id = ...`, a judgment call, not an automated path.
3. If none of the above and the download still 404s, check the R2 object itself actually exists at the asset's `storageKey` — this exact failure mode (`download.object_not_found_in_storage`) is the one this engagement found and fixed for the one real product; it would recur identically for any future product whose file wasn't uploaded.

---

## 5. Monitoring dashboard recommendations

Nothing here requires new infrastructure beyond what already exists:

- **Cloudflare Workers Logs** (dashboard, already enabled via `observability.enabled: true` in `wrangler.jsonc`) — the first place to look for any live issue; already real time, already zero-config.
- **A saved D1 query set**, not a dashboard tool — given the small scale, a short list of copy-pasteable `wrangler d1 execute` commands (the ones in the workflows above) is more practical right now than standing up a BI tool for a database this size.
- **Cloudflare Web Analytics** (recommended above) once added, for the traffic side specifically.

---

## 6. Key Performance Indicators (KPIs) for launch

| KPI | Source |
|---|---|
| Checkout-to-verified conversion rate | `purchase_sessions`: `COUNT(status='verified') / COUNT(*)` |
| Fulfilment success rate | `COUNT(deliveries) / COUNT(purchase_sessions WHERE status='verified')` — should be 1:1; any gap is a live incident |
| Email delivery success rate | `email_log`: `COUNT(status='sent') / COUNT(*)` |
| Download redemption rate | `download_tokens`: `COUNT(used_at IS NOT NULL) / COUNT(*)` |
| Newsletter growth | `newsletter_subscribers` row count over time |
| Support volume | `contact_messages` + `consultation_requests` row counts |

---

## 4. Final assessment

**Is the platform operationally ready for real customers?**
**Conditionally yes.** Every dollar-relevant event (payment, fulfilment, download, email) is genuinely, verifiably tracked in the database — proven repeatedly in this engagement's own forensic sessions, not just claimed. What's *not* ready is the human side of operations: there is no dashboard, no alerting, and no way for anyone but a developer with CLI access to see any of this. For a founder-run business at launch scale, that's workable *if* someone is actually watching logs daily (per the checklist above) — it is not "set and forget."

**What monitoring gaps remain?**
1. No traffic/funnel visibility above the checkout-session level (items 1, 2, 4 in the audit) — can't tell how many visitors even reach the Buy button.
2. No alerting — every failure mode is logged, but nothing pages anyone; someone has to be looking.
3. No customer-support tooling — every support case requires a raw SQL query run by whoever has Cloudflare CLI access.
4. Abandoned `pending` purchase sessions are never automatically swept to `expired` (same gap flagged in the disaster-recovery document).

**What should be checked on launch day?**
Everything in the Daily checklist above, plus: watch `wrangler tail` live during the first few real transactions specifically (not just periodically), and manually confirm the first real purchase's `deliveries`/`email_log` rows look correct before considering the day "routine."

**What should be reviewed after the first 10, 100, and 1,000 customers?**
- **First 10:** manually verify every single one completed the full funnel (verified → delivered → both emails sent) — at this volume, checking each by hand is realistic and worth doing.
- **First 100:** switch to the KPI table above — compute the conversion/fulfilment/delivery rates for real and compare against expectations; this is also the point where "no admin dashboard" starts to genuinely hurt, and building one becomes a reasonable next investment.
- **First 1,000:** the manual-query support model in this document stops scaling — this is the point to seriously revisit the `admin_users`/`audit_logs` tables that already exist in the schema but were deliberately deferred, and to add real alerting (Cloudflare Logpush → somewhere that pages a human) instead of relying on someone remembering to check logs daily.
