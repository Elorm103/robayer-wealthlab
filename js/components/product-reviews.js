/**
 * Robayer WealthLab: Product Reviews Component — Version 3.2 Milestone
 * M4 (Reviews & Coupons).
 *
 * The approved-reviews list and aggregate rating are server-rendered
 * directly into the product page by backend/routes/books.ts (see
 * reviewService.listPublicReviews() — no reviewer identity exposed).
 * This file only handles the one part that genuinely needs client-side
 * state: the "write a review" widget, which depends on the visitor's
 * own customer-session cookie — something the otherwise fully public
 * product page doesn't check server-side.
 *
 * Deliberately self-contained rather than depending on
 * js/components/dashboard-auth.js: that helper's requireSession()
 * redirects to sign-in on a missing session, which is correct for
 * /dashboard/* pages (always customer-only) but wrong here — a product
 * page must stay fully browsable for a signed-out visitor, with the
 * review form simply replaced by a sign-in prompt.
 */

(function () {
  const CSRF_COOKIE_NAME = 'customer_csrf';

  function getCsrfToken() {
    const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE_NAME}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  /** Same unwrap-envelope-or-throw contract as CustomerDashboard.customerFetch() — see that file's header comment. */
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
      throw new Error('Could not reach the server. Please check your connection and try again.');
    }

    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !body.success) {
      const error = new Error((body && body.error && body.error.message) || 'Something went wrong. Please try again.');
      error.code = body && body.error && body.error.code;
      throw error;
    }
    return body.data;
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function statusNote(status) {
    if (status === 'pending') return '<p class="text-secondary text-small mb-0">Your review is awaiting moderation. You can still edit it below.</p>';
    if (status === 'rejected') return '<p class="text-secondary text-small mb-0">Your previous review was not approved. Editing it below will resubmit it for moderation.</p>';
    return '<p class="text-secondary text-small mb-0">You already reviewed this guide. Editing below will resubmit it for moderation.</p>';
  }

  /** Version 3.5.3 (Phase 6) - a real, scoped delete action (DELETE /api/customer/reviews/:id, customer-owned-row only server-side) where none existed before. Confirmation is an inline "Delete this review? / Yes, delete / Cancel" swap, never window.confirm() - same no-native-dialogs rule this milestone applies to the download flow. */
  function renderDeleteConfirm(root, productSlug, existing) {
    root.innerHTML =
      '<div class="stack gap-2" style="max-width:480px;">' +
      '<p class="mb-0">Delete this review? This can\'t be undone.</p>' +
      '<p class="alert alert--error mt-0" data-review-error hidden role="alert"></p>' +
      '<div class="cluster gap-2">' +
      '<button type="button" class="btn btn--secondary" data-confirm-delete>Yes, delete</button>' +
      '<button type="button" class="btn btn--secondary" data-cancel-delete>Cancel</button>' +
      '</div>' +
      '</div>';

    root.querySelector('[data-cancel-delete]').addEventListener('click', () => renderForm(root, productSlug, existing));
    root.querySelector('[data-confirm-delete]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const errorEl = root.querySelector('[data-review-error]');
      button.disabled = true;
      try {
        await customerFetch('/api/customer/reviews/' + encodeURIComponent(existing.id), { method: 'DELETE' });
        root.innerHTML = '<p class="alert alert--success">Your review has been deleted.</p>';
      } catch (error) {
        errorEl.textContent = error.message || 'Something went wrong. Please try again.';
        errorEl.hidden = false;
        button.disabled = false;
      }
    });
  }

  function renderForm(root, productSlug, existing) {
    const isEdit = !!existing;
    root.innerHTML =
      '<form data-review-form class="stack gap-3" style="max-width:480px;">' +
      (isEdit ? statusNote(existing.status) : '') +
      '<div class="field">' +
      '<label class="field__label" for="review-rating">Your rating</label>' +
      '<select id="review-rating" name="rating" class="field__input">' +
      [5, 4, 3, 2, 1]
        .map((n) => '<option value="' + n + '"' + (existing && existing.rating === n ? ' selected' : '') + '>' + n + ' star' + (n === 1 ? '' : 's') + '</option>')
        .join('') +
      '</select>' +
      '</div>' +
      '<div class="field">' +
      '<label class="field__label" for="review-body">Your review</label>' +
      '<textarea id="review-body" name="body" class="field__input" rows="4" maxlength="3000" required>' +
      (existing ? escapeHtml(existing.body) : '') +
      '</textarea>' +
      '</div>' +
      '<p class="alert alert--error mt-0" data-review-error hidden role="alert"></p>' +
      '<div class="cluster gap-2">' +
      '<button type="submit" class="btn btn--secondary" style="align-self:flex-start;">' +
      (isEdit ? 'Update review' : 'Submit review') +
      '</button>' +
      (isEdit ? '<button type="button" class="btn btn--secondary" data-delete-review>Delete review</button>' : '') +
      '</div>' +
      '</form>';

    const form = root.querySelector('[data-review-form]');
    const errorEl = root.querySelector('[data-review-error]');

    if (isEdit) {
      form.querySelector('[data-delete-review]').addEventListener('click', () => renderDeleteConfirm(root, productSlug, existing));
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorEl.hidden = true;
      const submitButton = form.querySelector('[type="submit"]');
      submitButton.disabled = true;

      const rating = Number(form.querySelector('#review-rating').value);
      const body = form.querySelector('#review-body').value.trim();

      try {
        await customerFetch('/api/customer/reviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productSlug, rating, body }),
        });
        root.innerHTML = '<p class="alert alert--success">Thanks — your review has been submitted and will appear once approved.</p>';
      } catch (error) {
        errorEl.textContent = error.message || 'Something went wrong. Please try again.';
        errorEl.hidden = false;
        submitButton.disabled = false;
      }
    });
  }

  async function init() {
    const root = document.querySelector('[data-product-reviews-root]');
    if (!root || root.hasAttribute('data-bound')) return;
    root.setAttribute('data-bound', 'true');

    const productSlug = root.getAttribute('data-product-slug');
    if (!productSlug) return;

    let session = null;
    try {
      session = await customerFetch('/api/customer/auth/session');
    } catch {
      // Signed out (or an expired session) — an honest sign-in prompt,
      // never a forced redirect away from this otherwise public page.
    }

    if (!session) {
      root.innerHTML =
        '<p class="text-secondary">' +
        '<a href="/checkout/sign-in/?redirect=' +
        encodeURIComponent(window.location.pathname) +
        '">Sign in</a>' +
        ' to write a review. Only customers who have purchased this guide can leave one.' +
        '</p>';
      return;
    }

    let existingReview = null;
    try {
      const own = await customerFetch('/api/customer/reviews');
      existingReview = (own.reviews || []).find((r) => r.productSlug === productSlug) || null;
    } catch {
      // Non-fatal — the form below still renders as a fresh submission.
    }

    renderForm(root, productSlug, existingReview);
  }

  document.addEventListener('partials:loaded', init);
  document.addEventListener('DOMContentLoaded', init);
})();
