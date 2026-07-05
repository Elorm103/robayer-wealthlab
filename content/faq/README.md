# FAQ Content

## Purpose

Per-page FAQ question/answer sets — currently hand-written twice on
every page that has one: once as a visible `<details>`/`<summary>`
accordion (`.faq__item`), and again as a matching `FAQPage` JSON-LD
`<script>` block in that same page's `<head>`. Pages with an FAQ today:
About, Contact, Blog index, Books index, Resources, Community,
Newsletter, and the Blog Article template. Centralizing each page's Q&A
list means writing it once and generating both the visible accordion
and the JSON-LD from the same data, instead of keeping two hand-written
copies in sync by hand.

## Future file structure

```
content/faq/
├── about.json
├── contact.json
├── blog-index.json
├── books-index.json
├── resources.json
├── community.json
├── newsletter.json
└── blog-article-template.json
```

One file per page (FAQs are page-scoped content, not a shared global
list), each an array matching `content/SCHEMA.md`'s FAQ schema:

```json
[
  { "question": "…", "answer": "…" }
]
```

## How future content should be added

1. Add/edit an entry in the relevant page's file.
2. A future content-loader-consuming version of that page would render
   both its visible `.faq` accordion and its `FAQPage` JSON-LD block
   from the same array — guaranteeing they can't drift out of sync,
   which is a real risk today since they're two independent
   hand-written copies. Not wired up yet; both copies remain
   hand-written and must be kept in sync manually for now, exactly as
   before this phase.
