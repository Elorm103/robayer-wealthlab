/**
 * Robayer WealthLab: Buy Button Component (Version 1.2 Sprint 2.3,
 * Commerce Foundation; extended Version 3.0.2 Milestone M1, Customer
 * Identity & Guest Checkout; extended Version 3.2 Milestone M4,
 * Reviews & Coupons)
 *
 * Progressive enhancement for any link/button marked [data-buy-button]
 * with a [data-product-slug]. On click: disables the button, shows a
 * loading state, POSTs `{ productId, termsAccepted, licenseAccepted,
 * marketingOptIn, couponCode, email }` to the Cloudflare Worker's
 * checkout endpoint (never price/currency/title; the Worker loads those
 * itself from the Product Platform, see docs/commerce-foundation.md —
 * the discount a coupon produces is likewise always computed
 * server-side, see docs/v3.2-m4c-amendment-2-coupon-security-review.md),
 * then redirects the visitor to the checkout URL the Worker returns.
 * This is the one place on the site that actually starts a purchase;
 * see docs/commerce-foundation.md's "Frontend" section.
 *
 * `email` (Version 3.4.3 Milestone M6.3) — the one required field this
 * "zero-form checkout" now has. See this file's click handler for the
 * full root-cause explanation of why it was added.
 *
 * Milestone M1 consent capture — see
 * docs/v3.0.2-commerce-architecture-blueprint.md's ratified Checkout
 * Architecture: `termsAccepted`/`licenseAccepted` are always sent as
 * `true` — the visible "By purchasing, you agree to..." statement
 * rendered next to the button (see backend/routes/books.ts) IS the
 * consent action, deliberately not a second required checkbox click,
 * per ADR-002's zero-added-friction decision. `marketingOptIn` reads
 * the one genuinely optional, separately-rendered, unchecked-by-default
 * checkbox on the page, if present.
 *
 * Milestone M4 coupon entry — `#purchase-coupon-code` is the same
 * page-singleton pattern as the marketing checkbox: one field, read
 * regardless of which of this page's two Buy buttons is clicked. Its
 * own "Apply" button calls the public, non-mutating
 * /api/coupons/validate preview endpoint purely to show the discount
 * before checkout starts — this file never computes or trusts a
 * discount amount itself; createCheckoutSession() re-validates and
 * locks the real discount server-side independently.
 *
 * The Worker never verifies payment or grants anything from this
 * request; it only prepares a checkout session and hands back a URL
 * to redirect to (Sprint 2.4 handles what happens after the visitor
 * pays). Same progressive-enhancement, honest-failure pattern as
 * newsletter-form.js: a network failure, an unavailable product, or a
 * server error all show a friendly, retryable message in place,
 * never a dead link or a silent no-op.
 */

// Relative: see js/components/newsletter-form.js's equivalent constant.
const CHECKOUT_API_URL = '/api/checkout/sessions';
const COUPON_VALIDATE_API_URL = '/api/coupons/validate';

function formatPesewas(pesewas) {
  const symbol = 'GH₵';
  const rounded = Math.round(pesewas) / 100;
  const withSeparators = Math.abs(rounded).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return symbol + withSeparators;
}

function couponReasonMessage(reason) {
  const messages = {
    not_found: "We couldn't find that coupon code.",
    inactive: 'This coupon is no longer active.',
    not_started: "This coupon isn't active yet.",
    expired: 'This coupon has expired.',
    product_mismatch: "This coupon doesn't apply to this guide.",
    redemption_limit_reached: 'This coupon has already been fully redeemed.',
  };
  return messages[reason] || 'This coupon could not be applied.';
}

function initCouponInput() {
  const applyButton = document.querySelector('[data-apply-coupon]:not([data-bound])');
  if (!applyButton) return;
  applyButton.setAttribute('data-bound', 'true');

  const codeInput = document.querySelector('#purchase-coupon-code');
  const feedbackEl = document.querySelector('[data-coupon-feedback]');
  const buyButton = document.querySelector('[data-buy-button]');
  if (!codeInput || !feedbackEl || !buyButton) return;

  const productSlug = buyButton.getAttribute('data-product-slug');
  const defaultButtonLabel = applyButton.textContent;

  applyButton.addEventListener('click', async () => {
    const couponCode = codeInput.value.trim();
    if (!couponCode) return;

    applyButton.disabled = true;
    applyButton.textContent = 'Checking…';
    feedbackEl.hidden = true;

    try {
      const response = await fetch(COUPON_VALIDATE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: productSlug, couponCode }),
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error((result && result.error && result.error.message) || 'Could not check this coupon right now.');
      }

      if (!result.data.valid) {
        feedbackEl.textContent = couponReasonMessage(result.data.reason);
        feedbackEl.hidden = false;
        codeInput.setAttribute('data-coupon-applied', 'false');
      } else {
        feedbackEl.textContent = `Coupon applied: -${formatPesewas(result.data.discountPesewas)}. New total: ${formatPesewas(result.data.finalAmountPesewas)}.`;
        feedbackEl.hidden = false;
        codeInput.setAttribute('data-coupon-applied', 'true');
      }
    } catch (error) {
      feedbackEl.textContent = error instanceof TypeError
        ? 'Could not reach the server. Please check your connection and try again.'
        : error.message;
      feedbackEl.hidden = false;
      codeInput.setAttribute('data-coupon-applied', 'false');
    } finally {
      applyButton.disabled = false;
      applyButton.textContent = defaultButtonLabel;
    }
  });

  // Editing the code after a preview invalidates that preview — the
  // stale "Coupon applied" message would otherwise keep showing next
  // to a code that no longer matches it. createCheckoutSession() would
  // still re-validate correctly either way; this is purely about not
  // showing the visitor a misleading preview.
  codeInput.addEventListener('input', () => {
    codeInput.removeAttribute('data-coupon-applied');
    feedbackEl.hidden = true;
  });
}

