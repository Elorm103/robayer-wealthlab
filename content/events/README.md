# Events Content

## Purpose

Scheduled community events (webinars, meetups, live Q&As) — a content
type that doesn't exist anywhere on the site yet. This is distinct from
`content/community/`'s roadmap/principles content, which describes the
community's direction and ground rules, not calendar events.

## Future file structure

```
content/events/
└── events.json    Array of Community Event objects
```

See `content/SCHEMA.md`'s Community Event schema. One aggregate array
file — events are numerous, time-bound, and each is a small amount of
metadata (title, date, type, registration link, upcoming/past status).

## How future content should be added

1. Append a new object to the array in `events.json` for each newly
   scheduled event; update its `status` field from `"upcoming"` to
   `"past"` once it's happened.
2. A future content-loader-consuming page (most likely a new "Events"
   section added to `community/index.html`, or its own page) would
   render an events list from this array, likely split into
   upcoming/past — no such section exists yet, so nothing currently
   needs to change when this file is introduced.
