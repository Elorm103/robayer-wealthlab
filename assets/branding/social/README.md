# Social / Open Graph

## Status: real OG image in place (Phase 17)

`og-image.jpg` is a composed 1200×630 image — the real production logo
(`assets/branding/logo/logo-with-tagline.png`) centered on the site's
own Warm Paper (`#FAF6EF`) background, matching the site's actual
design tokens rather than a generic placeholder. Live-wired into every
page's `og:image` meta tag and `assets/config/site.json`'s
`branding.ogImage`/`seo.defaultOgImage`.

## Expected filenames

- `og-image.jpg` (in place) — 1200×630px, 54KB, logo on Warm Paper.
- `og-image-{page-slug}.jpg` — optional, per-page override (e.g.
  `og-image-books.jpg`) for a future where individual pages want a
  distinct share image instead of the sitewide default. Not used by any
  page today — every page currently points at the one shared default.

## Recommended dimensions

Exactly 1200×630px. This is the standard Open Graph size — anything
else gets cropped unpredictably by Facebook/Twitter/LinkedIn's preview
renderers, which each crop slightly differently.

## Recommended formats

JPG for photographic content, PNG if the image has flat color/text
that needs to stay crisp. Social platforms re-compress whatever you
give them anyway, so don't over-invest in format beyond "looks right
at 1200×630."

## Recommended optimization

Compress to under 300KB — most platforms have an upper size limit
before they either reject the image or compress it themselves (losing
control over the result). `mozjpeg`/`Squoosh` for JPG, `pngquant` for
PNG.

## Fallback behavior

No longer applicable — every page's `og:image` now points at the real
`og-image.jpg`. To replace it with a different composition later:

1. Drop the new file in here.
2. Update the `og:image` meta tag across every page's `<head>` —
   currently identical everywhere, so a find-and-replace of the old
   path.
3. Update `assets/config/site.json`'s `branding.ogImage` /
   `seo.defaultOgImage` to match (documentation only, same caveat as
   favicons above — meta tags aren't JS-injected).

If you introduce a per-page override image later, that's a per-page
`og:image`/`twitter:image` edit on just that page, not a sitewide
change — the sitewide default in `site.json` stays as the fallback for
every page that doesn't set its own.
