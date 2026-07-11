# Forensic Report — Free Guide Delivery Failure

**Read-only investigation. No code modified. Nothing committed. Nothing deployed.**

**Root cause, stated up front:** this is a **missing-wiring defect**, not a configuration problem and not an infrastructure failure. The free-guide signup form was built by reusing the site's generic newsletter-subscription endpoint, and no code was ever written to send the guide, link to it, or attach it. The guide's PDF file is real, deployed, and publicly reachable by direct URL — but nothing in the entire codebase ever tells a subscriber that URL exists.

---

## Trace, stage by stage

### 1. Frontend form submission — `free-guide/index.html`, line 161

```html
<form class="stack gap-3" data-newsletter-form data-confirmation-message="Check your email to receive your free guide." novalidate aria-label="Free guide signup">
```

The free-guide page's form carries no identity of its own — it uses `data-newsletter-form`, the exact same attribute the site's regular newsletter signup form uses everywhere else (homepage, `/newsletter/`, `/resources/`, footer). The only thing that distinguishes it is a custom success message (`data-confirmation-message`), which is purely cosmetic — it changes what the *browser* displays after submit, it has no effect on what the *server* does.

### 2. `js/components/newsletter-form.js`, lines 44-47

```js
const response = await fetch(NEWSLETTER_API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, source: window.location.pathname }),
});
```

Confirms the above: the only payload sent is `{ email, source }`. `source` will be `"/free-guide/"` when submitted from that page — but this is the *only* signal anywhere that a guide was promised, and as traced below, nothing ever reads it for that purpose.

### 3. API endpoint / Worker route — `backend/routes/newsletter.ts`

`handleNewsletter()` validates the email, reads `source` as a plain string, and passes both straight into `subscribeToNewsletter()`. No branching on `source`'s value exists in this file — it doesn't ask "did this come from the free-guide page," it only ever asks "is this a valid email."

### 4. Database writes — `backend/services/newsletterService.ts`, lines 42-50

```js
const inserted = await env.DB.prepare(
  `INSERT INTO newsletter_subscribers (email, status, source, subscribed_at)
   VALUES (?, 'subscribed', ?, datetime('now'))`
)
```

`source` is written to the database — correctly, as data — but it is **never read back or branched on anywhere in this file, or anywhere else in the codebase.** It exists purely as a historical record of where a subscriber came from, not as a signal that changes behavior.

### 5. Newsletter service → email trigger — `backend/services/newsletterService.ts`, lines 65-73

```js
if (isFirstSubscribe) {
  await sendEmail(env, logger, {
    template: 'newsletter-welcome',
    to: input.email,
    data: {},
    entityType: 'newsletter_subscriber',
    entityId: subscriberId,
  });
}
```

**This is the exact line where the wiring is missing.** Regardless of `source`, regardless of which page the visitor signed up from, this function sends exactly one hardcoded template: `'newsletter-welcome'`. There is no `if (input.source === '/free-guide/')` branch. There is no second template. There is no second `sendEmail()` call. This is the entire, complete set of email-sending logic this function contains.

### 6. Email template — `backend/emails/templates/newsletter-welcome.html`

Read in full. It is generic by design: welcomes the subscriber to "the Robayer WealthLab community," lists future-tense benefits ("early access to new eBooks, tools and courses"), and has one CTA button linking to the homepage. **It contains no mention of the free guide, no download link, and no attachment placeholder of any kind.** This is not a broken template — it's working exactly as written; it was simply never written to deliver a guide, because it predates the free-guide page entirely (this template is the original Sprint 3 newsletter-welcome email; the free-guide landing page was built in a later sprint and never given its own template).

### 7. Resend request — `backend/services/emailService.ts`, lines 119-131

```js
body: JSON.stringify({
  from: 'Robayer WealthLab <hello@robayerwealthlab.com>',
  to: [to],
  subject,
  html,
}),
```

