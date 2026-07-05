# Books Content

## Purpose

One structured file per book — title, price, description, cover-image
path, purchase link, and the other facts currently hand-written into
`books/index.html`'s listing and each book's own detail page (today
just `books/starting-to-invest-with-gh100/index.html`).

## Future file structure

```
content/books/
└── {book-slug}.json    e.g. starting-to-invest-with-gh100.json
```

One file per book, named after its URL slug — the same slug used in
its route (`/books/{slug}/`) and in its cover image filename (see
`assets/branding/books/README.md`). See `content/SCHEMA.md`'s Book
schema for the exact field list.

## How future content should be added

1. Create a new `{slug}.json` file here matching the Book schema.
2. Add the matching cover image to `assets/branding/books/{slug}.{jpg,webp}`.
3. A future content-loader-consuming version of `books/index.html`
   would read every file in this directory to build its listing grid,
   and the book's own detail page (`books/{slug}/index.html`) would
   read its one matching file — not the case yet; today, adding a book
   still means writing its detail page and adding a listing card by
   hand, exactly as the current single book was built.
