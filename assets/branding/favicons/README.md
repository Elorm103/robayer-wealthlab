# Favicons

## Expected filenames

- `favicon.svg` — vector favicon, used by browsers that support it
  (most modern ones).
- `favicon-32.png` — 32×32px PNG fallback for browsers that don't.
- `favicon-16.png` — optional, 16×16px, for older browser tab
  rendering at very small sizes (not currently linked from any page —
  add the `<link rel="icon" sizes="16x16">` tag if you introduce it).
- `apple-touch-icon.png` — 180×180px PNG, used as the icon when a page
  is added to an iOS home screen.

## Recommended dimensions

Exactly 32×32, 16×16, and 180×180 for the three PNGs above — browsers
and iOS use these at native size, so anything off-spec gets scaled
(softening the result) or ignored.

## Recommended formats

SVG for the primary mark (scales cleanly to any size a browser tab
needs), PNG for the fixed-size fallbacks — PNG's lossless compression
matters more than usual here since these render at a handful of pixels
and any artifacting is immediately visible.

## Recommended optimization

SVGO for `favicon.svg`. `pngquant`/`oxipng` for the PNGs — favicon PNGs
compress extremely well since they're small, low-color-count images;
there's no reason any of these three files should be more than a few
KB each.

## Fallback behavior

`assets/icons/favicon.svg`, `assets/icons/favicon-32.png`, and
`assets/icons/apple-touch-icon.png` are currently coded placeholder
approximations of the approved Sika step-mark, already linked from
every page's `<head>` and functioning correctly (no 404s, no broken
tab icon) — see `assets/icons/README.md`. When real files replace them:

1. Drop the new files in here (`assets/branding/favicons/`).
2. Update the three `<link>` tags in every page's `<head>` to point at
   the new path — identical across all pages today, so it's a
   find-and-replace of `/assets/icons/favicon...` →
   `/assets/branding/favicons/favicon...`.
3. Update `assets/config/site.json`'s `branding.faviconSvg` /
   `favicon32` / `appleTouchIcon` to match (documentation only — these
   fields aren't live-wired into the `<head>` tags, see the top-level
   `assets/branding/README.md` for why).
