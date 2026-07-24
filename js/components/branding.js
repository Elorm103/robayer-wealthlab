/**
 * Robayer WealthLab: CMS Branding Loader — Homepage Modernization Part 4.
 *
 * Fetches GET /api/branding (backend/routes/branding.ts) and, if the
 * admin has assigned a logo/favicon through /admin/branding/, swaps the
 * header logo and the page's favicon links to match — with no code
 * change or deploy required for a logo replacement. If the fetch fails
 * or nothing has been assigned, every element keeps the static default
 * already baked into the page's HTML: this script only ever upgrades
 * what's there, never removes it, so a slow/failed API call is a silent
 * no-op rather than a broken header.
 *
 * The header partial's logo is decorative (the "Robayer WealthLab"
 * wordmark text next to it already carries the accessible name), so an
 * unset alt text on the assigned Media Library asset falls back to ""
 * rather than leaving the attribute untouched.
 *
 * Reacts live to theme changes: if a dark-mode logo is assigned, a
 * MutationObserver watches <html data-theme> (set by theme-toggle.js,
 * which fires no event of its own) and swaps the header logo the
 * instant a visitor toggles dark mode, without a page reload.
 */

function isDarkTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

function applyLogo(asset) {
  const img = document.querySelector('.nav__logo-mark');
  if (!img || !asset) return;
  img.src = asset.url;
  img.alt = asset.altText || '';
  if (asset.width && asset.height) {
    img.width = asset.width;
    img.height = asset.height;
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

async function initBranding() {
  let branding;
  try {
    const response = await fetch('/api/branding');
    const body = await response.json();
    if (!response.ok || !body.success) return;
    branding = body.data;
  } catch {
    return;
  }

  function refreshLogo() {
    const asset = isDarkTheme() && branding.dark ? branding.dark : branding.primary;
    applyLogo(asset);
  }

  refreshLogo();
  applyFavicon(branding.favicon);

  if (branding.dark) {
    new MutationObserver(refreshLogo).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
}

document.addEventListener('partials:loaded', initBranding);
