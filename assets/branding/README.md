# Brand Asset Management

This is the designated home for **real, final** brand assets once they
exist. It doesn't replace or move anything currently in `assets/icons/`
or `assets/images/` — those stay exactly where they are and keep working
exactly as today until a real replacement is dropped in here.

No fake/placeholder image files are included anywhere in this folder —
only documentation. Every asset category below has its own subfolder
with a README covering expected filenames, dimensions, formats,
optimization guidance, and fallback behavior for that category
specifically:

| Folder | What goes here |
|---|---|
| [`logo/`](logo/README.md) | Primary logo mark, wordmark lockup, monochrome variant |
| [`founder/`](founder/README.md) | Robert Loh Kobla's professional portrait |
| [`favicons/`](favicons/README.md) | Browser tab icon, Apple touch icon |
| [`social/`](social/README.md) | Open Graph / social-share preview image(s) |
| [`books/`](books/README.md) | Future book cover artwork |
| [`resources/`](resources/README.md) | Future resource thumbnail images |
| [`team/`](team/README.md) | Future team member photos (beyond the founder) |

## How this connects to the rest of the site

`assets/config/site.json` is the single source of truth for the *paths*
to the assets that are already live (logo, favicons, OG image) — see its
`branding` section. But not every page element that references a brand
asset can safely read that path at runtime:

**Live-wired (safe to change in one place):** anything rendered by
`js/content-inject.js` — currently the footer/header company name and
tagline, the footer social links, and the founder name/title on
`index.html`/`about/index.html`. Edit `assets/config/site.json`, reload
any page, done.

**Static per page, by design (must be hand-edited today, or handled by
a future build step):** `<title>`, meta description, Open Graph/Twitter
tags, `<link rel="icon">`, and the `Organization` JSON-LD block on every
page's `<head>`. These are deliberately **not** JS-injected: social-share
crawlers (Facebook/Twitter/LinkedIn) and favicon-fetching logic read the
raw HTML response before any JavaScript runs, so a value changed only in
`site.json` would silently not reach them — worse than the current
hardcoded state, not better. When a real asset replaces a current
placeholder:

1. Update the matching path in `assets/config/site.json`'s `branding`
   section (keeps it documented as the current canonical value).
2. Update the same path across every page's `<head>` — currently
   identical on all pages that reference it, so it's a plain
   find-and-replace of the old path for the new one.

A future improvement (not built yet — see the README's "Future Roadmap"
section) would be a small build-time script that regenerates every
page's `<head>` block from `site.json` before deploying, removing the
need for step 2 entirely. Nothing about today's setup blocks adding that
later.

## Optimization, in general

Whatever format a subfolder recommends, run it through a lossless/
near-lossless optimizer before committing:

- SVGs → [SVGO](https://github.com/svg/svgo) (strips editor metadata,
  doesn't touch visual output)
- JPGs/PNGs → `pngquant`/`oxipng` (PNG) or `mozjpeg`/`squoosh` (JPG),
  targeting the smallest file size that doesn't introduce visible
  artifacting
- Prefer WebP alongside a JPG/PNG fallback where a subfolder's README
  calls it out, since GitHub Pages serves whatever file extension you
  commit with no server-side transformation

This project has no build step, so there's no automated image
pipeline today — optimization is a manual step before committing a new
asset. See the README's "Future Roadmap" section for how a future
tool could automate this.
