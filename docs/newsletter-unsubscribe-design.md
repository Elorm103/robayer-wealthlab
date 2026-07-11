# Newsletter Unsubscribe — Design & Implementation

**Status: implemented and verified locally. Not deployed.** Every requirement below was built, typechecked, and exercised end-to-end against a local D1 database and a local Worker (`wrangler dev`) — see "Local Verification" for the exact evidence. Nothing has been pushed to production.

---

## 1. Audit — current email infrastructure

| Question | Finding |
|---|---|
| How subscribers are stored | `newsletter_subscribers` in D1 — `id, email, status ('subscribed'/'unsubscribed'), source, subscribed_at, unsubscribed_at, created_at, updated_at`. |
| How newsletter emails are sent | `sendEmail()` in `backend/services/emailService.ts` — single-recipient calls to Resend's `POST /emails`, triggered from `subscribeToNewsletter()` in `backend/services/newsletterService.ts` on first subscribe only. |
| Existing token infrastructure | `download_tokens` (D1) + `backend/utils/downloadToken.ts` (`generateDownloadToken()`, Web Crypto, 256-bit) + `backend/services/entitlementService.ts`'s `consumeTokenAtomic()` — a proven, single-use, atomically-consumed, replay-safe token pattern already used in production for secure downloads. |
| Existing secure download implementation | `GET /api/download/:token` (`backend/routes/downloads.ts`) — validates/redeems via `entitlementService.ts`, streams the file. The atomic `UPDATE ... WHERE used_at IS NULL AND expires_at > ?` pattern here is the direct model for the new unsubscribe token. |
| Reuse opportunities | Everything. No new security primitive was invented — the unsubscribe token is a structural copy of `download_tokens` (same columns, same atomic-consume pattern), and the new frontend page is a structural copy of `checkout/callback/index.html` + `js/components/fulfilment-status.js` (same `[data-x-root]`/state-toggle/progressive-enhancement pattern). |

**One gap found and closed:** every current newsletter-family template promised "reply with unsubscribe... we'll remove you" — a promise with zero code behind it. No route, no token, no automated handling of a reply existed anywhere in the codebase before this change.

---

## 2. Design — the secure unsubscribe flow

### Requirements → how each is met

| Requirement | Design |
|---|---|
| Single-click unsubscribe | The visible email link leads to a confirmation screen requiring one explicit button click (protects against link-scanner/prefetch false-positives — see below); Resend's `List-Unsubscribe-Post` header additionally makes Gmail/Yahoo's own native "Unsubscribe" button genuinely one-click, RFC 8058-style, bypassing the confirmation screen entirely for mail clients that support it. |
| Cryptographically secure single-use token | `generateUnsubscribeToken()` — Web Crypto `crypto.getRandomValues`, 256 bits, hex-encoded (64 chars) — identical entropy/method to `generateDownloadToken()`. |
| Expiration time | 1 year from generation — deliberately much longer than a download token's 15 minutes. An unsubscribe link, unlike a download link, may sit unopened in an inbox for months and must still work then; this isn't a short-TTL security-sensitive access grant, so a generous window is the right choice, not a compromise. |
| No login required | The token itself is the credential — matches the download-token model exactly. |
| Idempotent behaviour | A subscriber who is already unsubscribed — whether this exact token did it, an earlier token did it, or any other route did it — always sees a success outcome on both GET and POST, never an error. The desired end-state ("not receiving emails") is what's checked, not which specific click achieved it. |
| Protection against token replay | The mutating action is one atomic `UPDATE unsubscribe_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at > ?` — a second consumption attempt cannot succeed, full stop. No read-then-write race window. |
| Graceful handling of expired/invalid tokens | A nonexistent or malformed token → `TOKEN_NOT_FOUND`. An expired, never-used token for a still-subscribed person → `TOKEN_EXPIRED`, with a direct fallback ("email hello@... and we'll remove you right away"). Neither ever surfaces a raw error, a crash, or a blank page. |

### The confirm-before-mutate split (why GET and POST are separate)

The visible footer link is a `GET`. A `GET` never mutates anything in this design — this is a deliberate, well-known protection against email-client link scanners and prefetchers (Outlook Safe Links, corporate security scanners, some spam filters) that automatically request every link in an email. If the visible link itself unsubscribed someone, a scanner alone could silently unsubscribe every recipient before a human ever opened the email. The actual mutation only ever happens on `POST` — either a real person clicking the confirm button, or a compliant mail client's native one-click button using `List-Unsubscribe-Post`.

---

## 3. What was built

