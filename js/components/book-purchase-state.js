/**
 * Robayer WealthLab: Book detail purchase-state (Version 3.5.1: Book
 * Detail UX Polish).
 *
 * Runs on the book detail page only ([data-buy-button] is how this
 * detects it's on one). For a signed-in customer:
 *   - if they already own this exact product (a real 'ready' purchase
 *     from GET /api/customer/purchases, matched by productSlug - see
 *     backend/services/customer/purchaseHistoryService.ts), the Buy
 *     flow is replaced with Read/Download/Review actions, reusing the
 *     exact same POST /api/purchases/:reference/downloads flow
 *     js/components/library-list.js already uses for the Customer
 *     Library - no new download mechanism.
 *   - otherwise, the required email field is replaced with a
 *     "Purchasing as <email>" confirmation, and #purchase-email's
 *     value is set to their real session email so
 *     js/components/buy-button.js needs no changes at all - it just
 *     reads whatever value is already in that field.
 *
 * A guest (no session) sees every existing default exactly as before -
 * this script does nothing for them beyond one 401 from the session
 * check, which is expected and silent, not an error.
 *
 * Deliberately does not use js/components/dashboard-auth.js's
 * CustomerDashboard helper: that helper redirects to sign-in on a
 * failed session check, which is correct for the actual dashboard
 * pages but wrong here - a guest browsing a book detail page must
 * never be redirected away from it. This file's own customerFetch()
 * mirrors that helper's request/CSRF/error-envelope handling exactly,
 * without the redirect behavior.
 */

(function () {
  const CSRF_COOKIE_NAME = 'customer_csrf';

  function getCsrfToken() {
    const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE_NAME}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function customerFetch(path, options) {
    options = options || {};
    const method = (options.method || 'GET').toUpperCase();
    const headers = Object.assign({}, options.headers);
    if (method !== 'GET' && method !== 'HEAD') {
      const csrf = getCsrfToken();
      if (csrf) headers['X-Customer-CSRF-Token'] = csrf;
    }

    let response;
    try {
      response = await fetch(path, { method, headers, body: options.body });
    } catch {
      throw new Error('Could not reach the server.');
    }

    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !body.success) {
      const error = new Error((body && body.error && body.error.message) || 'Something went wrong.');
      error.status = response.status;
      throw error;
    }
    return body.data;
  }

  function showLoggedInEmail(email) {
    document.querySelectorAll('[data-guest-email-field]').forEach((el) => {
      el.hidden = true;
      const input = el.querySelector('#purchase-email');
      // The visible field is hidden, but buy-button.js's existing logic
      // still just reads #purchase-email's value - setting it here means
      // that logic needs no changes at all for a signed-in customer.
      if (input) input.value = email;
    });
    document.querySelectorAll('[data-logged-in-email-display]').forEach((el) => {
      el.hidden = false;
      const emailEl = el.querySelector('[data-logged-in-email]');
      if (emailEl) emailEl.textContent = email;
      const notYouLink = el.querySelector('[data-logged-in-not-you]');
      if (notYouLink) {
        notYouLink.addEventListener('click', (event) => {
          event.preventDefault();
          el.hidden = true;
          document.querySelectorAll('[data-guest-email-field]').forEach((field) => {
            field.hidden = false;
            const input = field.querySelector('#purchase-email');
            if (input) {
              input.value = '';
              input.focus();
            }
          });
        });
      }
    });
  }

  function showOwnedState(purchase) {
    document.querySelectorAll('[data-purchase-default-state]').forEach((el) => {
      el.hidden = true;
    });
    document.querySelectorAll('[data-purchase-owned-state]').forEach((el) => {
      el.hidden = false;
    });

    const ebookAsset = purchase.assets.find((a) => !a.revoked) || null;
    if (!ebookAsset) return; // Owned but every asset has been revoked (e.g. a refund) - the "Go to My Library" links already shown are the honest, accurate action here.

    document.querySelectorAll('[data-owned-read-action], [data-owned-download-action]').forEach((link) => {
      link.addEventListener('click', async (event) => {
        event.preventDefault();
        const defaultLabel = link.textContent;
        link.textContent = 'Preparing…';
        try {
          const data = await customerFetch(`/api/purchases/${encodeURIComponent(purchase.purchaseReference)}/downloads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetId: ebookAsset.assetId }),
          });
          if (link.hasAttribute('data-owned-download-action')) {
            window.location.href = data.downloadUrl;
          } else {
            window.open(data.downloadUrl, '_blank', 'noopener');
          }
        } catch (error) {
          link.textContent = defaultLabel;
          window.alert(error.message || 'Could not prepare the download right now. Please try again, or use My Library.');
          return;
        }
        link.textContent = defaultLabel;
      });
    });
  }

  async function initBookPurchaseState() {
    const buyButtons = document.querySelectorAll('[data-buy-button]');
    if (buyButtons.length === 0) return; // Not a book detail page.
    const productSlug = buyButtons[0].getAttribute('data-product-slug');
    if (!productSlug) return;

    let session;
    try {
      session = await customerFetch('/api/customer/auth/session');
    } catch {
      return; // Guest - every existing default is already correct for them.
    }

    let purchasesResult;
    try {
      purchasesResult = await customerFetch('/api/customer/purchases?limit=50');
    } catch {
      purchasesResult = null; // Could not confirm ownership - fail safe to the guest-equivalent default rather than guessing.
    }

    const owned = purchasesResult ? purchasesResult.purchases.find((p) => p.productSlug === productSlug && p.status === 'ready') : null;

    if (owned) {
      showOwnedState(owned);
    } else if (session.email) {
      showLoggedInEmail(session.email);
    }
  }

  document.addEventListener('partials:loaded', initBookPurchaseState);
  document.addEventListener('DOMContentLoaded', initBookPurchaseState);
})();
