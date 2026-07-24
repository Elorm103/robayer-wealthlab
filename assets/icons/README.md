Favicon files referenced in every page's `<head>`:
favicon.svg, favicon-32.png, apple-touch-icon.png.

Status: real production assets as of the Version 3.0 launch-stabilization
pass, generated directly from the real logo mark
(assets/branding/logo/logo-mark.png) via `sharp` — replacing the earlier
coded three-bar "step chart" placeholder that predated the current R-W
monogram logo and had been left in place since the Sprint 1.5 cleanup.

- `favicon-32.png` — 32x32, transparent background, logo contained with
  a small margin.
- `apple-touch-icon.png` — 180x180, solid warm-paper (`#FAF6EF`)
  background (Apple has historically rendered transparency as black on
  some iOS versions, so a solid fill is the safer choice), logo centered.
- `favicon.svg` — no vector source exists for the logo (see
  assets/branding/logo/README.md), so this is the same real logo mark
  rasterized at 96x96 and embedded as a base64 PNG inside a minimal SVG
  wrapper: pixel-accurate to the real brand, not a hand-traced vector,
  but no longer the obsolete placeholder shape either. If a true vector
  logo source becomes available later, this can be swapped for a real
  traced `<path>` version.

Regenerate all three from `assets/branding/logo/logo-mark.png` if the
logo mark itself is ever replaced — see the script pattern used to
produce these (crop/pad to a square, `sharp` resize + composite).
