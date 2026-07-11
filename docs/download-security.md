# Download Security — Research & Recommendations (Phase 6)

**Status: research and planning — now implemented, see "Summary"
below.** Written originally as documentation only; Version 1.2 Sprint
2.5 (Digital Fulfilment Platform) implements the mechanism this
document specifies. See `docs/digital-fulfilment.md` for the live
architecture.

## The core constraint: GitHub Pages cannot gate anything

GitHub Pages serves static files only — there is no server-side code
that can run at request time to check "did this visitor actually pay?"
before deciding whether to return a file. Any file placed at a public
URL under this site is downloadable by anyone who has (or guesses,
or shares) that URL, forever, regardless of what the JSON content says
about `price` or `status`. This is the single most important fact this
document has to establish before anything else: **the download
mechanism cannot live entirely inside this repository.** It needs one
small piece of infrastructure outside GitHub Pages.

This doesn't conflict with "preserve GitHub Pages compatibility" — the
site itself (every page, every piece of content) keeps working exactly
as it does today, fully static. Only the *actual file transfer* for a
paid product needs to happen through something else, the same way
Paystack's own checkout already has to happen through something else
(GitHub Pages can't process a card payment either).

## Recommended approach: signed, time-limited URLs

The industry-standard pattern for this problem — used by Gumroad,
SendOwl, and similar digital-product sellers — is:

1. A buyer completes payment through Paystack.
2. A small serverless function (see `docs/paystack-integration.md` for
   *where* this runs) verifies the transaction directly with Paystack's
   API (never trusting the client-side redirect alone — see
   "Payment verification" below).
3. Once verified, that function generates a **signed URL**: a link to
   the real file (stored in cloud object storage — e.g., Cloudflare R2,
   AWS S3, or Backblaze B2, not this GitHub Pages repository) with a
   cryptographic signature and a short expiry (commonly 15 minutes to
   24 hours) baked into the URL itself. Anyone with the link can
   download the file **only until it expires** — no server lookup is
   needed to check validity, the expiry is mathematically part of the
   URL.
4. That signed URL is what gets shown/emailed to the buyer — never the
   permanent path from `content/products/{slug}.json`'s `downloadFiles`
   array. Those paths are the *source location* the signing function
   reads from, not something ever exposed to a browser directly (see
   `assets/products/README.md`).

## Why not just a "secret" long-lived URL?

An obscure-but-permanent URL ("security through obscurity") is a common
shortcut and a common mistake: once shared once — forwarded, posted,
indexed by a crawler that followed a stray link — it's permanently
compromised, and there's no way to revoke it without breaking it for
the legitimate buyer too. A signed URL's expiry means a leaked link
has a small, bounded window of exposure, and a new one can always be
re-issued to the real buyer without touching anything else.

## Download limits

`content/products/{slug}.json` already reserves two fields for this
(see `content/SCHEMA.md`'s `Product` entry): `downloads.maxPerPurchase`
and `downloads.expiresAfterDays`. These are *policy*, enforced by
whatever future service tracks issued downloads per transaction
reference:

- **`maxPerPurchase`** — how many times a signed URL may be
  (re)issued for one transaction, e.g. 5. This protects against one
  purchase being turned into unlimited redistribution while still
  tolerating a buyer who lost their first download or needs it on a
  second device.
- **`expiresAfterDays`** — how long after purchase a buyer can still
  request a (re-)download at all, e.g. 30 days. After that, a buyer
  would need to contact support — a deliberate small amount of
  friction that discourages treating "buy once, redownload forever, no
  questions asked" as the default.

Both numbers are business decisions, not security requirements — they
should be generous enough that a legitimate buyer never feels
penalized. They exist to bound *reissuance*, not to punish the
one-time act of downloading a purchased file.

## Payment verification — never trust the redirect alone

Paystack's checkout redirects a browser back to a "callback URL" after
payment, but **a callback redirect is not proof of payment** — it's
trivial for someone to hit that URL directly with a fabricated
reference, or for a payment to fail after redirect but before webhook
delivery. Correct verification always requires the server-side step of
calling Paystack's own "Verify Transaction" endpoint with the
transaction reference and checking that the response confirms
`status: success` for the expected amount, currency, and reference —
never granting a download because a browser simply *arrived* at a
success-looking page. This is expanded fully in
`docs/paystack-integration.md`.

## Email delivery — the resilient default, not just a convenience

Rather than showing the signed download link only on a "thank you"
page (which a buyer might close, lose, or never see if their browser
crashes mid-checkout), the recommended flow **always** emails the
signed link to the address used at checkout, in addition to showing it
on-page. This means:

- A buyer who closes the tab immediately after paying isn't stuck.
- There's a durable, buyer-owned record of the purchase and link,
  independent of this site's own state.
- Re-sending a fresh signed link later (e.g., because the first one
  expired) is a simple "resend my download" action tied to an email
  address and a transaction reference — no account/password system
  required (see `docs/admin-module.md`'s note on why this project
  doesn't need customer logins to support this).

## Anti-sharing considerations

No approach makes a downloaded file un-shareable once it's on someone's
device — that's true of every digital product ever sold, not a gap
specific to this project. The realistic goal is raising the cost of
casual sharing, not achieving perfect prevention:

- **Signed URL expiry + limited reissuance** (above) bounds how long
  and how often a leaked link is useful.
- **PDF watermarking** (e.g., stamping the buyer's email or transaction
  reference unobtrusively into the footer of each page) is a common,
  low-friction deterrent for ebooks/templates — worth considering per
  product type once real files exist, not a blanket requirement today.
- **No DRM.** Locking PDFs with restrictive DRM tends to punish
  legitimate buyers (broken on some devices/readers) far more than it
  stops determined re-sharing, and contradicts this project's honesty-
  and-simplicity posture. Not recommended.
- **Rate limiting** on the signing function itself (e.g., a cap on
  signed-URL requests per transaction reference per hour) protects
  against automated abuse of the reissuance mechanism, separate from
  the `maxPerPurchase` business policy above.

## Summary: what Sprint 2 (or whichever sprint implements this) needs to build

**Implemented — Version 1.2 Sprint 2.5 (Digital Fulfilment Platform).**
See `docs/digital-fulfilment.md` for the full architecture. All four
items below are built exactly as this document specified:

1. One serverless function: **verify Paystack transaction → check
   `downloads` policy for this reference → issue a signed URL from
   object storage → log the issuance.** Realized as
   `backend/services/entitlementService.ts` (checks the policy,
   snapshotted onto `deliveries` at fulfilment time) +
   `backend/routes/downloads.ts` (the "signed URL" — Worker-mediated,
   per `docs/storage-strategy.md`'s Option B, not a literal presigned
   URL — see that document's "Today" section).
2. Cloud object storage (outside this repository) holding the real
   product files, replacing `assets/products/` as the *live* source
   once real selling begins (`assets/products/` remains the authoring/
   staging location — see that folder's README). The R2 binding and
   bucket-key convention (`storageKey`) are wired up; no real bucket
   or real objects exist yet.
3. Email delivery wired to the same verified-payment step. Realized as
   `backend/services/fulfilmentService.ts`, reusing
   `backend/services/emailService.ts`.
4. None of this requires GitHub Pages to do anything it can't already
   do — the static site still only ever links to a URL, generated
   elsewhere, at request time.

~~This document does not choose a specific storage provider or
serverless platform~~ — **resolved in Version 1.2 Sprint 2:** Cloudflare
R2 (storage) and Cloudflare Workers (compute), matching the Paystack
verification step's own resolved hosting choice. See
`docs/cloudflare-architecture.md` and `docs/storage-strategy.md` for
the full design, including the concrete signed-download mechanism this
document only specified in principle.
