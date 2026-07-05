# Founder Content

## Status: live (Phase 17)

`bio.json` now holds the founder's real biography — the same copy
originally hand-written into `about/index.html` and `index.html`,
moved here verbatim (not rewritten). `js/components/founder-bio.js`
fetches it directly (a small self-contained `fetch()`, the same
pattern as `js/content-inject.js` — an earlier generic
`js/content-loader.js` helper module was tried first but ended up
unused by anything and was removed in the Sprint 18 audit) and
renders:

- `shortBio` into `index.html`'s "Meet the Founder" paragraph
  (`[data-founder-bio="short"]`)
- `longBio` into `about/index.html`'s founder-story `.article-body`
  (`[data-founder-bio="long"]`, one `<p>` per array entry)

The hand-written text already in both elements is the fallback — if the
fetch fails, the page keeps showing its current, correct copy
unchanged. This is the first content type in `content/` to get a real
consumer; every other subdirectory here remains scaffolding only.

Founder *name* and *title* are deliberately **not** part of this
rendering path — those stay owned by `assets/config/site.json`
(`founder.name`/`founder.title`) via `js/content-inject.js`, so each
fact has exactly one source instead of two competing ones.

## File structure

```
content/founder/
└── bio.json   name, title (reference only — see above), shortBio, longBio[], quotes[], photo
```

## How content should be updated

1. Edit the relevant field in `bio.json` — `shortBio` for the homepage
   teaser, `longBio` (an array, one entry per paragraph) for the About
   page's founder story.
2. Reload either page — no HTML edit needed, since both already read
   from this file.
3. If you rename the founder or change their title, edit
   `assets/config/site.json` instead (see the Configuration
   architecture section of the root `README.md`) — not this file.
