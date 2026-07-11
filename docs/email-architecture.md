# Outbound Email Architecture (Version 1.2 — Pre-Sprint 3)

**Status: architecture and documentation only.** No email has ever
been sent by this project. No Worker code exists. No provider account
has been created. This document specifies the design Sprint 3 (or
whichever sprint actually implements it) builds from, matching the
same "design first, build later" discipline as every other backend
document in `docs/`.

## Recommended provider: Resend

**Recommendation: Resend**, called directly via its HTTP API from a
Cloudflare Worker — no SDK dependency required, since Resend's API is
plain REST and Workers already have native `fetch`.

**Why not a genuinely Cloudflare-native alternative:** Cloudflare does
not offer one. Cloudflare Email Routing exists, but it solves a
different problem entirely (routing *inbound* mail to an address —
e.g., `hello@robayerwealthlab.com` → a personal inbox); it has no
outbound transactional-sending API, templating, or delivery/bounce
tracking. There is no Cloudflare product to prefer over Resend here —
this confirms Resend as the right choice rather than a compromise.

**Why Resend over other outbound providers** (Postmark, SendGrid,
Mailgun, AWS SES):

- **Fetch-only API, no Node-specific SDK quirks** — some competitor
  SDKs assume a Node runtime (e.g., relying on Node's `http` module
  internals) and need a compatibility shim inside a Worker; Resend's
  API is called with a plain `fetch()` POST, identical to how this
  project already calls Paystack's API (`docs/paystack-integration.md`).
- **Simple domain verification** (SPF/DKIM/DMARC records added once to
  the `robayerwealthlab.com` DNS zone — already managed in Cloudflare,
  per Sprint 2's "already in place" reasoning for choosing Cloudflare
  at all).
- **No new cloud-vendor relationship** in the way AWS SES would
  introduce a full separate AWS account, IAM setup, and SES sandbox
  approval process — disproportionate operational overhead for this
  project's scale and its explicit "smallest reasonable footprint"
  posture (Sprint 2 excluded Firebase/Supabase/Netlify/Vercel for the
  same reason).
- Reasonable free tier and per-email pricing appropriate to a small
  business's actual volume (a handful of transactional emails per
  order/subscriber/consultation, not bulk marketing blasts).

Postmark is a reasonable second choice with comparable reliability;
Resend is preferred for its simpler API shape and pricing at this
project's scale. This is a recommendation to revisit only if Resend's
deliverability or pricing changes materially — not a decision this
document treats as permanent regardless of evidence.

## How Workers authenticate to Resend

A single API key, sent as `Authorization: Bearer {RESEND_API_KEY}` on
every request — stored exactly like every other secret in this
architecture: set via `wrangler secret put RESEND_API_KEY`, never
written to `wrangler.toml`, never committed to this repository, per
the existing convention in `backend/config/README.md` and
`docs/backend-security.md`. `RESEND_API_KEY` is added to that
existing environment-variable table as part of this task (see the
cross-link updates below) rather than establishing a second,
separate secret-management convention.

## Which system events send an email

