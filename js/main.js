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
})();
