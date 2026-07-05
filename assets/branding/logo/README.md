# Logo

## Status: real production files in place (Phase 17)

- `logo-mark.png` — icon-only "RW" arrow mark, cropped from the
  production artwork. Live-wired into `partials/header.html` and
  `partials/footer.html`'s `.nav__logo-mark`, replacing the old coded
  gold-bars approximation.
- `logo.png` — full lockup (mark + "ROBAYER WEALTHLAB" wordmark, no
  tagline). Live-wired into every page's `Organization` JSON-LD `logo`
  field and `assets/config/site.json`'s `branding.logo`.
- `logo-with-tagline.png` — full lockup including the "Where small
  money builds big futures." tagline line. Not directly referenced by
  any page; kept as the source used to compose
  `assets/branding/social/og-image.jpg`, and available for any future
  large-format context that wants the tagline included.

All three were cropped from one production PNG (transparent background,
confirmed via pixel-alpha inspection before use) supplied for this
phase — no vector (`.svg`) source was provided, so there is currently no
`logo.svg`/`logo-mark.svg` in this folder despite earlier documentation
recommending one. If a vector source becomes available later, adding
`logo.svg`/`logo-mark.svg` here and swapping the `<img>` `src` values in
the two partials (plus the JSON-LD `logo` field) is a straightforward,
small swap — nothing else about the architecture needs to change.

## Expected filenames

- `logo-mark.png` (in place) — icon-only mark, transparent PNG.
- `logo.png` (in place) — full mark + wordmark lockup, transparent PNG.
- `logo-with-tagline.png` (in place) — full lockup with tagline, source
  for the OG image composition.
- `logo.svg` / `logo-mark.svg` — not yet available; see above.
- `logo-monochrome.svg` — single-color variant (e.g. all-white or
  all-navy) for placement on busy or unpredictable backgrounds. Not
  yet produced.

## Recommended dimensions

The in-place PNGs were cropped tightly to their visible content (no
padding beyond a small margin) — `logo-mark.png` is roughly 415×355px,
`logo.png` roughly 975×355px. If a vector source arrives later, set its
`viewBox` to match these proportions so it drops in as a same-size
swap.

## Recommended formats

PNG with a transparent background works today (confirmed via
pixel-alpha inspection, not assumed) and renders correctly on every
current background color the site uses (Warm Paper, white cards,
Ink Navy dark sections). SVG remains preferable long-term for crisp
scaling at arbitrary sizes — see the status note above.

## Recommended optimization

The in-place PNGs were cropped from the source but not additionally
recompressed — run them through `pngquant`/`oxipng` if file size
becomes a concern; at their current cropped size they're well within
normal page-weight budgets. If/when an SVG source arrives, run it
through [SVGO](https://github.com/svg/svgo) before committing.

## Fallback behavior

No longer applicable for `logo-mark.png`/`logo.png` — both are live,
real assets referenced by the header/footer partials and every page's
JSON-LD. The only remaining "placeholder" aspect is the absence of a
vector source, which doesn't affect how the site looks or functions
today.