function initBuyButtons() {
  const buttons = document.querySelectorAll('[data-buy-button]:not([data-bound])');

  buttons.forEach((button) => {
    button.setAttribute('data-bound', 'true');
    const defaultLabel = button.textContent;

    button.addEventListener('click', async (event) => {
      event.preventDefault();

      // The real Buy CTA is an <a class="btn">, matching every other
      // CTA on this site; <a> has no native `disabled` property (it's
      // silently a no-op), so "disabled" is the `.btn--disabled` class
      // (already defined in css/components.css: pointer-events: none)
      // plus this explicit guard, which also covers keyboard Enter-key
      // activation that pointer-events:none alone wouldn't block.
      if (button.classList.contains('btn--disabled')) return;

      const productSlug = button.getAttribute('data-product-slug');
      if (!productSlug) return; // Misconfigured markup: nothing to do, fail silently rather than send a request with no product.

      clearError(button);
      setLoading(button, true, defaultLabel);

      // The one, page-singleton marketing checkbox, if the page rendered
      // one — a product detail page has a single product context, so
      // one shared checkbox (not one per Buy button) is the correct
      // model even though the page may have more than one Buy button
      // (hero + closing CTA — see backend/routes/books.ts).
      const marketingCheckbox = document.querySelector('#purchase-marketing-optin');
      const marketingOptIn = !!(marketingCheckbox && marketingCheckbox.checked);

      // Same page-singleton pattern (Version 3.2 Milestone M4) — the
      // coupon code field, if the page rendered one. Sent whenever the
      // visitor typed something, whether or not they clicked "Apply"
      // first: createCheckoutSession() re-validates it from scratch
      // either way, so an un-previewed code is never silently dropped.
      const couponInput = document.querySelector('#purchase-coupon-code');
      const couponCode = couponInput && couponInput.value.trim() ? couponInput.value.trim() : null;

      // Version 3.4.3 Milestone M6.3 (Production Authentication & Email
      // Recovery) — same page-singleton pattern as the marketing
      // checkbox and coupon field above. Required, unlike those two: a
      // real production purchase proved that leaving email collection
      // entirely to the payment provider's own hosted page meant zero
      // real customers were ever reachable for the mobile_money channel
      // (the dominant channel in this market) — see
      // backend/services/payments/paystackProvider.ts's updated header
      // comment for the full trace. Validated here only as an honest,
      // fast fail before a network round-trip; createCheckoutSession()
      // re-validates it server-side regardless, per this file's own
      // "never trust the client's own gating" convention.
      const emailInput = document.querySelector('#purchase-email');
      const email = emailInput ? emailInput.value.trim() : '';
      if (!emailInput || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showError(button, 'Please enter a valid email address to continue.');
        setLoading(button, false, defaultLabel);
        if (emailInput) emailInput.focus();
        return;
      }

      try {
        const response = await fetch(CHECKOUT_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productId: productSlug,
            couponCode,
            email,
            // Sending Buy at all IS the acceptance action for the
            // Terms of Service / License Agreement statement rendered
            // next to this button — see this file's own header comment.
            termsAccepted: true,
            licenseAccepted: true,
            marketingOptIn,
          }),
        });
        const result = await response.json();

        if (!response.ok || !result.success || !result.data || !result.data.checkoutUrl) {
          throw new Error((result && result.error && result.error.message) || 'Something went wrong. Please try again.');
        }

        // Deliberately left disabled/loading through the redirect;
        // re-enabling here would let a visitor double-click Buy while
        // navigation is already underway.
        window.location.href = result.data.checkoutUrl;
      } catch (error) {
        // fetch() itself throws a TypeError on a network/CORS failure;
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
document.addEventListener('partials:loaded', initCouponInput);
document.addEventListener('DOMContentLoaded', initCouponInput);
