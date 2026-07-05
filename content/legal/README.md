# Legal Content

## Purpose

Section-by-section content for the three Legal pages (Privacy Policy,
Terms of Use, Disclaimer), currently hand-written directly into
`legal/privacy-policy/index.html`, `legal/terms-of-use/index.html`, and
`legal/disclaimer/index.html`. All three already share the same
`.article-layout` + `.article-body` + sticky-TOC shell — this directory
would let that shared shell be driven by data instead of three
near-identical hand-written pages, without changing what any of them
say.

## Future file structure

```
content/legal/
├── privacy-policy.json
├── terms-of-use.json
└── disclaimer.json
```

Each shaped as:

```json
{
  "effectiveDate": "2026-07-04",
  "lastUpdated": "2026-07-04",
  "sections": [
    { "id": "educational-purpose", "heading": "Educational purpose", "body": "…" }
  ]
}
```

`sections` maps directly to the existing TOC pattern each Legal page
already uses (`.toc__item` per section, `id` matching the in-page
anchor).

## How future content should be added

1. Edit the relevant section's `body` (or add a new section object) in
   the matching JSON file.
2. A future content-loader-consuming version of these three pages would
   render both the TOC and the article body from `sections`, keeping
   them in sync automatically (today, adding a section means manually
   adding both a `.toc__item` and its matching `<h2>` — easy to get out
   of sync, which this would remove) — not the case yet.

Legal content changes should still get the same care as today
regardless of how it's stored — this is a maintainability change, not
a review-process change.
