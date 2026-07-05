/**
 * Robayer WealthLab — Centralized Content Injection
 *
 * Fetches assets/config/site.json (the single source of truth for company/
 * founder/contact/social facts — see assets/config/site.json and
 * assets/branding/README.md) and populates any element on the page marked:
 *   [data-content="dot.path"]      — sets the element's textContent
 *   [data-content-href="dot.path"] — sets the element's href attribute
 *
 * The HTML already contains the correct current values as static fallback
 * text/hrefs, so if the fetch fails for any reason (offline, served over
 * file:// instead of http(s), a bad path) this simply does nothing and the
 * page keeps showing whatever is already there — same fail-safe philosophy
 * as js/includes.js.
 *
 * Runs on `partials:loaded` (dispatched by js/includes.js) rather than
 * DOMContentLoaded, since some [data-content] elements live inside the
 * header/footer partials and don't exist in the DOM until those load —
 * and partials:loaded always fires after DOMContentLoaded, so page-native
 * [data-content] elements are covered too.
 */

(function () {
  function resolvePath(config, path) {
    return path.split('.').reduce((value, key) => {
      return value && typeof value === 'object' ? value[key] : undefined;
    }, config);
  }

  function applyContent(config) {
    document.querySelectorAll('[data-content]').forEach((el) => {
      const value = resolvePath(config, el.getAttribute('data-content'));
      if (typeof value === 'string') el.textContent = value;
    });

    document.querySelectorAll('[data-content-href]').forEach((el) => {
      const value = resolvePath(config, el.getAttribute('data-content-href'));
      if (typeof value === 'string') el.setAttribute('href', value);
    });
  }

  async function initContentInject() {
    try {
      const response = await fetch('/assets/config/site.json');
      if (!response.ok) return;
      const config = await response.json();
      applyContent(config);
    } catch (error) {
      console.error(error);
    }
  }

  document.addEventListener('partials:loaded', initContentInject);
})();
