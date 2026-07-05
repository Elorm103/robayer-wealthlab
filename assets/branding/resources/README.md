# Resource Thumbnails

No resource thumbnail images exist yet, and none are strictly needed —
every resource card today (`resources/index.html` and the homepage
preview) uses a small line-art `<svg class="resource-card__icon">`
matched to its category (template/calculator/guide), not a photo. That
icon-based pattern works fine at the current card size and is the
recommended default for any *new* resource too — this folder exists for
a possible future where a resource wants a distinctive thumbnail image
instead of (or alongside) its category icon.

## Expected filenames

One file per resource, named after its existing `id`/`data-title`
attribute already used in `resources/index.html`'s markup (e.g. the
budget planner resource is `id="budget-planner"` today) — so a future
thumbnail would be `budget-planner.svg` or `.png` here.

## Recommended dimensions

Square, at least 200×200px, if used as a card thumbnail alongside or
instead of the current icon — matches the visual weight of
`.resource-card__icon` at `icon--lg` scale without looking
disproportionate in the existing `.resource-card` layout.

## Recommended formats

SVG for anything icon-like or vector (consistent with the current
in-card icon style), PNG/WebP if a photographed or textured thumbnail
is ever wanted instead.

## Recommended optimization

SVGO for SVGs; keep raster thumbnails under 50KB — these are small,
supporting visual elements in a card grid, not hero imagery.

## Fallback behavior

The current inline `<svg class="resource-card__icon icon">` per card
stays exactly as-is until/unless a specific resource gets a dedicated
thumbnail. Swapping one in is a single-card markup change (replace the
inline `<svg>` with an `<img>` pointing here), not a sitewide change,
since resources are visually differentiated by category already. See
`content/resources/README.md` and `content/SCHEMA.md`'s Resource schema
for how a future structured content file's `icon`/`thumbnail` field
would reference a path here.
