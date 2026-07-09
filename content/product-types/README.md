# Product Type Content

## Purpose

Holds the format/deliverable taxonomy every `content/products/{slug}.json`
record's `productType` field points to. Kept as its own small content
type — not a hardcoded enum inside the Product schema — so a future
type can be added (or a type's display name/description edited)
without touching every product that references it, matching the same
"one source of truth" reasoning already applied to `content/services/`
and `content/goal-planner/`.

*(Renamed in Sprint 2.1 from `content/categories/` — see
`content/SCHEMA.md`'s Product entry for why `category` split into
`topic` (subject matter, `content/topics/`) and `productType` (this
file). The 4 original entries are unchanged; this rename is purely a
folder/field name correction, done now because zero real product data
exists yet to migrate.)*

## Types

Seven types are defined now — the original 4 from Sprint 1, plus 3
added in Sprint 2.1 to cover the fuller range of digital products this
platform is meant to support (PDF guides, spreadsheets, and premium
reports, distinct from the more general ebook/template/checklist
buckets they'd otherwise have been forced into):

| Slug | Label | Matches |
|---|---|---|
| `ebook` | eBooks | Digital books, e.g. the existing "Starting to Invest with GH₵100" once it becomes a real `Product` record |
| `guide` | PDF Guides | Shorter, focused PDF guides — e.g. the free lead-magnet guide's *paid* equivalent, more narrowly scoped than a full eBook |
| `template` | Templates | Spreadsheets, worksheets, and planning documents you fill in yourself — a future paid tier alongside the free templates already on `/resources/` |
| `spreadsheet` | Spreadsheets | Structured, formula-driven workbooks — more involved than a fill-in template (e.g. a multi-tab budgeting or investment-projection tool) |
| `report` | Premium Reports | In-depth, research-backed writeups on a single topic — sold rather than free, distinct from the free `/blog/` articles |
| `checklist` | Checklists | Focused, single-purpose step-by-step guides — a future paid tier alongside the free checklists already on `/resources/` |
| `course` | Courses | Structured, multi-part educational content — none exist today |

No product currently references any of these — this file defines the
taxonomy ahead of the first real product, the same "schema before
data" approach used for every other content type in this project.

## File shape

- `content/product-types/index.json` — the 7 types above, as a real,
  complete array (not a placeholder).

See `content/SCHEMA.md` for the field-by-field schema (the
"Product Type" entry).

## Adding a type later

Adding an 8th type (e.g., `audio` for a future recorded talk) means
appending one object to `index.json` — no code change, since nothing
currently consumes this file (see `content/products/README.md` for
why: no storefront page exists yet).
