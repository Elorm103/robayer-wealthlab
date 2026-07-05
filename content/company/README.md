# Company Content

## Purpose

Holds the company-level facts that are richer than a single string —
things like the Mission/Vision/Values content currently written
directly into `about/index.html`'s "Mission & Vision" section, and a
future team roster (Robayer WealthLab is a single-founder operation
today; this is where a future team page's data would live).

For simple, single-value facts (company name, tagline, URL), the
existing `assets/config/site.json` remains the source of truth — this
directory is for structured, multi-part content that doesn't fit a flat
key/value config file.

## Future file structure

```
content/company/
├── about.json       Mission, vision, values, timeline milestones
└── team.json        Array of Team Member objects (see content/SCHEMA.md)
```

`about.json` would look roughly like:

```json
{
  "mission": "…",
  "vision": "…",
  "values": [{ "title": "…", "description": "…" }],
  "timeline": [{ "year": "2026", "milestone": "…" }]
}
```

`team.json` would be an array of objects matching the Team Member
schema in `content/SCHEMA.md` — today that array would contain exactly
one entry (the founder), since there's no team beyond Robert Loh Kobla
yet.

## How future content should be added

1. Add or edit the relevant JSON file here, following the shape above.
2. A future page would fetch it with a small self-contained `fetch()`
   (the same pattern `js/components/founder-bio.js` already uses) and
   render it — not the case yet; today, `about/index.html` keeps this
   content written directly in its markup.
3. Keep `values`/`timeline` arrays ordered the way they should display
   — nothing here does any sorting.