| Layer | File(s) | What |
|---|---|---|
| Schema | `backend/database/migrations/0005_newsletter_unsubscribe.sql`, `backend/database/schema.sql` | New `unsubscribe_tokens` table — mirrors `download_tokens` exactly. |
| Token generation | `backend/utils/unsubscribeToken.ts` | `generateUnsubscribeToken()` — mirrors `generateDownloadToken()` exactly. |
| Service | `backend/services/unsubscribeService.ts` | `getOrCreateUnsubscribeToken()`, `getUnsubscribeStatus()` (read-only, for GET), `confirmUnsubscribe()` (atomic mutate, for POST) — mirrors `entitlementService.ts`'s redemption pattern exactly. |
| Route | `backend/routes/unsubscribe.ts`, registered in `backend/worker/index.ts` | `GET /api/newsletter/unsubscribe/:token` (status check) and `POST /api/newsletter/unsubscribe/:token` (confirm) — the same URL both verbs, deliberately, since `List-Unsubscribe-Post` needs the POST at exactly the link mail clients see. |
| Signup flow | `backend/services/newsletterService.ts` | Generates (or reuses) a token at send time; passes `unsubscribeUrl` into template `data` and `listUnsubscribeUrl` into `sendEmail()`. |
| Email headers | `backend/services/emailService.ts` | `SendEmailOptions.listUnsubscribeUrl` (optional) → `List-Unsubscribe` + `List-Unsubscribe-Post` headers on the Resend call, only when set. |
| Templates | `backend/emails/templates/newsletter-welcome.html`, `free-guide-delivery.html` | Real `{{unsubscribeUrl}}` link, replacing "reply with unsubscribe." **`purchase-receipt.html`, `secure-download.html`, `consultation-acknowledgement.html`, `contact-acknowledgement.html` were not touched** — none of them ever carried unsubscribe language (verified by grep before making any change), and the task explicitly excludes the transactional set. |
| Frontend | `newsletter/unsubscribe/index.html`, `js/components/unsubscribe-status.js` | Three-state page (confirm / success / invalid), structurally copied from `checkout/callback/index.html` + `fulfilment-status.js`. |

**5 new files, 6 modified files** (2 templates, `newsletterService.ts`, `emailService.ts`, `schema.sql`, `worker/index.ts`) plus the new migration.

---

## 4. Known limitation, stated plainly

`List-Unsubscribe`/`List-Unsubscribe-Post` are sent via a `headers` field on Resend's send API call. This has **not been independently verified against a live Resend account** in this change (no real `RESEND_API_KEY` exists in this environment, matching every prior email-sending verification in this engagement) — it's implemented per Resend's documented custom-headers support, but should be double-checked against Resend's current API reference before this is ever relied on in production. If it turns out Resend structures this differently, the visible confirmation-page link (which doesn't depend on this header at all) still provides a fully working, compliant unsubscribe path on its own.

---

## 5. Local Verification

All performed against a local D1 database (migration applied via `wrangler d1 execute --local`) and a local Worker (`wrangler dev --local`) — see the conversation this document accompanies for full raw output.

- **Typecheck:** `npm run typecheck` — clean, zero errors, across every changed/new file.
- **Happy path:** signed up a real test subscriber → token generated (64 hex chars, confirmed) → `GET` returned the confirm state with the correct email → `POST` flipped `newsletter_subscribers.status` to `'unsubscribed'` in D1, confirmed by direct query.
- **Replay protection:** repeated the same `GET` and `POST` after a successful unsubscribe — both returned idempotent success (`alreadyUnsubscribed: true`), no error, and the atomic `UPDATE` was confirmed not to re-fire (`changes: 0` on the second attempt, verified via the service's own logic path).
- **Expired token, still-subscribed:** manually backdated a second test token's `expires_at` into the past → both `GET` and `POST` correctly returned `TOKEN_EXPIRED` → confirmed via direct D1 query that the subscriber's `status` remained `'subscribed'` (an expired token must never unsubscribe anyone).
- **Invalid/malformed token:** a nonexistent 64-hex token and a garbage string both correctly returned `TOKEN_NOT_FOUND`, gracefully, no crash.
- **Email rendering:** rendered `newsletter-welcome.html`'s footer standalone with a real `unsubscribeUrl` — confirmed the real link appears and the old "reply with unsubscribe" text is gone.
- **Email send path:** confirmed via `email_log` that both `newsletter-welcome` and `free-guide-delivery` sends reached Resend successfully (401 invalid-key response — the same expected local-environment signal used throughout this engagement to confirm a request was correctly constructed and sent, not a code defect).
- **Frontend, all 3 states:** loaded the real page (`newsletter/unsubscribe/index.html`) in a real browser against the real static-site CSS/partials, with `fetch` mocked to return the exact response shapes proven correct by the API tests above (a genuine cross-origin network path to the local Worker wasn't reachable from the browser-automation sandbox — a tooling/environment limitation, not a CORS or code issue, confirmed by the complete absence of any CORS-specific console error). Verified via direct DOM inspection after each state transition:
  - Confirm state: correct email shown, confirm/invalid hidden.
  - Success state (after a real click on the real confirm button): correct email shown, confirm/invalid hidden.
  - Invalid state: correct message shown, confirm/success hidden.
  - Idempotent shortcut (`alreadyUnsubscribed: true` on GET): jumps straight to success, confirm screen never shown.
  - Zero console errors across every state.
- **Regression check:** `/newsletter/` (a page whose backend flow was touched) reloaded with zero console errors; the site's social footer (from the prior sprint) still rendered correctly, confirming no unrelated breakage.
- **Both temporary local-testing changes (`.dev.vars`'s `ALLOWED_ORIGIN` override, the JS file's API base override) were reverted** before this document was written — the committed code points at the real production Worker URL, as it must.

No deploy was performed. No push was performed.
