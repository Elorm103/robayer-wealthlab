# Goal Planner Content

## Purpose

Holds the structured configuration for each of the 8 goals the
Financial Goal Planner (`/goal-planner/`, Version 1.1 Sprint 4)
supports — the questions to ask, how to derive a target amount and
timeframe from the answers, and which calculator(s)/service(s)/article
to recommend. This is a genuine, live `fetch()` consumer — the second
one on the site after `content/founder/bio.json` — not the
"real content, no consumer yet" arrangement used by
`content/services/` and `content/calculators/`. The Goal Planner's own
page has no per-goal content hardcoded in its HTML; everything about a
selected goal's question flow comes from its JSON file, fetched
on demand when a visitor picks that goal.

## Why a live fetch this time

Every other content type on this site either has zero consumers
(pure documentation) or writes its real content directly in HTML with
JSON as an unconsumed structured copy. The Goal Planner is different
because the task itself requires it: 8 goals, each with a different
question set and a different way of deriving a target amount and
timeframe, driving one shared, data-driven UI. Hardcoding 8 separate
forms into `goal-planner/index.html` would duplicate the same
questions-plus-derivation logic 8 times in markup instead of once in
data — exactly the kind of duplication this project avoids. Fetching
per-goal JSON on demand (only when a visitor picks that goal, not all
8 upfront) keeps the page lightweight and keeps `js/components/goal-planner.js`
a single, generic rendering engine instead of 8 near-identical scripts.

## What is deliberately NOT here

**No formula.** `targetAmount` and `years` are declared as either
`"direct"` (read straight from one question's answer) or `"computed"`
(a named `operation` — currently `"multiply"` or `"subtract"` — applied
to two question answers). This is a tiny, closed set of structured
operations resolved by a `switch` in `goal-planner.js`, not an
arbitrary formula string requiring `eval()`. The actual monthly-savings
math is never duplicated here: every goal's suggested figure comes
from `window.RobayerCalc.requiredContribution()`, the exact function
`js/components/calculator-savings-goal.js` already uses.

**No service/calculator titles or hrefs.** `relatedServices` and
`relatedCalculators` are arrays of slugs only. `goal-planner.js` holds
a small hardcoded lookup table resolving each slug to its title and
URL — the same pattern `js/components/consultation-form.js`'s category
`<select>` already uses for the same 6 services, rather than adding a
second, redundant fetch of `content/services/*.json` per goal.

## File shape

One file per goal, named after its URL-safe slug (used only for the
content filename and internal wiring — the Goal Planner has no
per-goal sub-route; see `goal-planner/index.html`'s own note on this):

- `emergency-fund.json`
- `buy-a-car.json`
- `buy-land.json`
- `build-a-house.json`
- `childrens-education.json`
- `retirement.json`
- `first-investment.json`
- `business-capital.json`

See `content/SCHEMA.md` for the field-by-field schema (the
`Goal Planner Config` entry).

## Compliance note

The Goal Planner is an educational recommendation engine, not
artificial intelligence and not financial advice — it maps structured
answers to structured recommendations using the rules in each file
above, nothing more. Every result includes the same educational
disclaimer shown on `/goal-planner/`, and every result recommends a
consultation for guidance tailored to the visitor's actual situation.
