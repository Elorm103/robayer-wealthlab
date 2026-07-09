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

## Service

Matches `/services/` (the `.service-card` listing) and each
`/services/{slug}/` detail page, including that page's `Service`
JSON-LD block. See `content/services/README.md` for why this file
exists ahead of any page actually fetching it.

```json
{
  "slug": "financial-education",
  "title": "Financial Education",
  "summary": "Practical, one-on-one grounding in the personal-finance fundamentals — budgeting, saving, debt, and goal-setting.",
  "audience": "Students, young professionals, and anyone starting from zero.",
  "overview": "…",
  "whoItsFor": ["…"],
  "whatYoullLearn": ["…"],
  "process": [
    { "step": 1, "title": "Share your starting point", "description": "…" }
  ],
  "faq": [
    { "question": "…", "answer": "…" }
  ],
  "relatedServices": ["personal-financial-coaching", "investment-education"],
  "relatedCalculators": ["compound-interest", "savings-goal"],
  "relatedArticles": ["/blog/#budgeting-for-your-first-salary"],
  "relatedResources": ["/resources/"],
  "pricing": { "display": "Contact for pricing", "amount": null, "currency": "GHS" },
  "complianceNote": "Robayer WealthLab provides financial education, not licensed financial advice.",
  "ctaLabel": "Request a Consultation",
  "ctaHref": "/consultation/"
}
```

`relatedCalculators` holds calculator slugs (Compound Interest,
Savings Goal, and Investment Growth shipped in Version 1.1 Sprint 2 —
see the `Calculator` entry below). `ctaHref` points at `/consultation/`
— the Consultation Module shipped in Version 1.1 Sprint 3 (see its own
README and `CHANGELOG.md` for what it does and doesn't do yet: manual
review, no booking system, no calendar integration).

## Calculator

Matches `/calculators/` (the listing) and each `/calculators/{slug}/`
page's educational sections. See `content/calculators/README.md` for
why no formula appears here — formulas live in
`js/components/calculator-utils.js` and each calculator's own script.

```json
{
  "slug": "compound-interest",
  "title": "Compound Interest Calculator",
  "summary": "See how a lump sum plus regular contributions grows over time.",
  "category": "growth",
  "educationalExplanation": "…",
  "formulaExplanation": "…",
  "interpretationNotes": "…",
  "commonMistakes": ["…"],
  "faq": [
    { "question": "…", "answer": "…" }
  ],
  "relatedResources": ["/resources/#investment-readiness-checklist"],
  "relatedServices": ["financial-education", "investment-education"],
  "relatedArticles": ["/blog/what-are-treasury-bills-in-ghana/"],
  "complianceNote": "This calculator is educational — results are projections, not guarantees or investment advice.",
  "ctaLabel": "Request a Consultation",
  "ctaHref": "/consultation/"
}
```

## Goal Planner Config

Matches `/goal-planner/` (Version 1.1 Sprint 4) — the only content type
so far with a genuine, live `fetch()` consumer besides
`content/founder/bio.json`. See `content/goal-planner/README.md` for
why. `targetAmount`/`years` use a tiny closed set of structured
operations (`"direct"` or `"computed"` with `"multiply"`/`"subtract"`)
resolved by `js/components/goal-planner.js` — never a formula string or
`eval()`. The actual monthly-savings calculation always calls
`window.RobayerCalc.requiredContribution()`, the same function the
Savings Goal calculator uses.

```json
{
  "slug": "emergency-fund",
  "title": "Emergency Fund",
  "goalDescription": "…",
  "resultIntro": "…",
  "questions": [
    { "id": "monthlyExpenses", "label": "…", "type": "number", "unit": "GH₵", "min": 0, "step": 1, "default": 2000, "help": "…" },
    { "id": "monthsCoverage", "label": "…", "type": "select", "options": [3, 6, 9, 12], "default": 6 }
  ],
  "targetAmount": { "source": "computed", "operation": "multiply", "questionIds": ["monthlyExpenses", "monthsCoverage"] },
  "years": { "source": "direct", "questionId": "timeframeYears" },
  "currentSavingsQuestionId": "currentSavings",
  "rateQuestionId": "expectedRate",
  "relatedCalculators": ["savings-goal"],
  "relatedServices": ["financial-education"],
  "includeTreasuryBillArticle": true,
  "consultationCategory": "financial-education"
}
```

