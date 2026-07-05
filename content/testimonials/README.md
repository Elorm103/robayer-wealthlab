# Testimonials Content

## Purpose

Reader/subscriber testimonials — currently hand-written `.testimonial`
entries repeated (with the same 3 example quotes) across `index.html`,
`about/index.html`, the Blog Article template, and `community/index.html`.
Centralizing them means writing (and updating) a quote once instead of
in every page that happens to show it.

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

1. Append a new object to the array in `testimonials.json`.
2. A future content-loader-consuming version of each page currently
   showing `.testimonial` cards would render its selection from this
   array instead of hand-written markup — not the case yet; the same 3
   example testimonials remain hand-written in each of the 4 pages that
   use them today.
