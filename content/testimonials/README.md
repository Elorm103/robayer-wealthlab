# Testimonials Content

## Purpose

Reader/subscriber testimonials — the CSS component (`.testimonial` in
`css/components.css`) is built and ready, but no testimonial content
currently appears anywhere on the live site. It was removed during
the Version 1.0 Brand & UX Review: three identical example quotes
("Ama", "Kwame", "Efua") had been hand-written into `index.html`,
`about/index.html`, and `community/index.html`, but no real customer
or reader had ever actually said them — Robayer WealthLab hasn't
processed a real transaction or collected real feedback yet. Inventing
quotes and attributing them to fictional people is a fabricated trust
signal, not a real one, so they were deleted rather than kept as
placeholders. See `docs/brand-ux-review-v1.md`'s Trust Review.

Do not re-add example/placeholder quotes to any page. This section
should stay empty until real testimonials exist to fill it.

## Future file structure

```
content/testimonials/
└── testimonials.json    Array of Testimonial objects
```

See `content/SCHEMA.md`'s Testimonial schema. One aggregate array file
— testimonials are numerous, lightweight, and different pages already
show different subsets/counts of them (a `featured` boolean, or a
`pages` array naming which page(s) a given testimonial should appear
on, are both reasonable ways to control that — pick one when this is
actually wired up).

## How future content should be added

1. Once real testimonials exist (a genuine customer quote, reader
   email, or review — never invented), append a new object to the
   array in `testimonials.json`.
2. A future content-loader-consuming version of each page that should
   show `.testimonial` cards would render its selection from this
   array instead of hand-written markup. Until then, no page should
   render a `.testimonial` card at all.

Note: `blog/what-are-treasury-bills-in-ghana/index.html` reuses the
`.testimonial__attribution`/`__avatar`/`__name`/`__context` classes
standalone for its real author byline (Robert Loh Kobla) — that's a
CSS-reuse pattern, not a testimonial, and is unaffected by this file.