`relatedCalculators`/`relatedServices` are slug arrays only — titles
and hrefs are resolved by a small hardcoded lookup table in
`goal-planner.js`, matching the same pattern `consultation-form.js`
already uses for its category `<select>` rather than a second fetch.

## Investment Centre Topic

Matches `/investment-centre/` (the topic grid) and each
`/investment-centre/{slug}/` detail page, including that page's
`WebPage`/`FAQPage` JSON-LD. See `content/investment-centre/README.md`
for why this file exists ahead of any page actually fetching it.

```json
{
  "slug": "treasury-bills",
  "title": "Treasury Bills",
  "summary": "…",
  "category": "fixed-income",
  "difficulty": "beginner",
  "overview": "…",
  "whyItMatters": "…",
  "benefits": ["…"],
  "risks": ["…"],
  "whoItSuits": ["…"],
  "faq": [
    { "question": "…", "answer": "…" }
  ],
  "relatedCalculators": ["savings-goal"],
  "relatedGoals": ["emergency-fund", "first-investment"],
  "relatedServices": ["investment-education"],
  "relatedResources": ["/resources/#investment-readiness-checklist"],
  "relatedArticles": ["/blog/what-are-treasury-bills-in-ghana/"],
  "seo": {
    "title": "Treasury Bills in Ghana: An Educational Guide | Robayer WealthLab",
    "metaDescription": "…",
    "canonical": "https://robayerwealthlab.com/investment-centre/treasury-bills/"
  },
  "complianceNote": "…",
  "ctaLabel": "Request a Consultation",
  "ctaHref": "/consultation/"
}
```

`category` is one of `fixed-income`/`funds`/`equities`/`pension`/
`property`/`commodities`/`foundations`. `difficulty` is one of
`beginner`/`intermediate`/`advanced`, rendered as a `.badge` on both
the topic grid and the detail page's hero. `relatedGoals` is the first
schema to cross-link *into* the Goal Planner from a reading-content
page — it renders as `/goal-planner/?goal={slug}`, the same
query-param pattern the Learning Hub already established in Sprint 5.
`relatedArticles` and `relatedResources` are omitted (not forced)
where no genuine match exists — the same honesty standard applied to
every other content type on this site.

## Product

Matches a future `/store/{slug}/`-style detail page and storefront
grid (Version 1.2 Sprint 1, extended Sprint 2.1 — see
`content/products/README.md`, `docs/commerce-architecture.md`, and
`docs/product-platform-architecture.md`). **No product exists yet** —
this is schema and documentation only. `js/components/product-loader.js`
can render this shape once a real product and a storefront page both
exist; today `content/products/index.json` is a real, empty `[]`.

```json
{
  "id": "prod-starting-to-invest-with-gh100",
  "slug": "starting-to-invest-with-gh100",
  "title": "Starting to Invest with GH₵100",
  "subtitle": "A practical first guide to treasury bills, mobile money savings, and the Ghana Stock Exchange.",
  "shortDescription": "…",
  "description": "…",
  "topic": "investing",
  "productType": "ebook",
  "status": "draft",
  "price": 39,
  "currency": "GHS",
  "pricingModel": "one-time",
  "sku": "RWL-EBOOK-001",
  "coverImage": "/assets/covers/starting-to-invest-with-gh100.jpg",
  "thumbnail": "/assets/covers/starting-to-invest-with-gh100-thumb.jpg",
  "previewImage": "/assets/covers/starting-to-invest-with-gh100-preview.jpg",
  "gallery": [],
  "downloadFiles": [
    { "label": "eBook (PDF)", "path": "/assets/downloads/starting-to-invest-with-gh100.pdf", "format": "PDF" }
  ],
  "previewPages": [],
  "fileFormat": ["PDF"],
  "language": "en",
  "estimatedReadingTime": 25,
  "author": "Robert Loh Kobla",
  "version": "1.0",
  "publishedDate": null,
  "updatedDate": null,
  "featured": false,
  "bestseller": false,
  "newRelease": false,
  "tags": ["ebook", "investing", "beginners"],
  "seo": {
    "title": "…",
    "metaDescription": "…",
    "canonical": "https://robayerwealthlab.com/store/starting-to-invest-with-gh100/"
  },
  "paystack": {
    "metadata": { "productSlug": "starting-to-invest-with-gh100", "productType": "ebook" }
  },
  "downloads": { "maxPerPurchase": 5, "expiresAfterDays": 30 },
  "license": null,
  "relatedProducts": [],
  "relatedResources": [],
  "relatedServices": ["investment-education"]
}
```

