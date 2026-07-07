# Lead Magnet Architecture

**Status: Phase 1 shipped — signup flow live, automated PDF delivery
not yet built.** This document explains how the free guide
("The 7 Money Mistakes That Keep Many Ghanaians Broke") fits into the
existing site and backend, what's real today, and exactly where a
future phase should connect automated delivery.

## What this is

`/free-guide/` is a landing page for a free, downloadable PDF guide —
the site's first lead-generation asset, distinct from the paid eBook
(`/books/starting-to-invest-with-gh100/`). Its purpose: grow the
newsletter list while building enough trust that a reader naturally
considers the paid eBook next. It reuses the site's existing design
system and the existing production newsletter backend — nothing new
was built at the infrastructure level.

## Where the pieces live

| Piece | Location | Status |
|---|---|---|
| Guide content (source of truth for the PDF) | Written directly into the PDF-generation step (see "PDF replacement process" below) — not duplicated as an HTML page, matching `content/README.md`'s "every real page ships its own content directly" convention | Real, complete |
| Generated PDF | `assets/downloads/7-money-mistakes-ghana.pdf` | Real file, ~12 pages |
| Landing page | `free-guide/index.html` | Real page, live |
| Homepage promo | `index.html`, "Free Guide Promo" section (before Services) | Real, live |
| Signup form | Reuses `js/components/newsletter-form.js` + `POST /api/newsletter` (`backend/routes/newsletter.ts`) | Real, unmodified backend |

## PDF replacement process

The PDF at `assets/downloads/7-money-mistakes-ghana.pdf` was generated
programmatically (Node + `pdfkit`) from the written guide content, not
hand-designed in a separate tool. To replace or update it:

1. Edit the guide's source content (currently the content object at the
   top of the generation script used to build the PDF — a future
   iteration could promote this to a tracked file, e.g.
   `content/lead-magnets/7-money-mistakes.json`, if more lead magnets
   are added later and a shared generation script becomes worth
   building — not needed yet for a single guide).
2. Regenerate the PDF and confirm the page count still lands
   "approximately 8–12 pages" and that no `{{placeholder}}`-style
   artifacts or `undefined`/`NaN` text leaked into the output.
3. Overwrite `assets/downloads/7-money-mistakes-ghana.pdf` in place —
   this is a static asset, no build step, no deploy step beyond the
   normal GitHub Pages publish.
4. If the filename changes, update the one place a future delivery
   mechanism will reference it (see below) — nothing on the live
   `/free-guide/` page currently links to this file directly (see
   "Why the PDF isn't linked from the page yet").

## Why the PDF isn't linked from the page yet

The signup flow deliberately does **not** expose a direct download
link or button anywhere on `/free-guide/`. Per this phase's explicit
scope, delivery is meant to happen by email, not by an immediate
in-browser download — a visitor's reward for subscribing should be
"check your email," not a link sitting in the page's HTML that
search engines and browsers can index and cache indefinitely (a
permanent public URL to a "free" asset is also the one case
`assets/downloads/README.md` already flags as the legitimate exception
to its own "never link a real product file directly" rule — this guide
qualifies as that exception once real delivery exists, but there's no
reason to expose the URL before the delivery experience around it is
actually built).

## Future delivery workflow — exactly where it connects

**Not built in this phase, by explicit instruction.** Today, subscribing
via `/free-guide/`'s form calls the same `POST /api/newsletter` every
other newsletter signup on the site uses, and shows "Check your email
to receive your free guide." No second email is sent — the existing
`newsletter-welcome` acknowledgement email is what actually arrives
(see `docs/email-architecture.md`).

When automated delivery is built, it connects at exactly these points,
none of which need to change:

1. **`backend/services/newsletterService.ts`** — `subscribeToNewsletter()`
   already knows whether a subscribe is genuinely new
   (`isFirstSubscribe`) versus a repeat. The natural hook is to pass an
   additional flag or a distinct email template name through to
   `sendEmail()` when `input.source` indicates the visitor came from
   `/free-guide/` (the existing `source` field, already captured today
   via `window.location.pathname`, already carries this signal without
   any schema change).
2. **`backend/services/emailService.ts`** — already supports multiple
   named templates (`EmailTemplateName`); adding a fourth,
   `'free-guide-delivery'`, following the exact same pattern as the
   three that exist today, is the natural extension point. No change
   to `renderTemplate()`, `callResend()`, or `sendEmail()`'s signature
   is needed.
3. **`backend/emails/templates/`** — a new template file,
   `free-guide-delivery.html`, following the same
   `<!-- SUBJECT: ... -->` / `<!-- PREHEADER: ... -->` /
   `{{placeholder}}` convention as the three existing templates.
4. **The PDF attachment itself** — Resend's `/emails` endpoint supports
   file attachments natively; `callResend()` in `emailService.ts` would
   need to read `assets/downloads/7-money-mistakes-ghana.pdf` (bundled
   the same way the HTML templates already are, via `wrangler.jsonc`'s
   `[[rules]]` — a `Data`-type rule rather than `Text`, since a PDF is
   binary) and include it as a base64-encoded attachment.
5. **`email_log`** — no schema change needed; a `free-guide-delivery`
   row records the same way every other send does today.

None of this is implemented. This section exists so a future
implementer doesn't have to rediscover the right seams — it's written
as a map, not a promise of a specific timeline.

## Newsletter integration

Per this phase's explicit constraint, **no second newsletter system was
built.** `/free-guide/`'s two signup forms are the exact same
`[data-newsletter-form]` component, calling the exact same
`POST /api/newsletter` endpoint, subject to the exact same validation
and rate limiting as every other newsletter form on the site
(`docs/worker-api-design.md`, `docs/backend-security.md`). The only
change made to support this page was additive and backward-compatible:
`js/components/newsletter-form.js`'s `showConfirmation()` now checks
for an optional `data-confirmation-message` attribute on the `<form>`
element, falling back to the sitewide default ("You're in. Look out
for your first tip soon.") when absent — every existing form across
the site, having no such attribute, renders exactly as it did before
this phase. `/free-guide/`'s two forms set
`data-confirmation-message="Check your email to receive your free
guide."` to reflect what actually happens today.

## Future ebook integration

`/free-guide/` ends with an explicit, soft invitation to
`/books/starting-to-invest-with-gh100/` — positioned as "the logical
next step," not a hard sell, matching this project's established
no-pressure tone. No cross-sell automation exists (e.g., "email
everyone who downloaded the free guide but hasn't bought the eBook
after N days") — that would require the same kind of segmented,
triggered email logic described in "Future delivery workflow" above,
extended further, and is explicitly out of this phase's scope. The
natural hook, when that's built, is `email_log`'s existing
`entity_type`/`entity_id` pattern: a future `orderService` (still
unimplemented — Paystack/Orders remain out of scope entirely) could
query "subscribers with a `free-guide-delivery` email but no
completed order" the same way any other segment would be queried.

## What was explicitly not touched

Per this phase's scope: no Paystack integration, no product/download
system changes, no admin dashboard, no changes to
`backend/routes/newsletter.ts`, `backend/services/newsletterService.ts`,
`backend/services/emailService.ts`, or any other backend file — the
signup flow is a pure frontend integration against infrastructure that
already existed and was already production-tested.
