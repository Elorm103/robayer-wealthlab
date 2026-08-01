/**
 * Robayer WealthLab: Book detail purchase-state (Version 3.5.3:
 * Customer Experience Separation).
 *
 * The book detail page is server-rendered in Sales Mode by default
 * ([data-sales-mode] visible, [data-owner-mode] hidden — see
 * backend/routes/books.ts). This file is the ONLY thing that ever
 * flips it to Owner Mode, and it does so exactly once, atomically: it
 * never shows both modes at once, and it never guesses - Owner Mode is
 * only revealed after a real 'ready' purchase is confirmed via
 * GET /api/customer/purchases (the same ownership signal this page has
 * trusted since V3.5.1, unchanged - see docs/v3.5.3-ownership-architecture-report.md
 * for the full traced lifecycle).
 *
 * A guest (no session) sees the default, server-rendered Sales Mode
 * exactly as shipped - this script does nothing for them beyond one
 * 401 from the session check, which is expected and silent, not an
 * error. A signed-in customer who does NOT own this specific product
 * stays in Sales Mode too, just with the email field replaced by a
 * "Purchasing as <email>" confirmation (unchanged from V3.5.1).
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
      error.code = body && body.error && body.error.code;
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

  function formatPurchaseDate(isoDate) {
    try {
      return new Date(isoDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return isoDate;
    }
  }

  /** A single, page-singleton inline status line - the one place any Owner Mode action (download, read, review) reports what's happening. Never a browser alert() dialog, per this milestone's own explicit rule. */
  function setDownloadStatus(message, tone) {
    // Reuses this codebase's existing .alert/.alert--* classes rather
    // than a new color system - 'notice' maps to the existing warning
    // treatment (the download-limit-reached case is a heads-up, not a
    // failure), 'error' to the existing error treatment.
    const ALERT_CLASS = { error: 'alert--error', notice: 'alert--warning' };
    document.querySelectorAll('[data-download-status]').forEach((el) => {
      el.classList.remove('alert', 'alert--error', 'alert--warning', 'alert--info');
      if (!message) {
        el.hidden = true;
        el.textContent = '';
        return;
      }
      el.hidden = false;
      el.textContent = message;
      el.classList.add('alert', ALERT_CLASS[tone] || 'alert--info');
    });
  }

  /**
   * Reveals Owner Mode and hides Sales Mode - the one and only place
   * this page ever does that switch, so there is exactly one code path
   * to audit for "are both modes ever shown together." Also fills in
   * the purchase summary (date/reference) Sales Mode never had reason
   * to know.
   */
  function enterOwnerMode(purchase) {
    document.querySelectorAll('[data-sales-mode]').forEach((el) => {
      el.hidden = true;
    });
    document.querySelectorAll('[data-owner-mode]').forEach((el) => {
      el.hidden = false;
    });

    document.querySelectorAll('[data-owner-purchased-date]').forEach((el) => {
      el.textContent = formatPurchaseDate(purchase.createdAt);
    });
    document.querySelectorAll('[data-owner-reference]').forEach((el) => {
      el.textContent = purchase.purchaseReference;
    });

    wireOwnedActions(purchase);
  }

  /**
   * Version 3.5.3 (Download Flow Verification) - the download bug
   * traced this milestone was never a broken endpoint: it's a real,
   * already-enforced per-purchase download limit
   * (services/entitlementService.ts's checkEntitlement(), unchanged),
   * and the previous UI had no idea that limit existed until the
   * moment it silently hit it, then showed a browser alert() with a
   * generic message. GET /api/customer/purchases already returns each
   * asset's own downloadsUsed/maxDownloads (services/fulfilmentService.ts's
   * resolveAssetsWithDeliveryInfo(), unchanged) - this function is the
   * first thing in this codebase to actually read those two fields and
   * show the honest state up front, before a click can ever fail
   * confusingly.
   *
   * "Read eBook" and "Download PDF" deliberately still share the same
   * underlying entitlement/download-permission call (existing
   * architecture, preserved rather than forked into two systems) - so
   * they also deliberately share the same remaining-downloads count.
   * This is documented plainly in docs/v3.5.3-ownership-architecture-report.md
   * rather than silently hidden.
   */
  function wireOwnedActions(purchase) {
    const ebookAsset = purchase.assets.find((a) => !a.revoked) || null;
    const readLink = document.querySelector('[data-owned-read-action]');
    const downloadLink = document.querySelector('[data-owned-download-action]');

    if (!ebookAsset) {
      // Owned but every asset has been revoked (e.g. a refund) - hide
      // the actions this customer genuinely cannot use rather than
      // offering a button that can only ever fail.
      [readLink, downloadLink].forEach((link) => {
        if (link) link.hidden = true;
      });
      setDownloadStatus("This purchase's files are no longer available. Contact us if you think this is a mistake.", 'error');
      return;
    }

    const limitReached = ebookAsset.maxDownloads !== null && ebookAsset.downloadsUsed >= ebookAsset.maxDownloads;
    if (limitReached) {
      [readLink, downloadLink].forEach((link) => {
        if (!link) return;
        link.setAttribute('aria-disabled', 'true');
        link.classList.add('btn--disabled');
      });
      setDownloadStatus("You've used all " + ebookAsset.maxDownloads + ' downloads included with this purchase. Contact us if you need another copy.', 'notice');
    }

    [readLink, downloadLink].forEach((link) => {
      if (!link) return;
      link.addEventListener('click', async (event) => {
        event.preventDefault();
        if (link.getAttribute('aria-disabled') === 'true') return;

        const isDownload = link.hasAttribute('data-owned-download-action');
        const defaultLabel = link.textContent;
        link.textContent = isDownload ? 'Downloading…' : 'Opening…';
        link.setAttribute('aria-busy', 'true');
        setDownloadStatus(null);

        try {
          const data = await customerFetch(`/api/purchases/${encodeURIComponent(purchase.purchaseReference)}/downloads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetId: ebookAsset.assetId }),
          });
          if (isDownload) {
            window.location.href = data.downloadUrl;
          } else {
            window.open(data.downloadUrl, '_blank', 'noopener');
          }
          // A successful download-permission grant consumes one use -
          // reflect that immediately rather than waiting for a reload.
          ebookAsset.downloadsUsed += 1;
          if (ebookAsset.maxDownloads !== null && ebookAsset.downloadsUsed >= ebookAsset.maxDownloads) {
            [readLink, downloadLink].forEach((l) => {
              if (l) {
                l.setAttribute('aria-disabled', 'true');
                l.classList.add('btn--disabled-look');
              }
            });
            setDownloadStatus("You've used all " + ebookAsset.maxDownloads + ' downloads included with this purchase. Contact us if you need another copy.', 'notice');
          }
        } catch (error) {
          // Never a browser alert() - an inline, honest message next to
          // the actions themselves, distinguishing the one case this
          // milestone actually found in production (a real, already-
          // exhausted download limit) from every other failure.
          const message =
            error.code === 'DOWNLOAD_NOT_AVAILABLE'
              ? "This download isn't available right now. If you've used all your downloads for this file, contact us for another copy."
              : error.message || 'Could not prepare the download right now. Please try again, or use My Library.';
          setDownloadStatus(message, 'error');
        } finally {
          link.textContent = defaultLabel;
          link.removeAttribute('aria-busy');
        }
      });
    });
  }

  /** Version 3.5.3 (Phase 6) - "Leave a Review" becomes "Edit Review" the moment this customer already has one for this exact product, so Owner Mode never invites a review that would just be rejected as a duplicate (the backend already upserts by (product, customer), but the label should say so up front rather than surprise the customer after they submit). */
  async function syncReviewActionLabel(productSlug) {
    const reviewLink = document.querySelector('[data-owned-review-action]');
    if (!reviewLink) return;
    try {
      const data = await customerFetch('/api/customer/reviews');
      const existing = (data.reviews || []).find((r) => r.productSlug === productSlug);
      if (existing) reviewLink.textContent = 'Edit Review';
    } catch {
      // Non-fatal - the link stays "Leave a Review", and
      // js/components/product-reviews.js's own review section still
      // correctly detects and pre-fills an existing review either way.
    }
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
      return; // Guest - the server-rendered Sales Mode default is already correct for them.
    }

    let purchasesResult;
    try {
      purchasesResult = await customerFetch('/api/customer/purchases?limit=50');
    } catch {
      purchasesResult = null; // Could not confirm ownership - fail safe to Sales Mode rather than guessing.
    }

    const owned = purchasesResult ? purchasesResult.purchases.find((p) => p.productSlug === productSlug && p.status === 'ready') : null;

    if (owned) {
      enterOwnerMode(owned);
      syncReviewActionLabel(productSlug);
    } else if (session.email) {
      showLoggedInEmail(session.email);
    }
  }

  document.addEventListener('partials:loaded', initBookPurchaseState);
  document.addEventListener('DOMContentLoaded', initBookPurchaseState);
})();
