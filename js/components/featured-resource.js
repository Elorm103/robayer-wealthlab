/**
 * Robayer WealthLab: Featured Resource banner (Version 3.5.1: Homepage
 * CMS Completion & Product Consistency Audit).
 *
 * Fills the homepage's "Featured Resource" banner ([data-featured-resource])
 * from GET /api/resources/featured — the real, already-published Resource
 * ("The 7 Money Mistakes That Keep Many Ghanaians Broke", id 2) that
 * this exact banner's copy was, until this milestone, a hand-typed
 * duplicate of. Same fetch-fill-fallback shape as
 * js/components/product-loader.js's initFeatureBanners() (see that
 * file for the identical [data-feature-*] convention this mirrors for
 * a different content type) and js/content-inject.js's initHeroContent():
 * if the fetch fails, finds nothing featured, or JS never runs, the
 * static HTML already in the page is the honest fallback — never a
 * blank section.
 */

(function () {
  function initFeaturedResource() {
    const banner = document.querySelector('[data-featured-resource]:not([data-bound])');
    if (!banner) return;
    banner.setAttribute('data-bound', 'true');

    fetch('/api/resources/featured')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const resource = body && body.success === true ? body.data.resource : null;
        if (!resource) return; // Leave the existing static content as-is - no featured resource is a real, valid state, not an error.

        const titleEl = banner.querySelector('[data-featured-resource-title]');
        const descriptionEl = banner.querySelector('[data-featured-resource-description]');
        const ctaEl = banner.querySelector('[data-featured-resource-cta]');
        const coverImgEl = banner.querySelector('[data-featured-resource-cover-img]');

        if (titleEl) titleEl.textContent = resource.title;
        if (descriptionEl && resource.shortDescription) descriptionEl.textContent = resource.shortDescription;
        if (ctaEl) ctaEl.setAttribute('href', resource.destinationUrl);

        // Real uploaded cover takes over from the flat placeholder color
        // block when the resource has one — this resource has none
        // today, so the existing placeholder correctly stays visible;
        // this is the same graceful "no cover yet" degradation already
        // established for products (see product-loader.js's own
        // coverImgEl handling).
        if (coverImgEl && resource.coverImage) {
          coverImgEl.src = resource.coverImage;
          coverImgEl.hidden = false;
        }
      })
      .catch(() => {}); // Network/parse failure - leave the static fallback content exactly as it already is.
  }

  document.addEventListener('partials:loaded', initFeaturedResource);
  document.addEventListener('DOMContentLoaded', initFeaturedResource);
})();
