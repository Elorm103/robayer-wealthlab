# Implementation Report — Free Guide Delivery Fix

Fixes the root cause identified in [docs/free-guide-forensic-report.md](free-guide-forensic-report.md): free-guide signups received the generic newsletter welcome email instead of the guide.

## Changes

1. **`backend/emails/templates/free-guide-delivery.html`** (new) — dedicated template: thanks the visitor, briefly introduces Robayer WealthLab, and has a "Download Your Free Guide" button linking directly to the existing deployed asset (`https://robayerwealthlab.com/assets/downloads/7-money-mistakes-ghana.pdf`). No attachment — same pattern as every other template in this system, none of which support attachments (`emailService.ts`'s Resend payload has no `attachments` field).

2. **`backend/services/emailService.ts`** — registered the new template: added `'free-guide-delivery'` to `EmailTemplateName` and the `TEMPLATES` map. No other logic changed.

3. **`backend/services/newsletterService.ts`** — added `isFreeGuideSource()`, which normalizes `input.source` (real value is `window.location.pathname`, e.g. `/free-guide/`, not a bare slug) and compares it to `free-guide`. `subscribeToNewsletter()` now selects `free-guide-delivery` when true, `newsletter-welcome` otherwise (unchanged default). This is the only behavioral change — the insert/update/idempotency logic is untouched.

Paid-purchase templates (`purchase-receipt`, `secure-download`) and their only caller, `fulfilmentService.ts`, were not touched.

## Verification (local, `wrangler dev --local` against local D1)

- `npm run typecheck` — clean.
- `POST /api/newsletter` with `source: "/newsletter/"` → `email_log.template = 'newsletter-welcome'`.
- `POST /api/newsletter` with `source: "/free-guide/"` → `email_log.template = 'free-guide-delivery'`.
- Re-submitting the same free-guide email a second time sent no additional email (`email_log` count stayed at 1) — existing idempotency preserved.
- Rendered `free-guide-delivery.html` standalone with the same substitution logic as `emailService.ts`: subject is guide-specific ("Your free guide: 7 Money Mistakes to Avoid in Ghana"), body contains the button text "Download Your Free Guide" linking to the correct PDF URL.
- Confirmed the linked asset is live: `GET https://robayerwealthlab.com/assets/downloads/7-money-mistakes-ghana.pdf` → `200`, `Content-Type: application/pdf`, 89,437 bytes.
- Both test sends reached Resend and were rejected only for an invalid local placeholder API key (401, `"API key is invalid"`) — confirms the template rendered without error and the correct template name was used at every layer, independent of Resend delivery status.
- Grepped for other callers of `purchase-receipt`/`secure-download` — only `fulfilmentService.ts`, unmodified. No regression to paid-purchase email flow.

## Result

Both requirements confirmed: correct template selected per signup source, download button links to the correct live asset, `email_log` records the correct template in each case, no regressions to the generic newsletter flow or paid-purchase emails.
