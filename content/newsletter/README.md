# Newsletter Content

## Purpose

An archive of past newsletter issues. `newsletter/index.html` already
has a "Recent issues" preview section (reusing `.blog-card`) with 3
sample entries — its own HTML comment already notes it was "designed so
future real issues can drop straight in." This directory is where that
future archive's real data would live once real issues exist to
reference.

## Future file structure

```
content/newsletter/
└── issues.json    Array of Newsletter Issue objects, newest first
```

See `content/SCHEMA.md`'s Newsletter Issue schema. One aggregate array
file, matching the Resources/Testimonials pattern — issues are
numerous and each one is a small amount of metadata (a title, date,
summary, and a link to wherever the full issue is archived/sent from).

## How future content should be added

1. Prepend a new object to the array in `issues.json` (newest first)
   each time an issue goes out.
2. A future content-loader-consuming version of the "Recent issues"
   section would render its `.blog-card` entries from this array
   instead of the current 3 hand-written sample cards — not the case
   yet.
