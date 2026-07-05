# Content Model — Recommended Schemas

Documentation only — no page reads any of these shapes today, and no
sample files exist anywhere in `content/`. Each schema below is designed
to match how the corresponding content already looks and behaves on the
live site, so that wiring a future page up to read from it would be a
rendering change, not a content redesign.

Conventions used throughout: `slug` fields match the content's URL
route segment where one exists; dates are `YYYY-MM-DD` (matching every
date already on the site, e.g. `sitemap.xml`'s `<lastmod>` and the Blog
Article's `datePublished`); every schema is intentionally flat/shallow
— nested structure only where the current UI already has nested
structure (e.g. a book's chapter list).

## Book

Matches `books/starting-to-invest-with-gh100/index.html` and its
`books/index.html` listing card.

```json
{
  "slug": "starting-to-invest-with-gh100",
  "title": "Starting to Invest with GH₵100",
  "subtitle": "A practical first guide to treasury bills, mobile money savings, and the Ghana Stock Exchange.",
  "price": 39,
  "currency": "GHS",
  "coverImage": "/assets/branding/books/starting-to-invest-with-gh100.jpg",
  "category": "investing",
  "featured": true,
  "description": "…",
  "chapters": [
    { "title": "…", "summary": "…" }
  ],
  "purchaseUrl": "#",
  "publishedDate": "2026-06-01"
}
```

## Blog Article

Matches `blog/what-are-treasury-bills-in-ghana/index.html` and its
`blog/index.html` listing card, and the page's `Article` JSON-LD.

```json
{
  "slug": "what-are-treasury-bills-in-ghana",
  "title": "What Are Treasury Bills in Ghana?",
  "excerpt": "A plain-language look at what treasury bills are, how they work, and why they're often a Ghanaian's first investment.",
  "category": "investing",
  "tags": ["treasury-bills", "beginners"],
  "coverImage": null,
  "author": "Robert Loh Kobla",
  "publishedDate": "2026-06-27",
  "modifiedDate": "2026-07-01",
  "readingTimeMinutes": 6,
  "body": "blog/what-are-treasury-bills-in-ghana/index.html",
  "faq": [
    { "question": "…", "answer": "…" }
  ]
}
```

`body` is a reference (today, the article's own page path), not the
full article text — see `content/blog/README.md` for why.
`coverImage` is `null` today since no Blog Article currently has one
(the template doesn't use a cover-image slot yet).

## Resource

Matches `.resource-card` entries in `resources/index.html`.

```json
{
  "id": "budget-planner",
  "title": "Budget Planner",
  "description": "A simple monthly budget template built for irregular income.",
  "category": "budgeting",
  "format": "Template",
  "icon": "budget",
  "status": "available",
  "actionUrl": "#",
  "actionLabel": "Download — Free"
}
```

`category` matches the existing filter-pill values `js/components/content-filters.js`
already filters on. `format` matches the existing badge values
(Template/Calculator/Guide). `status` of `"upcoming"` matches the
existing `.resource-card--upcoming` dashed-border treatment.

## Team Member

No team page exists yet — this schema generalizes the founder's shape
so a future team roster (`content/company/team.json`) can include the
founder plus future hires without a schema change later.

```json
{
  "slug": "robert-loh-kobla",
  "name": "Robert Loh Kobla",
  "title": "Founder & CEO",
  "photo": "/assets/branding/team/robert-loh-kobla.jpg",
  "bio": "…",
  "email": null,
  "social": { "linkedin": null, "twitter": null }
}
```

## Testimonial

Matches `.testimonial` entries repeated across `index.html`,
`about/index.html`, the Blog Article template, and `community/index.html`.

```json
{
  "id": "ama-treasury-bills",
  "quote": "I finally understood treasury bills after years of being too embarrassed to ask.",
  "name": "Ama",
  "context": "eBook reader, Accra",
  "avatarInitial": "A",
  "featured": true
}
```

`avatarInitial` matches the current `.testimonial__avatar` circle,
which shows a single letter rather than a photo (see
`assets/branding/team/README.md` for the same "initials until a real
photo exists" convention).

## FAQ

Matches each page's `.faq__item` accordion entries and matching
`FAQPage` JSON-LD `Question`/`Answer` pairs — one array per page (see
`content/faq/README.md` for the per-page file list).

```json
{
  "question": "How quickly do you reply?",
  "answer": "We normally reply within 2–3 business days — sometimes a little longer during a busy stretch."
}
```

Deliberately minimal — the visible accordion and the JSON-LD block both
need only these two fields today.

## Newsletter Issue

Matches the 3 sample `.blog-card` entries in `newsletter/index.html`'s
"Recent issues" preview section (that section's own HTML comment
already anticipates this: "designed so future real issues can drop
straight in").

```json
{
  "issueNumber": 1,
  "title": "…",
  "publishedDate": "2026-07-01",
  "summary": "…",
  "archiveUrl": "#"
}
```

## Community Event

No event calendar exists on the site yet — this is new content, not a
migration of anything currently hand-written.

```json
{
  "slug": "ask-me-anything-july-2026",
  "title": "…",
  "type": "webinar",
  "date": "2026-07-20",
  "description": "…",
  "registrationUrl": "#",
  "status": "upcoming"
}
```

`type` is a free-form string today (`"webinar"`, `"meetup"`, etc.) —
worth constraining to an enum once real event types exist and the
pattern is clearer than it is with zero events to generalize from.
