# Product Topic Content

## Purpose

Holds the subject-matter taxonomy every `content/products/{slug}.json`
record's `topic` field points to — independent of `productType`
(`content/product-types/`), which describes the *format* instead. A
storefront needs to filter by both independently (e.g., "show every
Template" across all topics, or "show everything about Investing"
across all formats) — one field can't answer both questions, which is
why Sprint 2.1 split Sprint 1's single `category` field into these two
separate content types. See `content/SCHEMA.md`'s Product entry for
the full rationale.

## Topics

Five topics are defined now, matching real subject areas this site
already organizes content around elsewhere (Services, the Investment
Centre, the Learning Hub):

| Slug | Label | Matches |
|---|---|---|
| `investing` | Investing | Treasury bills, the GSE, mutual funds — the same subject area as `/investment-centre/` and the "Investment Education" service |
| `personal-finance` | Personal Finance | Everyday fundamentals — spending, saving habits, debt, decision-making |
| `budgeting` | Budgeting | Planning/tracking income and spending, including irregular income — same subject as the free Budget Planner on `/resources/` |
| `business` | Business | Small business/entrepreneurship — same subject area as the "Business Financial Advisory" service |
| `mindset` | Mindset | The behavioural/psychological side of money — habits, discipline, decision-making under pressure |

No product currently references any of these — this file defines the
taxonomy ahead of the first real product, the same "schema before
data" approach used for every other content type in this project.

## Why these five, and not more

Deliberately kept small and genuinely distinct — matching this
project's five existing Services categories in spirit (Financial
Education, Investment Education, Personal Financial Coaching, Business
Financial Advisory, Financial Literacy Workshops) without copying them
exactly, since a product's topic and a service's category answer
related but not identical questions. Adding a 6th topic later (e.g.,
`retirement`, once the "Retirement basics" guide teased on `/books/`
is real) means appending one object to `index.json` — no code change,
since nothing currently consumes this file.

## File shape

- `content/topics/index.json` — the 5 topics above, as a real,
  complete array (not a placeholder).

See `content/SCHEMA.md` for the field-by-field schema (the "Topic"
entry).
