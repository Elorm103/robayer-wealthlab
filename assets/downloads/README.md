# Download Delivery

## Purpose

This folder is reserved for a future signed/temporary-URL download
mechanism (see `docs/download-security.md`) for **paid** products —
those should never end up here as permanent public files. The one
exception is free resources (see below), which is why this folder is
no longer empty.

## Why this folder exists but stays empty

`assets/products/` (see that folder's README) holds each product's
master source file. This folder is a placeholder for whatever a future
download-delivery implementation actually needs at request time —
which, per `docs/download-security.md`'s recommendation, is likely
*not* static files sitting in a public `assets/` path at all (GitHub
Pages cannot run server-side code to generate a signed URL or enforce
a download limit). This folder is kept in the repository now, with
this README as its only content, so:

- The distinction between "source file" (`assets/products/`) and
  "delivered download" (here, or wherever the real mechanism ends up
  living) is established in the architecture from day one.
- A future implementer isn't left guessing whether one folder was
  meant to serve both purposes.

## What NOT to do here, ever

Do not place a real, purchasable product file directly in this folder
and link to it with a plain `<a href>` — that is a permanent,
unauthenticated public URL with no purchase check, exactly what
`docs/download-security.md` documents as the wrong approach for a
paid product. Free resources (see `content/products/README.md`'s note
on `price: 0` products) are the one legitimate exception, since
there's nothing to protect — those may eventually link here directly.

## Today

*(Updated — Lead Magnet Phase 1, see `docs/lead-magnet-architecture.md`.)*
`7-money-mistakes-ghana.pdf` lives here — the free lead-magnet guide,
the one legitimate `price: 0` exception noted above. It is **not
currently linked from any public page** — `/free-guide/`'s signup form
intentionally doesn't expose a direct download link (see
`docs/lead-magnet-architecture.md`'s "Why the PDF isn't linked from the
page yet"). No paid product file has ever been placed here, and none
should be until the real signed-URL mechanism this folder was
originally reserved for is actually built.
