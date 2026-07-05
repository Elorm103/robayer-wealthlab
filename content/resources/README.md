# Resources Content

## Purpose

Structured data for the free resource library — the templates,
calculators, and guides currently hand-written as `.resource-card`
entries in `resources/index.html` (and previewed on the homepage).

## Future file structure

```
content/resources/
└── resources.json    Array of Resource objects, one per card
```

Unlike Books or Blog Articles, resources are numerous and lightweight
(a title, a format badge, a short description, a download/detail link)
— one aggregate array file is the better fit here rather than one file
per resource, since there's rarely enough unique content per resource
to justify a separate file. See `content/SCHEMA.md`'s Resource schema
for the exact field list, matching the `data-category`/`data-title`
attributes the existing filter system (`js/components/content-filters.js`)
already reads.

## How future content should be added

1. Append a new object to the array in `resources.json`, matching the
   Resource schema — include the `category` field exactly as the
   existing filter pills expect (e.g. `"budgeting"`, `"investing"`).
2. Add any matching thumbnail to `assets/branding/resources/` if the
   resource gets a dedicated image (most don't — see that folder's
   README; the existing category-icon pattern is the default).
3. A future content-loader-consuming `resources/index.html` would
   render its grid from this array instead of hand-written cards, and
   the existing `content-filters.js` would keep working unchanged since
   it filters on `data-category`/`data-title` attributes regardless of
   how the markup was generated — not the case yet.
