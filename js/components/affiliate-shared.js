/**
 * Robayer WealthLab: Affiliate Shared Helpers. The one canonical
 * referral-link construction mechanism (buildUrl) and the one
 * copy-to-clipboard micro-interaction, shared between
 * affiliate/links/index.html (affiliate-links.js) and
 * affiliate/resources/index.html (affiliate-resources.js) so neither
 * page reimplements its own version. Load this script before either
 * page-specific component.
 */

window.RobayerAffiliate = (function () {
  /** Builds a referral URL for the given affiliate code and destination ('homepage' or a product slug). Never accepts or falls back to any hardcoded code: the caller always supplies the current viewer's own affiliateCode from GET /api/customer/affiliates/me. */
  function buildUrl(code, destination) {
    const origin = window.location.origin;
    const path = destination === 'homepage' ? '/' : `/books/${destination}/`;
    return `${origin}${path}?ref=${encodeURIComponent(code)}`;
  }

  function copyToClipboard(text, button) {
    const defaultLabel = button.textContent;
    const done = () => {
      button.textContent = 'Copied!';
      window.setTimeout(() => {
        button.textContent = defaultLabel;
      }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(done);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } catch {
        // no-op: nothing else reasonable to do without Clipboard API support
      }
      document.body.removeChild(textarea);
      done();
    }
  }

  return { buildUrl, copyToClipboard };
})();