| Trigger | Endpoint (from `docs/worker-api-design.md`) | Template |
|---|---|---|
| Newsletter sign-up | `POST /api/newsletter` | Newsletter welcome |
| Consultation request submitted | `POST /api/consultation` | Consultation acknowledgement |
| Contact form submitted | `POST /api/contact` *(not yet in `docs/worker-api-design.md` — see note below)* | Contact acknowledgement |
| Payment verified successfully | `POST /api/payments/verify` | Purchase receipt |
| Download entitlement created (immediately after the above) | same request as above | Secure download |
| *(Future)* Admin requests a password reset | *(not yet designed — no admin password-reset flow exists in Sprint 2's scope)* | Password reset |

**Note on `POST /api/contact`:** Sprint 2's endpoint list didn't
include a contact-form endpoint, but this task's required template
list does. `contact-form.js` has the identical "validates client-side,
submits nowhere" gap already flagged for the newsletter and
consultation forms (`docs/admin-module.md`). Closing it means adding
one more endpoint, identical in shape to `POST /api/consultation` —
this is a small, natural extension of the already-established pattern,
not a new architecture decision. **Resolved in Version 1.2 Sprint 3:**
`POST /api/contact` is now documented in `docs/worker-api-design.md`
and implemented in `backend/routes/contact.ts`.

## Required templates

Every template shares the branding shell described below and is
written in plain, honest language consistent with this project's
existing tone — no fabricated urgency, no claims this project doesn't
make elsewhere on the live site.

1. **Newsletter welcome** — sent once, on first subscribe (not on
   every re-subscribe after an unsubscribe — see
   `docs/database-design.md`'s `newsletter_subscribers.status`
   handling). Confirms subscription, sets expectation ("weekly, free,
   no spam" — matching the exact copy already on every newsletter
   sign-up form sitewide), includes an unsubscribe link.
2. **Consultation acknowledgement** — sent immediately on request
   submission. Must restate, in the email itself, the same honesty
   already required on the live page (Sprint 3 of Version 1.1): **this
   is not a booking confirmation** — a request has been received and
   will be reviewed manually, with a reply expected within 2–3 business
   days. Getting this wrong (sounding like a booking confirmation) would
   contradict a compliance decision already made once; this template
   must not re-introduce that mistake in a different channel.
3. **Contact acknowledgement** — sent immediately on contact-form
   submission. Simple confirmation that a general enquiry was received;
   no manual-review language needed (that's specific to consultations),
   but still no promise of a specific response time beyond what
   `/contact/` already states.
4. **Purchase receipt** — sent immediately after a payment is verified
   (`POST /api/payments/verify` success). Product title, amount paid,
   order reference, date — a plain record of the transaction. This
   template's content overlaps with the R2 `receipts/` PDF
   (`docs/storage-strategy.md`) conceptually but is not the same
   artifact: the email is the immediate confirmation; the PDF (if/when
   built) is a downloadable formal receipt. Not fixed by this document.
5. **Secure download** — sent immediately after the receipt (or
   combined into one email — an implementation-time choice, not an
   architecture one), containing a freshly-minted, short-lived link to
   `GET /api/download/:token` (never a permanent file URL — see
   `docs/storage-strategy.md`). This is also the template used any time
   a buyer requests "resend my download" later.
6. **Password reset** *(future, admin-only)* — no admin password-reset
   flow is designed yet (Sprint 2 scoped only `POST /api/admin/login`/
   `logout`). This template is named here so the branding shell and
   folder convention (below) already account for it once that flow is
   designed — not because it's needed today.

## Retry strategy

Sending must never be allowed to slow down or fail the request that
triggered it — a Worker should never make a buyer wait on Resend's API
before confirming their payment succeeded. Recommended flow:

1. **Inline attempt with one immediate retry.** The triggering route
   (e.g., `payments/verify`) calls `emailService.send()` after its own
   business logic (marking the order paid, creating the `downloads`
   row) has already succeeded and been committed to D1 — email sending
   is the last step, never a precondition for the business outcome.
   One immediate retry on a transient failure (a Resend 5xx or network
   error) is attempted before giving up for now.
2. **Failure recorded, not thrown.** If both attempts fail, the
   attempt is logged to a new `email_log` table (see the schema
   addition below) with `status = 'failed'` — the API response to the
   buyer/admin is still success (their order/subscription/request was
   genuinely processed), because the email is a delivery mechanism for
   that outcome, not the outcome itself.
3. **A scheduled Worker (Cron Trigger) retries later.** Rather than
   introducing Cloudflare Queues as a new primitive beyond Sprint 2's
   established Workers/D1/R2/KV set, a Cron Trigger (a standard,
   built-in Workers feature — a scheduled function, not a separate
   product) runs every few minutes, finds `email_log` rows with
   `status IN ('failed', 'queued')` and `attempt_count` below a small
   ceiling (e.g., 5), and retries them. This keeps the architecture to
   exactly the primitives already chosen. **Queues are worth
   revisiting only if email volume or retry complexity grows well
   beyond this project's realistic scale** — not a default assumption.

## Failure handling

- **A failed email must never block the underlying action.** A payment
  that verified successfully stays verified even if Resend is down —
  the buyer can still see their order and request their download via
  `GET /api/orders/:id` and (once minted) `GET /api/download/:token`,
  independent of whether the receipt/download *email* ever arrived.
  This is the same "email is the resilient default, not the only way"
  principle already established in `docs/download-security.md`.
- **Transient vs. permanent failure.** A 5xx or timeout is transient
  (retry per above). A `4xx` indicating an invalid/rejected address is
  permanent — not retried, marked `status = 'permanently_failed'` in
  `email_log`, and surfaced for manual follow-up in a future admin
  view (per `docs/admin-module.md`'s existing "Downloads"/"Customers"
  read-only support views — this fits the same pattern, not a new one).
- **Bounce and complaint webhooks.** Resend can send webhook events
  (`email.bounced`, `email.complained`) back to a Worker endpoint —
  mirroring the exact signature-verification discipline already
  required for Paystack's webhook (`docs/backend-security.md`): never
  trust an unverified webhook payload. A hard bounce or spam complaint
  for a `newsletter_subscribers` row should automatically set its
  `status` to `unsubscribed` — protecting sender reputation without
  requiring a human to notice the bounce first.

## Rate limiting

Every email-triggering endpoint (`newsletter`, `consultation`,
`contact`, `payments/verify`) already sits behind the KV-based
per-IP/per-email rate limiting designed in `docs/backend-security.md`
— that existing limit is also, incidentally, the first line of defense
against email-sending abuse, not a separate mechanism. On top of that,
one email-specific safeguard: a cap on **total emails sent to the same
address per day** (e.g., 10), tracked the same way (a KV counter keyed
by `emailrate:{recipient}:{date}`) — a safety net against any future
bug causing a send-loop, independent of which endpoint triggered it.

## Branding strategy

- **Reuse the real logo already live on the site**
  (`https://robayerwealthlab.com/assets/branding/logo/logo-mark.png`)
  as the email header image — email clients need a stable, always-
  reachable URL, and this project already has one; there is no reason
  to duplicate the asset into R2 or anywhere else.
- **Reuse the same design tokens conceptually**, not literally — email
  clients don't support CSS custom properties (`tokens.css`'s
  `var(--color-*)`), so each template hardcodes the same hex values
  `tokens.css` already defines (Growth Green, Sika Gold, Warm Paper),
  kept in sync by convention (a comment in the shared layout noting
  which `tokens.css` values they mirror), not by any build step.
- **Plain, mobile-friendly HTML, not a heavy designed template.**
  Matches this project's own restrained, honest visual language rather
  than a dense marketing-email layout — a logo, a short message, a
  clear call-to-action link, a plain-text footer.
- **Transactional vs. marketing footer.** The newsletter welcome email
  includes an unsubscribe link (required for a marketing-style, opt-in
  email). Consultation/contact acknowledgements and purchase-related
  emails are transactional — triggered by the recipient's own direct
  action — and don't need (or legally require) an unsubscribe
  mechanism, though every email still includes the same real contact
  details already shown in the site's footer (`partials/footer.html`),
  not a fabricated "company address" this project doesn't otherwise
  publish.
- **Tone matches the rest of the site**: no invented urgency, no
  exaggerated claims, the same compliance posture already applied to
  every product/service/calculator on the live site.

## Where templates live in the repository

A new `backend/emails/` folder (sibling to `worker/`, `routes/`, etc.)
— see the folder-structure addition in this task's file list. One
template file per email, plus one shared layout, mirroring the exact
pattern this site already uses for shared page structure
(`partials/header.html`/`footer.html` reused across every page):

```
backend/emails/
  README.md
  layouts/
    base.html          — shared header/footer/brand shell every template extends
  templates/
    newsletter-welcome.html
    consultation-acknowledgement.html
    contact-acknowledgement.html
    purchase-receipt.html
    secure-download.html
    admin-password-reset.html   (future — placeholder name only, no flow designed yet)
```

No template file is created by this task — only the folder's
documented structure (`backend/emails/README.md`), consistent with
how `backend/routes/`, `backend/middleware/`, and `backend/services/`
were left as documented-but-empty in Sprint 2, since actually writing
template markup without a sending mechanism to test it against would
be exactly the kind of premature, unverifiable build this project
avoids.

## How the admin dashboard will eventually manage templates

**Staged, not built all at once — matching this project's own content
philosophy** (`content/README.md`'s "write real content in HTML/files
first, only add a database or editing tool once a genuine need is
proven" applied here to email instead of page content):

- **Stage 1 (near-term, alongside first implementation):** templates
  are the static files described above, edited directly in this
  repository via a normal pull request — no admin UI needed yet. The
  admin dashboard's Settings module (`docs/admin-module.md`) shows a
  **read-only preview** of each template (rendered with sample data) so
  an admin can see what a buyer/subscriber receives, without yet being
  able to edit it there.
- **Stage 2 (future, only once genuinely justified — e.g., template
  copy needs to change often enough that a PR-per-edit becomes real
  friction):** template *content* (subject line, body copy) migrates
  from static files into a `email_templates` D1 table, with the
  Settings module gaining real inline editing, while the branding
  shell/layout stays code, not database content — the same "content in
  a database only once files genuinely don't scale" reasoning this
  project has applied consistently rather than defaulting to a CMS on
  day one.

## What this document does not decide

- The exact Cron Trigger interval and max retry count — small,
  tunable operational parameters, not architecture.
- Whether the purchase receipt and secure download emails are one
  message or two — implementation-time UX choice.
- The final HTML/copy of any template — this document specifies what
  each template must communicate, not its final wording or markup.
