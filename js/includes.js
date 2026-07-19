/**
 * Robayer WealthLab: Partial Include System
 *
 * Loads shared HTML partials (header, footer) into any element carrying
 * a [data-include] attribute, e.g.:
 *   <div data-include="/partials/header.html"></div>
 *
 * This keeps navigation and footer markup in exactly one place, so every
 * future page stays in sync automatically when either partial changes.
 *
 * Note: this relies on fetch(), which requires the site to be served over
 * http(s); it will not work when opening an HTML file directly from disk
 * (file://). Run a local static server during development (see README),
 * and it works natively once deployed to GitHub Pages.
 *
 * Dispatches a `partials:loaded` event on `document` once every include
 * on the page has finished, so other scripts (e.g. nav.js) can safely
 * attach behavior to the injected markup.
 */

(function () {
  async function loadInclude(el) {
    const path = el.getAttribute('data-include');
    if (!path) return;

    try {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to load partial: ${path} (${response.status})`);
      }
      const html = await response.text();
      el.innerHTML = html;
    } catch (error) {
      console.error(error);
      el.innerHTML = '';
    }
  }

  async function loadAllIncludes() {
    const includeEls = Array.from(document.querySelectorAll('[data-include]'));
    await Promise.all(includeEls.map(loadInclude));
    document.dispatchEvent(new CustomEvent('partials:loaded'));
  }

  document.addEventListener('DOMContentLoaded', loadAllIncludes);
})();
