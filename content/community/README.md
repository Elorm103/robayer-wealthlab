# Community Content

## Purpose

The Community page's own written content — its roadmap ("Where we're
headed," a staged rollout using the `.toc` component) and its ground
rules ("Community principles") — currently hand-written directly into
`community/index.html`. This is distinct from `content/events/`, which
is for actual scheduled events (webinars, meetups); nothing on the site
today represents a scheduled event, only these two static content
blocks.

## Future file structure

```
content/community/
├── roadmap.json      Staged rollout entries
└── principles.json   Ground-rules list
```

`roadmap.json` roughly:

```json
[
  { "stage": "01", "title": "…", "description": "…", "status": "current" }
]
```

`principles.json` roughly:

```json
[
  { "title": "…", "description": "…" }
]
```

## How future content should be added

1. Add/edit an entry in the relevant file.
2. A future content-loader-consuming `community/index.html` would
   render both sections from these files instead of hand-written
   `.toc__item`/list markup — not the case yet.
