# Founder Portrait

## Status: real photo in place (Phase 17)

`founder-portrait.jpg` is Robert Loh Kobla's real professional
headshot, cropped to 4:5 from the original supplied photo (a 4:3
source, center-cropped and visually verified before use). Live-wired
into all three current founder-image slots:

- `index.html`'s hero (above the fold)
- `index.html`'s "Meet the Founder" section (below the fold)
- `about/index.html`'s hero (above the fold)

Every `<img>` tag includes a descriptive `alt`, explicit `width`/`height`
matching the file's real dimensions (648×810), and `loading` set
per-instance: `eager` on the two above-the-fold hero placements,
`lazy` on the below-the-fold "Meet the Founder" placement.

## Expected filenames

- `founder-portrait.jpg` (in place) — Robert Loh Kobla's professional
  portrait, 648×810px (4:5), 46KB.
- `founder-portrait@2x.jpg` — optional, double-resolution version for
  high-DPI screens, same crop. Not yet produced (46KB at 1x is already
  small enough that a 2x variant isn't a pressing need).

## Recommended dimensions

At least 800×1000px (4:5 aspect ratio) for any future replacement —
the in-place file is 648×810, slightly under that recommendation but
sharp enough at its actual display size (roughly 300–400px wide). All
three slots share the same `.rounded-lg.aspect-4-5.img-cover` class
combination, so a same-ratio replacement drops in without any markup
changes.

## Recommended formats

JPG or WebP. WebP gives a meaningfully smaller file at equivalent
visual quality if the workflow producing the photo can export it;
JPG is the safe universal fallback.

## Recommended optimization

Compress to well under 200KB without visible quality loss — a portrait
photo doesn't need to be pixel-perfect at 100% zoom, it needs to look
sharp at the display size it's actually shown at (roughly 300–400px
wide in the current layout). Tools like Squoosh or `mozjpeg` handle
this well.

## Fallback behavior

No longer applicable — all three slots show the real photo. To replace
it with a future portrait, keeping the same filename
(`founder-portrait.jpg`) and 4:5 ratio means no HTML changes are
needed anywhere; only the file itself changes.
