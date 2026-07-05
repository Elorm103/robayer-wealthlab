# Investment Centre Content

## Purpose

Holds the structured record of each Ghana Investment Centre topic —
the same facts that appear on `/investment-centre/` and
`/investment-centre/{slug}/`, kept here as one machine-readable copy
per topic. This is the same "real content, no consumer yet"
arrangement already established for `content/services/` (Version 1.1
Sprint 1) and `content/calculators/` (Sprint 2): each topic page
renders its real content directly in its own HTML, matching how every
content-heavy page on this site works, and this JSON exists ahead of a
genuine future consumer (a future search/filter pass, or additional
topic pages that want to reuse this exact schema without re-typing
its shape).

**No page fetches these files yet.** Don't assume otherwise — see
`content/services/README.md` and `content/calculators/README.md` for
two cases (the Consultation Module and the Financial Goal Planner)
where a similar assumption turned out to be wrong once those features
actually shipped.

## What is deliberately NOT here

**No calculators, no booking, no authentication.** The Investment
Centre is a pure educational reading experience — `relatedCalculators`
and `relatedGoals` are cross-links to the existing `/calculators/` and
`/goal-planner/` features, not new functionality of their own. See
`content/calculators/README.md` for why calculator formulas live in
`js/components/calculator-utils.js`, never duplicated in JSON.

## File shape

One file per topic, named after its URL slug:

- `treasury-bills.json`
- `government-bonds.json`
- `money-market-funds.json`
- `mutual-funds.json`
- `ghana-stock-exchange.json`
- `fixed-deposits.json`
- `ssnit-and-pension-basics.json`
- `real-estate-investing.json`
- `gold-investing.json`
- `emergency-funds.json`

See `content/SCHEMA.md` for the field-by-field schema (the
`Investment Centre Topic` entry).

## `relatedGoals` — a new cross-reference direction

Earlier content types (services, calculators) cross-link to each
other and to the Goal Planner's slugs, but nothing previously
cross-linked *into* the Goal Planner from a reading-content page.
`relatedGoals` holds Goal Planner slugs (e.g. `"first-investment"`,
`"emergency-fund"`) and renders as a link to
`/goal-planner/?goal={slug}` — the same query-param deep-link pattern
already built for the Learning Hub in Sprint 5, reused here rather
than invented fresh.

## `seo` field

Unlike `content/services/` and `content/calculators/`, this schema
includes a nested `seo` object (`title`, `metaDescription`,
`canonical`) mirroring exactly what each topic page's own `<head>`
already contains — kept here as the structured record of that same
data, not a second source of truth the page reads from live.

## Compliance note

Every topic is educational. None of this content, nor any future
consumer of it, should ever imply licensed investment, legal, tax, or
pension advice, or recommend a specific product, company, or stock.
See each topic's own `complianceNote` field.