Field-by-field rationale is in `content/products/README.md`. The
short version of what changed in Sprint 2.1, and why:

- **`category` split into `topic` + `productType`.** Sprint 1's single
  `category` field conflated two different questions: *what subject is
  this about* (Investing, Personal Finance, Budgeting, Business,
  Mindset — see `content/topics/`) and *what format is this* (eBook,
  PDF Guide, Template, Spreadsheet, Report, Checklist, Course — see
  `content/product-types/`, the renamed `content/categories/`). A
  storefront needs to filter by both independently (e.g., "Templates"
  grid showing items across every topic, or "Investing" showing every
  format) — one field couldn't do that. Safe to rename now since zero
  real product data exists to migrate.
- **`id` added**, separate from `slug`. A slug can reasonably change
  later (SEO, a typo fix); `id` is the stable internal identifier a
  future order/download-token record would reference, so renaming a
  product's URL never orphans its purchase history.
- **`downloadFile` (single path) became `downloadFiles` (array of
  `{ label, path, format }`).** Directly serves "multiple file
  downloads" (e.g., a template pack shipping both an `.xlsx` and a
  `.pdf` instructions sheet) — made the change now, at zero migration
  cost, rather than as a future breaking change.
- **`thumbnail` / `previewImage` added**, distinct from `coverImage`/
  `gallery`. `coverImage` is the one image a detail-page hero uses;
  `thumbnail` is a smaller/cropped variant for dense grid cards (so a
  future grid of dozens of products doesn't load full-size covers);
  `previewImage` is the one "here's a sample" image shown prominently
  before purchase, distinct from `gallery` (general product images) and
  `previewPages` (a multi-page sample array for a detail page).
- **`fileFormat`, `language`, `estimatedReadingTime` added** — metadata
  a storefront filter/detail page would show (PDF/ZIP/XLSX/DOCX/Video;
  defaults to `"en"`; nullable, mainly relevant to ebooks/guides).
- **`bestseller` / `newRelease` added**, alongside the existing
  `featured` — three independent badges a card can show
  simultaneously (a product can be both new *and* a bestseller),
  matching how `.badge` is already used elsewhere on the site.
- **`status` gains a 4th value, `"coming-soon"`** — matches the
  already-live `.book-card--upcoming` treatment on `/books/` (a real,
  existing pattern this schema now formally supports instead of a
  product having to fake `"draft"` for something that's intentionally
  publicly teased).
- **`pricingModel` added**, one value in use today (`"one-time"`). A
  single default-valued field costs nothing now and means a future
  subscription/membership product (see "Future Compatibility" in
  `content/products/README.md`) extends this enum rather than requiring
  a new field bolted on later.

`sku` is a short, human-assignable internal code (`RWL-` prefix +
product type + running number) — useful for support conversations and
Paystack transaction references, not a barcode system. `status` of
`"draft"` means a record can exist and be worked on without appearing
anywhere public; only `"active"` (and, for teased-but-unavailable
items, `"coming-soon"`) products would ever render on a future
storefront.

## Product Type

Matches `content/product-types/index.json` (renamed from Sprint 1's
`content/categories/`) — the taxonomy every `Product.productType`
field points to. See `content/product-types/README.md` for the full
list and why a separate small content type is used instead of a
hardcoded enum.

```json
{
  "slug": "ebook",
  "label": "eBooks",
  "description": "Digital books — read on any device after instant download."
}
```

## Topic

Matches `content/topics/index.json` (Sprint 2.1) — the subject-matter
taxonomy every `Product.topic` field points to, independent of
`productType`. See `content/topics/README.md`.

```json
{
  "slug": "investing",
  "label": "Investing",
  "description": "Treasury bills, the GSE, mutual funds, and other ways money grows over time."
}
```

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
