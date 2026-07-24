/**
 * Robayer WealthLab: CMS Branding Loader — Homepage Modernization Part 4,
 * extended in Version 3.0's UI/UX polish pass to fix a real dark-mode
 * defect: the logo mark's "R" is solid ink-navy (~#16233D) on a
 * transparent background, which measures ~1.1:1 contrast against the
 * dark-mode header (~#10161F) — effectively invisible. See
 * assets/branding/logo/logo-mark-dark.png, a pixel-level recolor (navy
 * → warm cream, green/gold untouched) generated from the source mark.
 *
 * Two independent layers, in priority order:
 *   1. Static dark-mode fallback (this file, zero network dependency):
 *      whenever <html data-theme="dark">, swap to logo-mark-dark.png.
 *      Runs immediately on `partials:loaded`, before any fetch, so a
 *      dark-mode visitor never sees the broken light logo even for a
 *      moment, and it works even if the API call below fails entirely.
 *   2. CMS override (unchanged behavior): if GET /api/branding returns
 *      admin-assigned primary/dark logos, those win over both the
 *      static default and the static dark fallback — an admin can still
 *      replace either logo from /admin/branding/ with no code change.
 *
 * Also handles the favicon swap from Part 4, unchanged. If the fetch
 * fails or nothing has been assigned, every element keeps whatever the
 * static layer already resolved: this script only ever upgrades what's
 * there, never removes it, so a slow/failed API call is a silent no-op
 * rather than a broken header.
 *
 * The header partial's logo is decorative (the "Robayer WealthLab"
 * wordmark text next to it already carries the accessible name), so an
 * unset alt text on an assigned Media Library asset falls back to ""
 * rather than leaving the attribute untouched.
 */

const STATIC_LOGO_LIGHT = '/assets/branding/logo/logo-mark.png';
const STATIC_LOGO_DARK = '/assets/branding/logo/logo-mark-dark.png';

function isDarkTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

/** header.html and footer.html both use the .nav__logo-mark class on their own <img>, so this must update every match — a single querySelector() here was the footer logo's dark-mode bug: only the header's (first-match) logo ever got swapped, and the footer silently kept the light-mode file regardless of theme. */
function applyLogoSrc(src, altText) {
  if (!src) return;
  document.querySelectorAll('.nav__logo-mark').forEach((img) => {
    img.src = src;
    if (altText !== undefined) img.alt = altText || '';
  });
}

function applyLogoAsset(asset) {
  if (!asset) return;
  applyLogoSrc(asset.url, asset.altText);
  if (asset.width && asset.height) {
    document.querySelectorAll('.nav__logo-mark').forEach((img) => {
      img.width = asset.width;
      img.height = asset.height;
    });
  }
}

function applyFavicon(asset) {
  if (!asset) return;
  document.querySelectorAll('link[rel="icon"]').forEach((link) => {
    link.href = asset.url;
  });
  const appleTouch = document.querySelector('link[rel="apple-touch-icon"]');
  if (appleTouch) appleTouch.href = asset.url;
}

/** Layer 1 — static, no network dependency. Keeps `cmsBranding` in scope so a later theme toggle re-checks the CMS assignment before falling back to the static asset. */
function initStaticThemeLogo() {
  let cmsBranding = null;

  function refresh() {
    if (isDarkTheme()) {
      if (cmsBranding && cmsBranding.dark) {
        applyLogoAsset(cmsBranding.dark);
      } else {
        applyLogoSrc(STATIC_LOGO_DARK);
      }
    } else if (cmsBranding && cmsBranding.primary) {
      applyLogoAsset(cmsBranding.primary);
    } else {
      applyLogoSrc(STATIC_LOGO_LIGHT);
    }
  }

  refresh();
  new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  return { setBranding: (branding) => { cmsBranding = branding; refresh(); } };
}

async function initBranding() {
  const themeLogo = initStaticThemeLogo();

  let branding;
  try {
    const response = await fetch('/api/branding');
    const body = await response.json();
    if (!response.ok || !body.success) return;
    branding = body.data;
  } catch {
    return;
  }

  themeLogo.setBranding(branding);
  applyFavicon(branding.favicon);
}

document.addEventListener('partials:loaded', initBranding);
