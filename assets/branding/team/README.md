# Team Photos

No team beyond the founder exists on the site today, and no team-member
photos exist yet. This folder is reserved for a future where Robayer
WealthLab grows beyond a single-founder operation and adds real team
member profiles (see `content/company/README.md` and `content/SCHEMA.md`'s
Team Member schema for the structured-data side of this).

## Expected filenames

One file per team member, named after their slug (lowercase, hyphenated
version of their name — matching the convention any future
`content/company/team/{slug}.json` file would use): e.g.
`jane-doe.jpg`.

## Recommended dimensions

Square, at least 400×400px. A square crop is the most flexible for
circular-avatar treatments (matching the existing
`.testimonial__avatar` circular-avatar visual language already used
elsewhere on the site) as well as rectangular card layouts.

## Recommended formats

JPG or WebP.

## Recommended optimization

Under 150KB per photo — same reasoning as the founder portrait, these
render at a small, fixed display size, not full-bleed.

## Fallback behavior

There is no team-member UI on the site yet at all — no cards, no
grid, nothing to fall back from. If/when a Team section is built, the
existing `.testimonial__avatar` pattern (a colored circle with the
person's initial, used today for testimonial authors who don't have a
photo) is the established sitewide precedent for "no photo yet" —
reuse it rather than inventing a new placeholder style, consistent with
`css/components.css`'s existing component library.
