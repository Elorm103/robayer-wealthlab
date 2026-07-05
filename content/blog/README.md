# Blog Content

## Purpose

One structured metadata file per article — title, excerpt, author,
dates, category, tags, and cover image, mirroring the facts currently
hand-written into `blog/index.html`'s listing and each article's own
page (today just `blog/what-are-treasury-bills-in-ghana/index.html`).
The article *body* (the long-form prose) is intentionally **not**
proposed to move into JSON here — see the note below.

## Future file structure

```
content/blog/
└── {article-slug}.json    e.g. what-are-treasury-bills-in-ghana.json
```

See `content/SCHEMA.md`'s Blog Article schema for the exact field list.
Note that the schema's `body` field is a *reference* (e.g. a path to an
HTML/Markdown file, or simply left absent) rather than the full article
text inlined into JSON — long-form prose with inline formatting,
pull-quotes, and callouts reads and edits far more naturally as its own
document than as an escaped JSON string. This directory centralizes the
metadata that repeats across listing cards and the article page's own
`<head>` (title, description, JSON-LD `Article` fields); it doesn't
try to replace the article-writing process itself.

## How future content should be added

1. Create a new `{slug}.json` file here with the article's metadata.
2. Write the article body the same way it's written today (its own
   HTML page, using the established Blog Article template structure —
   see `README.md`'s note on `blog/what-are-treasury-bills-in-ghana/`
   being the canonical template).
3. A future content-loader-consuming `blog/index.html` would read every
   file in this directory to build its listing grid, pulling
   title/excerpt/date/category from here rather than duplicating them
   in the listing markup — not the case yet.
