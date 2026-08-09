/**
 * Robayer WealthLab: Main entry script
 *
 * Site-wide behavior that isn't specific to a single component.
 * Component-specific scripts (nav.js, and future ones for calculators,
 * testimonial carousels, etc.) live in js/components/ and self-initialize
 * by listening for `partials:loaded` or `DOMContentLoaded` as appropriate.
 */

(function () {
  // Footer copyright year: keeps the footer partial accurate with zero
  // maintenance, since it's injected on every page.
  function setCurrentYear() {
    const yearEl = document.getElementById('current-year');
    if (yearEl) {
      yearEl.textContent = new Date().getFullYear();
    }
  }

  document.addEventListener('partials:loaded', setCurrentYear);

  /**
   * Version 3.3 Milestone M5C (Activation, Analytics and Customer
   * Reconciliation) — Cloudflare Web Analytics beacon. See
   * docs/v3.3-m5c-analytics-architecture.md's Known Limitations: the
   * admin dashboard has always linked out to Cloudflare Web Analytics
   * (js/components/admin/admin-analytics.js), but no page on this site
   * ever actually loaded the tracking beacon, so that dashboard link
   * pointed at an empty report. This is loaded from js/main.js — the
   * one script tag every page on the site already includes — rather
   * than edited into every individual page, since this codebase has no
   * build step to do that for us.
   *
   * `assets/config/site.json`'s analytics.webAnalyticsToken is null
   * until a real site-tag is generated once, manually, in the
   * Cloudflare dashboard (there is no API for this). Until then this
   * is a genuine no-op — never a fabricated token — matching this
   * project's own "never faked here" data-source principle
   * (docs/v2-analytics-spec.md).
   */
  async function loadCloudflareWebAnalytics() {
    let token;
    try {
      const response = await fetch('/assets/config/site.json');
      const config = await response.json();
      token = config && config.analytics && config.analytics.webAnalyticsToken;
    } catch {
      return;
    }
    if (!token || typeof token !== 'string') return;

    const script = document.createElement('script');
    script.defer = true;
    script.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    script.setAttribute('data-cf-beacon', JSON.stringify({ token }));
    document.body.appendChild(script);
  }

  document.addEventListener('DOMContentLoaded', loadCloudflareWebAnalytics);

  /**
   * Version 5.0 (Customer Acquisition Phase 1) — Meta Pixel + the
   * site's extensible conversion-event layer. Loaded from js/main.js
   * for the exact same reason loadCloudflareWebAnalytics() above is:
   * this is the one script tag every real customer-facing page on the
   * site already includes (admin/* pages deliberately do not, and
   * correctly shouldn't carry an ad-tracking pixel), so this is the
   * genuine "install once, everywhere, with no build step" mechanism
   * this codebase has — not a hack, the same precedent already
   * established and documented above.
   *
   * `assets/config/site.json`'s analytics.meta.pixelId is the real,
   * non-secret Pixel ID (unlike webAnalyticsToken, this one is already
   * set — no manual dashboard step was needed). If it's ever unset,
   * this is a genuine no-op, never a fabricated placeholder, matching
   * this project's own "never fake a data source" principle.
   */
  async function loadMetaPixel() {
    let pixelId;
    try {
      const response = await fetch('/assets/config/site.json');
      const config = await response.json();
      pixelId = config && config.analytics && config.analytics.meta && config.analytics.meta.pixelId;
    } catch {
      return;
    }
    if (!pixelId || typeof pixelId !== 'string') return;

    const script = document.createElement('script');
    script.defer = true;
    script.src = '/js/components/meta-pixel.js';
    script.setAttribute('data-pixel-id', pixelId);
    document.head.appendChild(script);
  }

  document.addEventListener('DOMContentLoaded', loadMetaPixel);
})();