Confirmed directly: the request this codebase sends to Resend's API has exactly four fields — `from`, `to`, `subject`, `html`. **There is no `attachments` field anywhere in this function, and `SendEmailOptions` (the type every call site must satisfy) has no attachment field in its interface either.** Even if `newsletterService.ts` *wanted* to send a PDF attachment today, the email-sending layer beneath it has no mechanism to accept or forward one. This would need to be built, not just wired up.

### 8. Free-guide-specific logic

There isn't any. Searched the entire codebase for any reference to the guide's filename or any free-guide-specific delivery path: none exists outside the landing page's own copy and the form described above. The free-guide page is, from the backend's perspective, indistinguishable from any other newsletter signup form on the site.

### 9. R2 — checked, and confirmed not involved

R2 (`robayer-wealthlab-storage`) is used exclusively by the paid digital-product fulfilment system (`entitlementService.ts`, `routes/downloads.ts`) — a completely separate pipeline gated by a verified Paystack purchase. The free guide was never put in R2, never routed through the entitlement/download-token system, and none of that code is reachable from a newsletter signup. This is a real, deliberate architectural separation (free content vs. paid content), not a bug — but it does mean the free guide has no equivalent secure-delivery mechanism at all right now.

### 10. Where the actual PDF lives — confirmed live, confirmed orphaned

```
git ls-files assets/downloads/          → assets/downloads/7-money-mistakes-ghana.pdf (tracked, real, 89KB)
curl -I https://robayerwealthlab.com/assets/downloads/7-money-mistakes-ghana.pdf → 200 OK
grep -r "7-money-mistakes-ghana" (all HTML/JS/TS) → zero matches anywhere
```

The file is real, committed, deployed, and reachable right now by anyone who happens to know or guess its exact URL. **No page, no email, and no piece of code anywhere in this project links to it.** It is a fully orphaned asset.

### 11. Logs / real production evidence

Queried the live database directly rather than relying on the code trace alone. Two real people have signed up through `/free-guide/`:

| Subscriber | Signed up | Email(s) received |
|---|---|---|
| `ajuik7449@gmail.com` | 2026-07-08 12:03:35 | **One** — `newsletter-welcome`, `status: sent`, real Resend id `f68b7ea3-...` |
| `thewatchmansv@gmail.com` | 2026-07-11 13:28:42 | **One** — `newsletter-welcome`, `status: sent`, real Resend id `e44a10c4-...` |

Both delivered successfully (Resend accepted and returned a real message id in both cases — this is not an email-deliverability problem, Resend did exactly what it was asked). Both received exactly one email, the generic welcome, and nothing else. This is real, first-party evidence from production, not an inference — and it matches the reported symptom exactly: welcome email arrives, guide does not, no second email, no attachment, no link.

---

## Exactly where execution stops

Execution doesn't "stop" or error out anywhere — that's precisely the problem. Every step from form submission through email delivery **succeeds**. The signup is recorded correctly. The welcome email sends correctly. Resend delivers it correctly. There is no exception, no failed request, no log line indicating an error. **The flow completes successfully end-to-end — it was simply never built to include the guide in the first place.** The promise on the confirmation page ("Check your email to receive your free guide") describes a delivery step that does not exist anywhere in the code that runs after that message is shown.

---

## Classification

- **Not a configuration problem.** Resend, the API route, rate limiting, and the database write all function correctly and exactly as designed.
- **Not an infrastructure problem.** The PDF is deployed and reachable; Resend is delivering mail successfully with real provider confirmations.
- **This is missing wiring / missing content**, specifically:
  1. `backend/services/newsletterService.ts`, lines 65-73 — no logic exists to select a different template (or send a second email) based on `input.source`.
  2. No `free-guide-delivery` (or equivalent) email template exists in `backend/emails/templates/` — it was never created.
  3. `backend/services/emailService.ts`'s `SendEmailOptions` interface and `callResend()` function have no attachment support — if the intended fix is "attach the PDF," that capability doesn't exist yet and would need to be added, not just wired up.
  4. `assets/downloads/7-money-mistakes-ghana.pdf` is a real, live, correctly-deployed file with zero inbound references anywhere in the application.

No fix has been applied. This report is diagnostic only, per the scope of this investigation.
