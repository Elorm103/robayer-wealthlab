# Calculator Content

## Purpose

Holds the structured record of each Financial Calculator's
**metadata and educational copy** — title, summary, the plain-language
explanation of what the formula does, common mistakes, FAQ, and
cross-links to related resources/services/articles. This is the same
"real content, no consumer yet" arrangement already established for
`content/services/` in Version 1.1 Sprint 1: each calculator page
renders its real content directly in its own HTML today, and this JSON
exists as a structured record ahead of a genuine future consumer.

Note: the Learning Hub (`/learn/`, Version 1.1 Sprint 5) was
originally anticipated as this file's first consumer via its
search/filter tooling. In practice, the Learning Hub shipped as fully
static HTML with zero new JavaScript — its topic-section cards
hardcode their own title/description text directly, and its documented
future-search strategy reuses `js/components/content-filters.js`'s
existing `data-category`/`data-title` attribute contract on that
static markup, not a `fetch()` of this file. Don't assume the Learning
Hub reads this JSON; it doesn't.

## What is deliberately NOT here

**No formula, and no calculation logic, lives in these files.** A
calculator's formula is executable logic, not content — it lives in
`js/components/calculator-utils.js` (the shared math, since Compound
Interest, Savings Goal, and Investment Growth all genuinely use the
same future-value-with-contributions formula family) and each
calculator's own `js/components/calculator-{slug}.js`. Putting a
formula in JSON would either duplicate it (drifting out of sync with
the real code) or require the page to `eval()` a string from JSON,
which this project has no reason to do. `formulaExplanation` below is
the plain-language *description* shown to readers, not the formula
itself.

## File shape

- `compound-interest.json`
- `savings-goal.json`
- `investment-growth.json`

See `content/SCHEMA.md` for the field-by-field schema (the
`Calculator` entry).

## Compliance note

Every calculator is educational. Results are projections based on the
numbers a reader enters — never a guarantee, never investment advice.
Every calculator page states this explicitly, matching the same
disclaimer posture already used across `content/services/` and the
Disclaimer page.
