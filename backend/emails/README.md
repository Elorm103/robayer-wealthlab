# emails/

## Purpose

Holds every outbound email template — the content layer
`services/emailService.ts` (see `backend/services/README.md`) will
read from and send via Resend, once implemented. Full architecture
(provider choice, triggers, retry/failure handling, branding, and the
staged plan for admin-dashboard management) is documented in
`docs/email-architecture.md` — this README only establishes the
folder's own structure, matching the same "folder documents its
purpose, deeper reasoning lives in `docs/`" pattern already used by
every other `backend/` subfolder.

## Planned structure (no files exist yet)

```
emails/
  layouts/
    base.html          — shared header/footer/brand shell every template extends,
                          the email equivalent of partials/header.html + footer.html
  templates/
    newsletter-welcome.html
    consultation-acknowledgement.html
    contact-acknowledgement.html
    purchase-receipt.html
    secure-download.html
    admin-password-reset.html   (future — no password-reset flow is designed yet)
```

## Why a shared layout, not six independent templates

Every template needs the same logo, the same brand colors, and the
same footer contact details — writing that six times would drift out
of sync the same way any duplicated markup does. One `layouts/base.html`
holding that shell, with each `templates/*.html` file supplying only
its own subject and body content, mirrors this site's own established
shared-partial pattern rather than inventing a new one for email.

## Today

*(Updated in Version 1.2 Sprint 3.)* `layouts/base.html` and three
templates now exist — `newsletter-welcome.html`,
`consultation-acknowledgement.html`, and `contact-acknowledgement.html`
— matching the three endpoints implemented this sprint
(`services/emailService.ts`, `backend/services/README.md`). Each
template file is a body-content fragment plus two leading HTML
comments (`<!-- SUBJECT: ... -->`, `<!-- PREHEADER: ... -->`) that
`emailService.ts` parses out before substituting `{{placeholder}}`
values and injecting the result into `layouts/base.html`.

`admin-password-reset.html` remains unwritten — it belongs to a future
admin password-reset flow, not yet designed.

**No email has actually been sent** — `RESEND_API_KEY` in
`backend/.dev.vars.example` is still a placeholder; sending only
becomes real once a developer supplies a genuine Resend API key
locally (or `wrangler secret put` in a deployed environment).

*(Updated — Version 1.2 Sprint 2.5, Digital Fulfilment Platform.)*
`purchase-receipt.html` and `secure-download.html` are now written,
exactly matching this table's original plan — see
`docs/digital-fulfilment.md`'s "Email integration." Both are sent by
`services/fulfilmentService.ts` immediately after a purchase's
entitlement is granted, reusing `emailService.ts` exactly as every
other template already does — no new sending code path.
`secure-download.html`'s CTA links to the fulfilment page
(`checkout/callback/index.html`), never a direct file or token link,
per this sprint's security design.
