/**
 * Robayer WealthLab — Buy Button Component (Version 1.2 Sprint 2.3,
 * Commerce Foundation)
 *
 * Progressive enhancement for any link/button marked [data-buy-button]
 * with a [data-product-slug]. On click: disables the button, shows a
 * loading state, POSTs only `{ productId }` to the Cloudflare Worker's
 * checkout endpoint (never price/currency/title — the Worker loads
 * those itself from the Product Platform, see
 * docs/commerce-foundation.md), then redirects the visitor to the
 * checkout URL the Worker returns. This is the one place on the site
 * that actually starts a purchase — see docs/commerce-foundation.md's
 * "Frontend" section.
 *
 * The Worker never verifies payment or grants anything from this
 * request — it only prepares a checkout session and hands back a URL
 * to redirect to (Sprint 2.4 handles what happens after the visitor
 * pays). Same progressive-enhancement, honest-failure pattern as
 * newsletter-form.js: a network failure, an unavailable product, or a
 * server error all show a friendly, retryable message in place,
 * never a dead link or a silent no-op.
 */

// Update this after deploying the Worker (backend/wrangler.jsonc) — see
// js/components/newsletter-form.js's equivalent constant.
const CHECKOUT_API_URL = 'https://robayer-wealthlab-api.robayerwealthlab.workers.dev/api/checkout/sessions';

function initBuyButtons() {
  const buttons = document.querySelectorAll('[data-buy-button]:not([data-bound])');

  buttons.forEach((button) => {
    button.setAttribute('data-bound', 'true');
    const defaultLabel = button.textContent;

    button.addEventListener('click', async (event) => {
      event.preventDefault();

      // The real Buy CTA is an <a class="btn">, matching every other
      // CTA on this site — <a> has no native `disabled` property (it's
      // silently a no-op), so "disabled" is the `.btn--disabled` class
      // (already defined in css/components.css: pointer-events: none)
      // plus this explicit guard, which also covers keyboard Enter-key
      // activation that pointer-events:none alone wouldn't block.
      if (button.classList.contains('btn--disabled')) return;

      const productSlug = button.getAttribute('data-product-slug');
      if (!productSlug) return; // Misconfigured markup — nothing to do, fail silently rather than send a request with no product.

      clearError(button);
      setLoading(button, true, defaultLabel);

      try {
        const response = await fetch(CHECKOUT_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId: productSlug }),
        });
        const result = await response.json();

        if (!response.ok || !result.success || !result.data || !result.data.checkoutUrl) {
          throw new Error((result && result.error && result.error.message) || 'Something went wrong. Please try again.');
        }

        // Deliberately left disabled/loading through the redirect —
        // re-enabling here would let a visitor double-click Buy while
        // navigation is already underway.
        window.location.href = result.data.checkoutUrl;
      } catch (error) {
        // fetch() itself throws a TypeError on a network/CORS failure —
        // its message ("Failed to fetch") is a browser-internal string,
        // never shown directly. Any other error here was already given
        // a visitor-safe message by the Worker (see
        // backend/services/commerceService.ts's CommerceError) or by
        // this file's own fallback above.
        const message = error instanceof TypeError
          ? 'Could not reach the server. Please check your connection and try again.'
          : error.message;
        showError(button, message);
        setLoading(button, false, defaultLabel);
      }
    });
  });

  function setLoading(button, isLoading, defaultLabel) {
    button.classList.toggle('btn--disabled', isLoading);
    button.setAttribute('aria-disabled', String(isLoading));
    button.setAttribute('aria-busy', String(isLoading));
    button.textContent = isLoading ? 'Processing…' : defaultLabel;
    // Stays disabled through a successful redirect (see the click
    // handler's success branch, which never calls setLoading(false));
    // only a caught failure re-enables it.
  }

  function showError(button, message) {
    clearError(button);
    const alertEl = document.createElement('p');
    alertEl.className = 'alert alert--error mt-3';
    alertEl.setAttribute('role', 'alert');
    alertEl.setAttribute('data-buy-error', 'true');
    alertEl.textContent = message || 'Something went wrong. Please try again in a moment.';
    button.insertAdjacentElement('afterend', alertEl);
  }

  function clearError(button) {
    const next = button.nextElementSibling;
    if (next && next.matches('[data-buy-error]')) {
      next.remove();
    }
  }
}

document.addEventListener('partials:loaded', initBuyButtons);
document.addEventListener('DOMContentLoaded', initBuyButtons);
