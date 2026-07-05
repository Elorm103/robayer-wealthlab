# Services Content

## Purpose

Holds the structured record of each Robayer WealthLab service — the
same facts that appear on `/services/` and `/services/{slug}/`, kept
here as one machine-readable copy per service so a future consumer
(Success Stories' `relatedServices` cross-links — see the Version
1.1/1.1.1 PRD) can read one source of truth instead of a second person
re-typing service names and slugs by hand.

**No page fetches these files yet.** The six service pages render
their real content directly in their own HTML, exactly like every
other real page on the site (Books, Blog, Resources) — matching the
project's established pattern described in `content/README.md` and
`content/founder/README.md`: write real content in HTML first, only
wire up a `fetch()` consumer once a second real, justified use exists.

Note: both the Consultation Module (`/consultation/`, Version 1.1
Sprint 3) and the Financial Goal Planner (`/goal-planner/`, Sprint 4)
were originally expected to be this file's first consumer — the
Consultation Module via a service-select dropdown, the Goal Planner
via its per-goal `relatedServices` recommendations. In practice, both
turned out not to need it: the consultation category `<select>` is
hardcoded directly in that page's HTML (six options plus "Not sure"),
and `js/components/goal-planner.js` holds its own small hardcoded
slug-to-title/href lookup table — in both cases a `fetch()` of six
records wasn't justified when the same six facts already exist as
static markup elsewhere. This file remains ready for a genuine future
consumer (Success Stories) rather than being deleted, since that need
is still real per the PRD — but don't assume the Consultation Module
or the Goal Planner reads it; neither does.

## File shape

One file per service, named after its URL slug:

- `financial-education.json`
- `investment-education.json`
- `personal-financial-coaching.json`
- `business-financial-advisory.json`
- `retirement-planning-guidance.json`
- `financial-literacy-workshops.json`

See `content/SCHEMA.md` for the field-by-field schema (the `Service`
entry).

## Pricing

Every file includes a `pricing` object with `amount: null` and
`display: "Contact for pricing"`. This is a deliberate placeholder,
not a gap to fill in quietly later — Robayer WealthLab does not publish
service pricing today, and no page, card, or JSON-LD block anywhere in
this sprint states or implies a price. When real pricing exists, only
this field changes; no template or page needs editing.

## Compliance note

Every service is educational and coaching in nature. None of this
content — nor any future consumer of it — should ever imply licensed
investment, legal, tax, or accounting advice. See each service's own
`complianceNote` field, which matches the disclaimer language already
used on `/books/starting-to-invest-with-gh100/` and the Disclaimer
page, rather than inventing new legal wording.
